'use strict';

/**
 * Deployment preflight.
 *
 * Runs the checks that cannot be expressed as unit tests, because they concern
 * the *deployment* rather than the code:
 *
 *   1. Required secrets are present and are not placeholders.
 *   2. PUBLIC_URL is a real public origin (it is the base for the OAuth
 *      callback, every webhook address, the tracker src and every email link).
 *   3. shopify.app.toml has the keys Shopify CLI actually requires, and does
 *      not rely on sections that the CLI silently ignores.
 *   4. Every path in extension_directories exists and holds a manifest.
 *   5. Every webhook topic declared in the manifest has a real route in src/.
 *   6. At least one outbound delivery channel is configured.
 *
 * Usage:
 *   node scripts/preflight.js                      # reads .env.production
 *   node scripts/preflight.js --env .env.staging
 *   node scripts/preflight.js --strict             # notes become failures
 *
 * Exit code 0 when nothing blocking was found, 1 otherwise.
 *
 * NOTE ON TOML PARSING
 * --------------------
 * Node has no built-in TOML parser, so the manifest scan here is deliberately
 * narrow: it reads top-level `key = value` lines and `[section]` headers. That
 * is sufficient to catch the specific mistakes this file exists to catch (a
 * missing `client_id`, a stray `[posix]`, an `app_url` instead of
 * `application_url`). It is not a general TOML validator — `shopify app build`
 * remains the authority on whether the manifest is well-formed.
 */

const fs = require('node:fs');
const path = require('node:path');
const { buildReadinessReport, formatReport, classifyValue, } = require('../src/config/readiness.js',);

const ROOT = path.join(__dirname, '..',);

// ─── Argument parsing ───────────────────────────────────────────────────────

function parseArgs(argv,) {
  const out = { env: '.env.production', strict: false, };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--env' && argv[i + 1]) {
      out.env = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--strict') {
      out.strict = true;
    }
  }
  return out;
}

// ─── Minimal .env reader ────────────────────────────────────────────────────

/** Parse a .env file into a plain object. Does not mutate process.env. */
function readEnvFile(file,) {
  if (!fs.existsSync(file,)) return { found: false, vars: {}, };
  const vars = {};
  for (const line of fs.readFileSync(file, 'utf8',).split(/\r?\n/,)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#',)) continue;
    const eq = trimmed.indexOf('=',);
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq,).trim();
    let value = trimmed.slice(eq + 1,).trim();
    if (
      (value.startsWith('"',) && value.endsWith('"',) && value.length > 1) ||
      (value.startsWith('\'',) && value.endsWith('\'',) && value.length > 1)
    ) {
      value = value.slice(1, -1,);
    }
    if (key) vars[key] = value;
  }
  return { found: true, vars, };
}

// ─── Narrow manifest scan ───────────────────────────────────────────────────

/** Read top-level keys and section names from a TOML manifest. */
function scanManifest(file,) {
  if (!fs.existsSync(file,)) return { found: false, keys: {}, sections: [], text: '', };
  const text = fs.readFileSync(file, 'utf8',);
  const keys = {};
  const sections = [];
  let currentSection = null;

  for (const rawLine of text.split(/\r?\n/,)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#',)) continue;

    const sectionMatch = /^\[\[?([^\]]+)\]\]?$/.exec(line,);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      sections.push(currentSection,);
      continue;
    }

    if (currentSection === null) {
      const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line,);
      if (kv) {
        let value = kv[2].trim();
        if (value.startsWith('"',) && value.endsWith('"',) && value.length > 1) {
          value = value.slice(1, -1,);
        }
        keys[kv[1]] = value;
      }
    }
  }
  return { found: true, keys, sections, text, };
}

/**
 * Sections that are not part of the Shopify app-config schema. The CLI ignores
 * unknown keys silently, so their presence is a strong signal that someone
 * copied a config from somewhere that was never validated.
 */
const INVALID_SECTIONS = [
  'app_bridge', 'posix', 'billing', 'extensions', 'theme_extensions',
  'extensions.ui', 'extensions.theme',
];

const INVALID_TOP_LEVEL_KEYS = ['id', 'app_url', 'categories', 'privacy_url', 'redirect_url'];

// ─── Webhook route verification ─────────────────────────────────────────────

/** Collect the route paths declared in src/. */
function collectRoutes(dir,) {
  const routes = new Set();
  const walk = (d,) => {
    if (!fs.existsSync(d,)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true, },)) {
      const full = path.join(d, entry.name,);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full,);
      } else if (entry.name.endsWith('.js',)) {
        const src = fs.readFileSync(full, 'utf8',);
        const re = /(?:app|router)\.(?:get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g;
        let m;
        while ((m = re.exec(src,)) !== null) routes.add(m[1],);
      }
    }
  };
  walk(dir,);
  return routes;
}

/** Does a declared webhook `uri` correspond to a real route? */
function routeExists(uri, routes,) {
  if (routes.has(uri,)) return true;
  // Treat :param segments as wildcards in both directions.
  const pattern = new RegExp(
    `^${uri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&',).replace(/:[A-Za-z0-9_]+/g, '[^/]+',)}$`,
  );
  for (const r of routes) {
    if (pattern.test(r,)) return true;
    const rPattern = new RegExp(
      `^${r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&',).replace(/:[A-Za-z0-9_]+/g, '[^/]+',)}$`,
    );
    if (rPattern.test(uri,)) return true;
  }
  return false;
}

/** Extract `uri = "..."` values from webhook subscription blocks. */
function declaredWebhookUris(text,) {
  // Strip comments first: the manifest's own explanatory prose mentions
  // `[[webhooks.subscriptions]]`, which would otherwise parse as a real block.
  const stripped = text
    .split(/\r?\n/,)
    .filter((line,) => !line.trim().startsWith('#',))
    .join('\n',);
  const uris = [];
  const blocks = stripped.split(/\[\[webhooks\.subscriptions\]\]/,).slice(1,);
  for (const block of blocks) {
    const m = /uri\s*=\s*"([^"]+)"/.exec(block,);
    if (m) uris.push(m[1],);
  }
  return uris;
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2,),);
  const failures = [];
  const notes = [];

  console.log('Storecops deployment preflight',);
  console.log('='.repeat(60,),);
  console.log('',);

  // 1. Environment -----------------------------------------------------------
  const envFile = path.resolve(ROOT, args.env,);
  const { found, vars, } = readEnvFile(envFile,);
  console.log(`Environment: ${args.env}${found ? '' : '  (FILE NOT FOUND)'}`,);
  if (!found) {
    failures.push(`Environment file ${args.env} was not found.`,);
  }

  const report = buildReadinessReport(vars, { env: 'production', },);
  console.log(formatReport(report,),);
  console.log('',);
  for (const b of report.blocking) failures.push(b.message,);
  for (const w of report.warnings) notes.push(w.message,);

  // 2. Manifest --------------------------------------------------------------
  console.log('-'.repeat(60,),);
  console.log('shopify.app.toml',);
  const manifestPath = path.join(ROOT, 'shopify.app.toml',);
  const manifest = scanManifest(manifestPath,);

  if (!manifest.found) {
    failures.push('shopify.app.toml was not found.',);
  } else {
    const required = ['name', 'client_id', 'application_url', 'embedded'];
    for (const key of required) {
      const value = manifest.keys[key];
      if (!value) {
        failures.push(`shopify.app.toml is missing required key \`${key}\`.`,);
      } else if (key === 'client_id' && classifyValue(value,).status === 'placeholder') {
        failures.push(
          `shopify.app.toml \`client_id\` is still a placeholder ("${value}"). ` +
          'Copy the real value from the Partner Dashboard.',
        );
      } else {
        console.log(`  ok    ${key}`,);
      }
    }

    for (const bad of INVALID_TOP_LEVEL_KEYS) {
      if (Object.prototype.hasOwnProperty.call(manifest.keys, bad,)) {
        failures.push(
          `shopify.app.toml uses \`${bad}\`, which is not part of the schema. ` +
          'Shopify CLI ignores it silently.',
        );
      }
    }
    for (const section of manifest.sections) {
      if (INVALID_SECTIONS.includes(section,)) {
        failures.push(
          `shopify.app.toml contains [${section}], which is not part of the schema. ` +
          'Shopify CLI ignores it silently.',
        );
      }
    }

    // 3. Extension directories ----------------------------------------------
    const dirValue = manifest.keys.extension_directories;
    const dirs = dirValue
      ? dirValue.replace(/^\[|\]$/g, '',).split(',',).map((s,) => s.trim().replace(/^"|"$/g, ''),).filter(Boolean,)
      : ['extensions'];

    console.log('', 'Extension directories:',);
    for (const dir of dirs) {
      const abs = path.join(ROOT, dir,);
      const exists = fs.existsSync(abs,);
      const manifests = exists
        ? fs.readdirSync(abs, { withFileTypes: true, },)
          .filter((e,) => e.isDirectory(),)
          .map((e,) => path.join(abs, e.name, 'shopify.extension.toml',))
          .filter((p,) => fs.existsSync(p,),)
        : [];
      if (!exists) {
        failures.push(
          `extension_directories entry "${dir}" does not exist. ` +
          'Shopify CLI will find zero extensions.',
        );
      } else if (manifests.length === 0) {
        failures.push(`extension_directories entry "${dir}" contains no extension manifests.`,);
      } else {
        console.log(`  ok    ${dir} -> ${manifests.length} extension(s)`,);
      }
    }
  }

  // 4. Webhook routes --------------------------------------------------------
  console.log('', '-'.repeat(60,),);
  console.log('Webhook subscriptions',);
  if (manifest.found) {
    const routes = collectRoutes(path.join(ROOT, 'src',),);
    const uris = declaredWebhookUris(manifest.text,);
    if (uris.length === 0) {
      console.log('  (none declared)',);
    }
    for (const uri of uris) {
      if (routeExists(uri, routes,)) {
        console.log(`  ok    ${uri}`,);
      } else {
        failures.push(
          `Webhook uri "${uri}" has no matching route in src/. ` +
          'Shopify would POST to a dead endpoint on every event.',
        );
      }
    }
  }

  // 5. Summary ---------------------------------------------------------------
  console.log('', '='.repeat(60,),);
  if (notes.length > 0) {
    console.log(`${notes.length} warning(s):`,);
    for (const n of notes) console.log(`  [!] ${n}`,);
    console.log('',);
  }

  if (failures.length > 0) {
    console.log(`FAILED — ${failures.length} blocking issue(s):`,);
    for (const f of failures) console.log(`  [x] ${f}`,);
    process.exit(1,);
  }

  if (args.strict && notes.length > 0) {
    console.log(`FAILED (--strict) — ${notes.length} warning(s) treated as failures.`,);
    process.exit(1,);
  }

  console.log('PASSED — no blocking issues found.',);
  console.log(
    'Reminder: this cannot verify that the app is reachable at PUBLIC_URL, nor that\n' +
    'the extensions render inside a real Shopify admin. Confirm both on a dev store.',
  );
  process.exit(0,);
}

main();
