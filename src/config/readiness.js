'use strict';

/**
 * Production readiness checks.
 *
 * WHY THIS EXISTS
 * ---------------
 * This app previously booted happily in production while:
 *   - PUBLIC_URL pointed at an unreplaced hosting placeholder
 *     (`https://your-app.up.railway.app`), so every OAuth callback, webhook
 *     delivery address, tracker src and email CTA button pointed at a dead host;
 *   - no outbound email or WhatsApp credential existed, so every send failed
 *     while the app reported success and the UI looked healthy.
 *
 * Both classes of problem are invisible at runtime and only surface when a real
 * merchant installs. They are configuration faults, not code faults, so no test
 * suite catches them. This module turns them into loud, specific startup errors.
 *
 * Design notes:
 *   - Pure functions over an env object, so they are unit-testable without
 *     mutating process.env or exiting.
 *   - Never throws. Returns findings; the caller decides how to react.
 *   - Test environments are exempt; the caller checks that.
 */

// ─── Placeholder detection ──────────────────────────────────────────────────

/**
 * Patterns that indicate a value was never filled in.
 *
 * Ordered most-specific first so the reported label is the most useful one.
 * Each entry is [label, regex]. Matching is case-insensitive.
 */
const PLACEHOLDER_PATTERNS = [
  ['Railway placeholder host', /your-app\.up\.railway\.app/i,],
  ['Railway placeholder host', /your-(?:app|project)\.(?:up\.)?railway\.app/i,],
  ['Heroku placeholder host', /your-(?:app|project)\.herokuapp\.com/i,],
  ['Vercel placeholder host', /your-(?:app|project)\.vercel\.app/i,],
  // Needs to match both "https://example.com/x" and "example.com" — so allow
  // a scheme separator, a bare dot, or start-of-string before the host.
  ['example.com placeholder', /(?:^|\.|\/\/)example\.(?:com|org|net)(?:$|[/:?#])/i,],
  ['generic placeholder word', /\b(?:your[-_]?(?:app|domain|site|url|host)|my[-_]?app)\b/i,],
  ['generic placeholder word', /\b(?:change[-_]?me|replace[-_]?me|placeholder|todo|fixme|tbd)\b/i,],
  // `REPLACE_WITH_PARTNER_DASHBOARD_CLIENT_ID` style. A trailing \b cannot be
  // used here because `_` is a word character, so `with_` has no boundary.
  ['generic placeholder word', /\breplace[_-](?:with|me|this|by)/i,],
  ['generic placeholder word', /\b(?:insert|put|enter|set)[_-](?:your|the|a)[_-]/i,],
  ['generic placeholder word', /\byour[_-][a-z0-9]/i,],
  ['redacted marker', /\bxxx+\b/i,],
  ['angle-bracket template', /<[^>]+>/,],
];

/** Hosts that are only valid for local development. */
const LOCAL_PATTERNS = [
  ['localhost', /\blocalhost\b/i,],
  ['loopback address', /\b127\.0\.0\.1\b/,],
  ['IPv6 loopback', /\[?::1\]?/,],
  ['unspecified address', /\b0\.0\.0\.0\b/,],
];

/**
 * Classify a single configuration value.
 *
 * @param {string} value
 * @returns {{ status: 'empty'|'placeholder'|'local'|'ok', label?: string }}
 */
function classifyValue(value,) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === '') return { status: 'empty', };

  for (const [label, re,] of PLACEHOLDER_PATTERNS) {
    if (re.test(raw,)) return { status: 'placeholder', label, };
  }
  for (const [label, re,] of LOCAL_PATTERNS) {
    if (re.test(raw,)) return { status: 'local', label, };
  }
  return { status: 'ok', };
}

// ─── Integration capability map ─────────────────────────────────────────────

/**
 * Each integration declares the env keys it needs and what breaks without them.
 *
 * `anyOf` groups are alternatives (email can go via Resend OR SMTP).
 * `providerKey` lets us distinguish "deliberately disabled in dev" from
 * "silently broken in production".
 */
const INTEGRATIONS = [
  {
    name: 'Shopify',
    providerKey: null,
    anyOf: [
      ['SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET',],
    ],
    impact:
      'the embedded admin cannot authenticate (session-token verification fails closed)',
  },
  {
    name: 'Email',
    providerKey: 'EMAIL_PROVIDER',
    anyOf: [
      ['RESEND_API_KEY',],
      ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS',],
    ],
    impact: 'cart recovery, win-back and every notification email will fail to send',
  },
  {
    name: 'Email unsubscribe',
    providerKey: null,
    anyOf: [
      ['EMAIL_UNSUBSCRIBE_SECRET',],
    ],
    impact: 'unsubscribe links cannot be signed, which is a compliance problem',
  },
  {
    name: 'WhatsApp',
    providerKey: 'WHATSAPP_PROVIDER',
    anyOf: [
      ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID',],
    ],
    impact: 'cart recovery and win-back messages will fail to send',
  },
  {
    name: 'Stripe',
    providerKey: null,
    anyOf: [
      ['STRIPE_SECRET_KEY',],
    ],
    impact: 'direct card billing will fail (Shopify Billing is unaffected)',
  },
  {
    name: 'Razorpay',
    providerKey: null,
    anyOf: [
      ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET',],
    ],
    impact: 'INR/UPI billing will fail (Shopify Billing is unaffected)',
  },
];

/** Provider names that mean "write to the log instead of sending". */
const NOOP_PROVIDERS = new Set(['console', 'none', 'noop', 'disabled',],);

/**
 * Work out which integrations are actually functional.
 *
 * @param {Record<string,string|undefined>} env
 * @returns {Array<{name:string,status:'ready'|'missing'|'disabled',missing:string[],impact:string}>}
 */
function assessIntegrations(env = process.env,) {
  const out = [];

  for (const spec of INTEGRATIONS) {
    // A satisfied group is one where every required key is present and
    // not a placeholder.
    let satisfied = null;
    let bestMissing = null;

    for (const group of spec.anyOf) {
      const missing = group.filter((key,) => {
        const v = env[key];
        return !v || classifyValue(v,).status !== 'ok';
      },);
      if (missing.length === 0) {
        satisfied = group;
        break;
      }
      // Keep the smallest missing set — the closest alternative to working.
      if (!bestMissing || missing.length < bestMissing.length) bestMissing = missing;
    }

    if (satisfied) {
      out.push({ name: spec.name, status: 'ready', missing: [], impact: spec.impact, },);
      continue;
    }

    // No credentials. Is the provider *explicitly* set to a no-op?
    //
    // Distinguishing "absent" from "deliberately off" matters: an unset
    // EMAIL_PROVIDER is a missing configuration, whereas EMAIL_PROVIDER=console
    // is a deliberate development choice. Only the latter is 'disabled'.
    const rawProvider = spec.providerKey ? env[spec.providerKey] : undefined;
    const providerIsSet = typeof rawProvider === 'string' && rawProvider.trim() !== '';
    const deliberatelyOff = providerIsSet && NOOP_PROVIDERS.has(rawProvider.toLowerCase().trim(),);

    out.push({
      name: spec.name,
      status: deliberatelyOff ? 'disabled' : 'missing',
      missing: bestMissing || [],
      impact: spec.impact,
    },);
  }

  return out;
}

// ─── Aggregated report ──────────────────────────────────────────────────────

/**
 * Build a full readiness report. Pure — performs no I/O and never exits.
 *
 * @param {Record<string,string|undefined>} env
 * @param {{ env?: string }} [options]
 */
function buildReadinessReport(env = process.env, options = {},) {
  const mode = options.env || env.NODE_ENV || 'development';
  const isProduction = mode === 'production';

  // 1. Required boot secrets (mirrors the existing config.js contract).
  const requiredSecrets = ['API_KEY', 'WEBHOOK_SECRET', 'TOKEN_ENCRYPTION_KEY',];
  const missingSecrets = requiredSecrets.filter((k,) => !env[k],);

  // 2. Sentinel values that must never reach production.
  const sentinelValues = [
    ['API_KEY', 'dev-key',],
    ['TOKEN_ENCRYPTION_KEY', 'storecops-default-key-do-not-use-in-prod',],
  ];
  const rejectedSentinels = sentinelValues
    .filter(([key, bad,],) => env[key] === bad,)
    .map(([key, bad,],) => ({ key, value: bad, }),);

  // 3. PUBLIC_URL — the highest-impact single value in the system.
  const publicUrl = classifyValue(env.PUBLIC_URL,);

  // 4. Integrations.
  const integrations = assessIntegrations(env,);

  const blocking = [];
  const warnings = [];

  if (missingSecrets.length > 0) {
    blocking.push({
      id: 'missing-secrets',
      message: `Missing required environment variables: ${missingSecrets.join(', ',)}`,
      fix: 'Set these in your deployment environment before starting the server.',
    },);
  }

  for (const { key, value, } of rejectedSentinels) {
    blocking.push({
      id: `sentinel-${key}`,
      message: `${key} is still the development sentinel value "${value}"`,
      fix: 'Generate a real secret: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    },);
  }

  if (publicUrl.status === 'empty') {
    blocking.push({
      id: 'public-url-empty',
      message: 'PUBLIC_URL is not set',
      fix:
        'PUBLIC_URL is the base for the OAuth callback, every webhook address, the ' +
        'storefront tracker src and every email link. Without it those fall back to ' +
        'http://localhost and are unreachable from Shopify.',
    },);
  } else if (publicUrl.status === 'placeholder') {
    blocking.push({
      id: 'public-url-placeholder',
      message: `PUBLIC_URL is an unreplaced placeholder (${publicUrl.label}): ${env.PUBLIC_URL}`,
      fix:
        'Set PUBLIC_URL to the public HTTPS origin that actually serves this app, ' +
        'and make it match application_url in shopify.app.toml.',
    },);
  } else if (publicUrl.status === 'local' && isProduction) {
    blocking.push({
      id: 'public-url-local',
      message: `PUBLIC_URL points at a local address (${publicUrl.label}): ${env.PUBLIC_URL}`,
      fix: 'Shopify cannot reach a local address. Set PUBLIC_URL to a public HTTPS origin.',
    },);
  }

  // ── Integration classification ────────────────────────────────────────────
  //
  // Not every absent integration is equally serious, so they are graded:
  //
  //   Shopify           -> the platform itself; without it the app is unusable
  //   Email + WhatsApp  -> the delivery channels; at least one must work, or
  //                        the Execution layer is inert
  //   Email unsubscribe -> only matters once email can actually send
  //   Stripe / Razorpay -> alternative payment rails; Shopify Billing is the
  //                        expected App Store path, so absence is informational
  //
  // Grading this way keeps the output actionable instead of a wall of noise
  // that operators learn to ignore.

  const notes = [];
  const byName = Object.fromEntries(integrations.map((i,) => [i.name, i,],),);
  const CHANNELS = ['Email', 'WhatsApp',];

  // Shopify is not optional.
  if (byName.Shopify && byName.Shopify.status !== 'ready') {
    warnings.push({
      id: 'integration-Shopify',
      message: `Shopify is not configured — ${byName.Shopify.impact}`,
      fix: `Set ${byName.Shopify.missing.join(' and ',)} from the Partner Dashboard.`,
    },);
  }

  // Delivery channels: at least one must work.
  const readyChannels = CHANNELS.filter((n,) => byName[n] && byName[n].status === 'ready',);
  const inertChannels = CHANNELS.filter((n,) => byName[n] && byName[n].status !== 'ready',);

  if (readyChannels.length === 0) {
    warnings.push({
      id: 'no-delivery-channel',
      message:
        'No outbound delivery channel is configured — cart recovery, win-back and ' +
        'every notification cannot be sent at all',
      fix:
        'Configure email (RESEND_API_KEY, or SMTP_HOST + SMTP_USER + SMTP_PASS) ' +
        'and/or WhatsApp (WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID).',
    },);
  }

  for (const name of inertChannels) {
    const channel = byName[name];
    if (channel.status === 'disabled') {
      notes.push({
        id: `integration-${name}-disabled`,
        message: `${name} provider is set to a no-op, so nothing will be sent`,
        fix: 'Set a real provider and its credentials, or remove the feature from your listing.',
      },);
    } else {
      notes.push({
        id: `integration-${name}`,
        message: `${name} is not configured — ${channel.impact}`,
        fix: `Set ${channel.missing.join(' and ',)} to enable this channel.`,
      },);
    }
  }

  // Unsubscribe signing only matters if email can actually send.
  if (
    byName.Email && byName.Email.status === 'ready' &&
    byName['Email unsubscribe'] && byName['Email unsubscribe'].status !== 'ready'
  ) {
    warnings.push({
      id: 'integration-Email-unsubscribe',
      message: `Email unsubscribe secret is missing — ${byName['Email unsubscribe'].impact}`,
      fix: `Set ${byName['Email unsubscribe'].missing.join(' and ',)}.`,
    },);
  }

  // Alternative payment rails are informational: Shopify Billing is the
  // expected path for a public App Store listing.
  for (const name of ['Stripe', 'Razorpay',]) {
    if (byName[name] && byName[name].status !== 'ready') {
      notes.push({
        id: `integration-${name}`,
        message: `${name} is not configured — ${byName[name].impact}`,
        fix: `Set ${byName[name].missing.join(' and ',)} if you sell outside Shopify Billing.`,
      },);
    }
  }

  return { mode, isProduction, publicUrl, integrations, blocking, warnings, notes, };
}

/** Render a report as human-readable lines. */
function formatReport(report,) {
  const lines = [];
  const tick = (s,) => `  ${s}`;

  lines.push(`Readiness report (NODE_ENV=${report.mode})`,);
  lines.push('',);

  const urlStatus = report.publicUrl.status === 'ok' ? 'ok' : report.publicUrl.status;
  lines.push(tick(`PUBLIC_URL ............ ${urlStatus}${report.publicUrl.label ? ` (${report.publicUrl.label})` : ''}`,),);
  for (const i of report.integrations) {
    lines.push(tick(`${i.name.padEnd(22, '.',).slice(0, 22,)} ${i.status}`,),);
  }

  if (report.blocking.length > 0) {
    lines.push('', `BLOCKING (${report.blocking.length}):`,);
    for (const b of report.blocking) {
      lines.push(`  [x] ${b.message}`,);
      lines.push(`      -> ${b.fix}`,);
    }
  }

  if (report.warnings.length > 0) {
    lines.push('', `WARNINGS (${report.warnings.length}):`,);
    for (const w of report.warnings) {
      lines.push(`  [!] ${w.message}`,);
      lines.push(`      -> ${w.fix}`,);
    }
  }

  const notes = report.notes || [];
  if (notes.length > 0) {
    lines.push('', `NOTES (${notes.length}):`,);
    for (const n of notes) {
      lines.push(`  [-] ${n.message}`,);
      lines.push(`      -> ${n.fix}`,);
    }
  }

  if (report.blocking.length === 0 && report.warnings.length === 0) {
    lines.push('', 'All blocking and warning checks passed.',);
  }

  return lines.join('\n',);
}

module.exports = {
  PLACEHOLDER_PATTERNS,
  LOCAL_PATTERNS,
  INTEGRATIONS,
  classifyValue,
  assessIntegrations,
  buildReadinessReport,
  formatReport,
};
