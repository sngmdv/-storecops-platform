'use strict';

/**
 * Shared AST scan: find every async function in `src/server/` that Express can
 * invoke as a handler or middleware, and say whether it can reject unhandled.
 *
 * WHY A REAL PARSER
 * -----------------
 * A hand-written scanner was tried first and silently skipped a handler: it
 * mis-lexed `/^https?:\/\//` as a line comment, swallowed the rest of the line,
 * permanently offset its bracket depth, and reported "not found" — so the loop
 * dropped that handler while still reporting a confident result. Distinguishing
 * `/` division from `/` regex-start needs a lexer. `espree` is the parser ESLint
 * already uses, so it is present wherever the project lints.
 *
 * WHAT COUNTS
 * -----------
 * Express 4 does not catch a rejected async handler — `Layer.handle_request`
 * wraps only the *synchronous* call — so a rejection leaves the request
 * unanswered **and** raises an unhandled rejection, which terminates the process
 * by default. Three positions can put an async function in Express's hands:
 *
 *   1. `app.<verb>(async ...)` / `router.<verb>(async ...)` — a handler literal.
 *   2. `app.use(async ...)` / `router.use(async ...)` — a middleware literal.
 *   3. `return async (req, res, next) => {...}` — a **factory-produced**
 *      middleware, e.g. `createRbac().middleware('administer')`. This shape is
 *      invisible to a scan that only looks at call arguments, which is exactly
 *      how item 42 went unnoticed for so long.
 *
 * Guarded means: it is an argument of `wrap(...)` (whose own body carries the
 * try/catch), or its body contains a `try`.
 */

const fs = require('fs',);
const path = require('path',);
const espree = require('espree',);

const REGISTRATION_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'use',],);

function* walkAst(node,) {
  if (!node || typeof node.type !== 'string') return;
  yield node;
  for (const key of Object.keys(node,)) {
    if (key === 'parent') continue;
    const value = node[key];
    if (Array.isArray(value,)) {
      for (const child of value) yield* walkAst(child,);
    } else if (value && typeof value.type === 'string') {
      yield* walkAst(value,);
    }
  }
}

function containsTry(fnNode,) {
  for (const n of walkAst(fnNode.body,)) if (n.type === 'TryStatement') return true;
  return false;
}

const isAsyncFn = (n,) =>
  Boolean(n,)
  && (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression')
  && n.async === true;

/** A factory-produced middleware is one whose first params are (req, res, …). */
function isReqRes(n,) {
  const params = n.params || [];
  const nameAt = (i,) => (params[i]?.type === 'Identifier' ? params[i].name : '');
  return /^req/.test(nameAt(0,),) && /^res/.test(nameAt(1,),);
}

/**
 * The `app`/`router` object a registration is attached to, or null.
 *
 * Matches `app`, `router`, `apiRouter`, `router2`, `platform.router`, … Anything
 * named `*outer*` is treated as an Express router; a non-router member call is
 * not a registration.
 */
function registrationOwner(callee,) {
  if (callee?.type !== 'MemberExpression') return null;
  const prop = callee.property;
  if (prop?.type !== 'Identifier' || !REGISTRATION_VERBS.has(prop.name,)) return null;
  const obj = callee.object;
  const objName =
    obj?.type === 'Identifier' ? obj.name
      : obj?.type === 'MemberExpression' && obj.property?.type === 'Identifier' ? obj.property.name
        : null;
  if (!objName) return null;
  if (objName === 'app' || /[Rr]outer/.test(objName,)) return objName;
  return null;
}

const isWrapCall = (node,) =>
  node.callee?.type === 'Identifier' && node.callee.name === 'wrap';

/** The route path from a registration's argument list, when it is a literal. */
function literalPath(args,) {
  const first = args?.[0];
  return first?.type === 'Literal' && typeof first.value === 'string' ? first.value : null;
}

/** Is `node` lexically inside the `block` of a `try`, without leaving the function? */
function isInsideTry(node, parentOf,) {
  let cur = node;
  for (;;) {
    const parent = parentOf.get(cur,);
    if (!parent) return false;
    if (parent.type === 'TryStatement' && parent.block === cur) return true;
    if (
      parent.type === 'FunctionDeclaration'
      || parent.type === 'FunctionExpression'
      || parent.type === 'ArrowFunctionExpression'
    ) return false;
    cur = parent;
  }
}

/**
 * @returns {Array<{file: string, line: number, kind: string, guarded: boolean,
 *   params: string}>} one entry per async function in a handler/middleware
 *   position. Functions that are neither registered nor factory-returned are
 *   internal helpers and are not reported.
 */
function scanSource(source, file,) {
  const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'script', loc: true, },);

  const parentOf = new Map();
  for (const node of walkAst(ast,)) {
    for (const key of Object.keys(node,)) {
      if (key === 'parent') continue;
      const value = node[key];
      if (Array.isArray(value,)) {
        for (const child of value) if (child && typeof child.type === 'string') parentOf.set(child, node,);
      } else if (value && typeof value.type === 'string') {
        parentOf.set(value, node,);
      }
    }
  }

  const out = [];

  // An async middleware assigned to a variable is reachable two ways, and both are
  // real. `return mw` hands it straight to Express, so nothing upstream can guard
  // it and it must guard itself. `mw(req, res, next)` inside a caller's try is
  // guarded by that caller — which is the delegation shape used by
  // `apiKeyMiddleware`. A detector that only looked at call arguments and
  // `return async ...` saw neither, which is how a regression to `return mw`
  // passed unnoticed.
  const assigned = new Map();
  const callSites = new Map();
  const returnedNames = new Set();
  for (const node of walkAst(ast,)) {
    if (
      node.type === 'VariableDeclarator'
      && node.id?.type === 'Identifier'
      && isAsyncFn(node.init,)
      && isReqRes(node.init,)
    ) {
      assigned.set(node.id.name, node.init,);
    }
    if (node.type === 'ReturnStatement' && node.argument?.type === 'Identifier') {
      returnedNames.add(node.argument.name,);
    }
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier') {
      callSites.set(node.callee.name, [...(callSites.get(node.callee.name,) || []), node,],);
    }
  }

  for (const node of walkAst(ast,)) {
    if (!isAsyncFn(node,)) continue;
    const parent = parentOf.get(node,);

    const hasOwnTry = node.body.type === 'BlockStatement' && containsTry(node,);
    let kind = null;
    let guarded = false;
    let routePath = null;

    if (parent?.type === 'CallExpression' && parent.arguments.includes(node,)) {
      if (isWrapCall(parent,)) {
        kind = 'wrap';
        guarded = true; // the wrapper's own body carries the try/catch
        // `wrap(handler)` is usually nested inside a router.<verb>(...) call.
        const outer = parentOf.get(parent,);
        if (outer?.type === 'CallExpression' && registrationOwner(outer.callee,)) {
          routePath = literalPath(outer.arguments,);
        }
      } else {
        const owner = registrationOwner(parent.callee,);
        if (owner) {
          kind = `registration:${owner}`;
          guarded = hasOwnTry;
          routePath = literalPath(parent.arguments,);
        }
      }
    } else if (parent?.type === 'ReturnStatement' && isReqRes(node,)) {
      kind = 'factory-return';
      guarded = hasOwnTry;
    } else if (parent?.type === 'VariableDeclarator' && parent.init === node) {
      const name = parent.id?.type === 'Identifier' ? parent.id.name : null;
      if (name) {
        const sites = callSites.get(name,) || [];
        if (returnedNames.has(name,)) {
          // Handed to Express directly — nothing upstream can guard it.
          kind = 'returned-middleware';
          guarded = hasOwnTry;
        } else if (sites.length > 0) {
          // Reached only through calls, so it is guarded when every call is.
          kind = 'delegated-middleware';
          guarded = sites.every((call,) => isInsideTry(call, parentOf,),);
        }
      }
    }
    if (!kind) continue;

    out.push({
      file,
      line: node.loc.start.line,
      kind,
      path: routePath,
      guarded,
      params: (node.params || []).map((p,) => p.name || p.type,).join(',',),
    },);
  }
  return out;
}

/** Scan every `.js` file under `dir`, recursively. */
function scanDir(dir, baseDir = dir,) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true, },)
    .sort((a, b,) => a.name.localeCompare(b.name,),);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name,);
    if (entry.isDirectory()) {
      out.push(...scanDir(fullPath, baseDir,),);
    } else if (entry.isFile() && entry.name.endsWith('.js',)) {
      const source = fs.readFileSync(fullPath, 'utf8',);
      const rel = path.relative(baseDir, fullPath,).split(path.sep,).join('/',);
      out.push(...scanSource(source, rel,),);
    }
  }
  return out;
}

module.exports = { scanSource, scanDir, containsTry, REGISTRATION_VERBS, };
