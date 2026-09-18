'use strict';

/**
 * Process lifecycle — graceful shutdown and fatal-error handling (OBS-001).
 *
 * Before this, the app registered no `process.on(...)` handler at all: SIGTERM
 * (sent on every deploy) killed it outright, so anything queued but undelivered
 * was lost each time, and `sqliteStore.close()` was never called. A crash
 * produced a bare stack trace with no exit-code contract.
 *
 * `exit` is injected throughout so the tests can assert the exit *code* rather
 * than killing the test runner.
 */

process.env.NODE_ENV = 'test';

const test = require('node:test',);
const assert = require('node:assert',);
const { EventEmitter, } = require('node:events',);

const { createLifecycle, installProcessHandlers, } = require('../src/server/lifecycle',);

const silentLog = { log() {}, error() {}, };

/** Flush pending microtasks and one macrotask, so an async handler settles. */
const flush = () => new Promise((resolve,) => setImmediate(resolve,),);

function fakeServer({ hang = false, withIdle = true, } = {},) {
  const calls = { close: 0, closeIdleConnections: 0, };
  const server = {
    calls,
    close(cb,) {
      calls.close += 1;
      if (!hang) cb();
    },
  };
  if (withIdle) {
    server.closeIdleConnections = () => { calls.closeIdleConnections += 1; };
  }
  return server;
}

function recorder() {
  const calls = [];
  return { calls, fn: (code,) => { calls.push(code,); }, };
}

test('shutdown closes the server and the store, then exits with the given code', async () => {
  const server = fakeServer();
  const closed = [];
  const store = { close: async () => { closed.push(true,); return { ok: true, }; }, };
  const exit = recorder();

  const lifecycle = createLifecycle({ server, store, log: silentLog, exit: exit.fn, },);
  await lifecycle.shutdown('SIGTERM', 0,);

  assert.strictEqual(server.calls.close, 1,);
  assert.strictEqual(closed.length, 1, 'store.close() must be called — this is what was missing',);
  assert.deepStrictEqual(exit.calls, [0,],);
  assert.strictEqual(lifecycle.isShuttingDown(), true,);
},);

test('idle keep-alive connections are released so the drain cannot hang', async () => {
  const server = fakeServer();
  const lifecycle = createLifecycle({ server, store: {}, log: silentLog, exit: recorder().fn, },);
  await lifecycle.shutdown('SIGTERM', 0,);

  assert.strictEqual(server.calls.closeIdleConnections, 1,);
},);

test('a second signal does not re-run the drain or change the exit code', async () => {
  const server = fakeServer();
  let closes = 0;
  const store = { close: async () => { closes += 1; }, };
  const exit = recorder();

  const lifecycle = createLifecycle({ server, store, log: silentLog, exit: exit.fn, },);
  await lifecycle.shutdown('SIGTERM', 0,);
  const second = await lifecycle.shutdown('SIGINT', 0,);

  assert.strictEqual(second.alreadyShuttingDown, true,);
  assert.strictEqual(server.calls.close, 1, 'the server must be closed exactly once',);
  assert.strictEqual(closes, 1,);
  assert.deepStrictEqual(exit.calls, [0,], 'a second signal must not exit again',);
},);

test('a store that fails to close does not block the exit', async () => {
  const server = fakeServer();
  const store = { close: async () => { throw new Error('disk gone',); }, };
  const exit = recorder();

  const lifecycle = createLifecycle({ server, store, log: silentLog, exit: exit.fn, },);
  const result = await lifecycle.shutdown('SIGTERM', 0,);

  assert.deepStrictEqual(exit.calls, [0,], 'the process must still exit',);
  assert.strictEqual(result.errors.length, 1,);
  assert.match(result.errors[0], /disk gone/,);
},);

test('an adapter without close() is skipped, not fatal', async () => {
  const server = fakeServer();
  const exit = recorder();
  const lifecycle = createLifecycle({ server, store: {}, log: silentLog, exit: exit.fn, },);

  const result = await lifecycle.shutdown('SIGTERM', 0,);

  assert.strictEqual(result.store.skipped, true,);
  assert.deepStrictEqual(exit.calls, [0,],);
},);

test('a store whose close() rejects asynchronously still lets the process exit', async () => {
  const server = fakeServer();
  const store = { close: () => Promise.reject(new Error('nope',),), };
  const exit = recorder();
  const lifecycle = createLifecycle({ server, store, log: silentLog, exit: exit.fn, },);

  const result = await lifecycle.shutdown('SIGTERM', 0,);

  assert.deepStrictEqual(exit.calls, [0,],);
  assert.match(result.errors[0], /nope/,);
},);

test('a drain that hangs is force-exited at the grace deadline', async () => {
  // A connection that never ends would otherwise hold the instance open until
  // the host escalates to SIGKILL — losing the work the drain was protecting.
  const server = fakeServer({ hang: true, },);
  const exit = recorder();
  const lifecycle = createLifecycle({
    server, store: {}, log: silentLog, exit: exit.fn, graceMs: 20,
  },);

  lifecycle.shutdown('SIGTERM', 0,);
  await new Promise((resolve,) => setTimeout(resolve, 60,),);

  assert.deepStrictEqual(exit.calls, [1,], 'a stuck drain must exit non-zero',);
},);

test('SIGTERM and SIGINT both trigger a clean exit', async () => {
  for (const signal of ['SIGTERM', 'SIGINT',]) {
    const server = fakeServer();
    const closed = [];
    const store = { close: async () => { closed.push(true,); }, };
    const exit = recorder();
    const lifecycle = createLifecycle({ server, store, log: silentLog, exit: exit.fn, },);
    const proc = new EventEmitter();

    installProcessHandlers({ target: proc, lifecycle, log: silentLog, },);
    proc.emit(signal,);
    await flush();
    await flush();

    assert.deepStrictEqual(exit.calls, [0,], `${signal} must exit 0`,);
    assert.strictEqual(closed.length, 1, `${signal} must release the store`,);
  }
},);

test('an uncaught exception is logged, drained, and exits non-zero', async () => {
  const server = fakeServer();
  const closed = [];
  const store = { close: async () => { closed.push(true,); }, };
  const exit = recorder();
  const lines = [];
  const log = { log: (m,) => lines.push(m,), error: (m,) => lines.push(m,), };

  const lifecycle = createLifecycle({ server, store, log, exit: exit.fn, },);
  const proc = new EventEmitter();
  installProcessHandlers({ target: proc, lifecycle, log, },);

  proc.emit('uncaughtException', new Error('boom',),);
  await flush();
  await flush();

  assert.deepStrictEqual(exit.calls, [1,], 'a crash must not exit 0',);
  assert.strictEqual(closed.length, 1, 'the store must still be released',);

  const crashLine = lines.find((l,) => l.includes('uncaught_exception',),);
  assert.ok(crashLine, 'the crash must be reported',);
  assert.ok(crashLine.startsWith('[LIFECYCLE] ',),);
  // Structured, so the host can parse it rather than scrape a stack trace.
  const json = JSON.parse(crashLine.replace('[LIFECYCLE] ', '',),);
  assert.strictEqual(json.event, 'uncaught_exception',);
  assert.strictEqual(json.message, 'boom',);
},);

test('an unhandled rejection is logged, drained, and exits non-zero', async () => {
  const server = fakeServer();
  const exit = recorder();
  const lines = [];
  const log = { log: (m,) => lines.push(m,), error: (m,) => lines.push(m,), };

  const lifecycle = createLifecycle({ server, store: {}, log, exit: exit.fn, },);
  const proc = new EventEmitter();
  installProcessHandlers({ target: proc, lifecycle, log, },);

  proc.emit('unhandledRejection', new Error('rejected',),);
  await flush();
  await flush();

  assert.deepStrictEqual(exit.calls, [1,],);
  const line = lines.find((l,) => l.includes('unhandled_rejection',),);
  assert.ok(line,);
  assert.strictEqual(JSON.parse(line.replace('[LIFECYCLE] ', '',),).message, 'rejected',);
},);

test('a non-Error rejection reason is still reported as a string', async () => {
  const server = fakeServer();
  const exit = recorder();
  const lines = [];
  const log = { log: (m,) => lines.push(m,), error: (m,) => lines.push(m,), };

  const lifecycle = createLifecycle({ server, store: {}, log, exit: exit.fn, },);
  const proc = new EventEmitter();
  installProcessHandlers({ target: proc, lifecycle, log, },);

  // `Promise.reject('nope')` is legal and would otherwise log `undefined`.
  proc.emit('unhandledRejection', 'nope',);
  await flush();
  await flush();

  const line = lines.find((l,) => l.includes('unhandled_rejection',),);
  assert.strictEqual(JSON.parse(line.replace('[LIFECYCLE] ', '',),).message, 'nope',);
},);

test('installing the handlers announces itself, including whether SIGTERM is deliverable', async () => {
  // This line exists so a deploy can be *confirmed* to have graceful shutdown,
  // and so a local run that fails to drain is not misread as a broken handler.
  // Node does not deliver SIGTERM on Windows — the OS terminates the process —
  // so the platform decision is the part worth pinning.
  for (const [platform, expected,] of [['win32', false,], ['linux', true,],]) {
    const lines = [];
    const log = { log: (m,) => lines.push(m,), error: (m,) => lines.push(m,), };
    const proc = new EventEmitter();
    proc.platform = platform;

    const lifecycle = createLifecycle({ server: fakeServer(), store: {}, log, exit: recorder().fn, },);
    installProcessHandlers({ target: proc, lifecycle, log, },);

    const line = lines.find((l,) => l.includes('handlers_installed',),);
    assert.ok(line, 'the boot line must be emitted — it is the only evidence the drain exists',);

    const json = JSON.parse(line.replace('[LIFECYCLE] ', '',),);
    assert.strictEqual(json.platform, platform,);
    assert.strictEqual(json.sigterm_supported, expected, `sigterm_supported must be ${expected} on ${platform}`,);
    assert.deepStrictEqual(json.signals, ['SIGTERM', 'SIGINT',],);
    assert.deepStrictEqual(json.fatal, ['uncaughtException', 'unhandledRejection',],);

    // The line must describe handlers that are actually attached, not just claim them.
    for (const event of [...json.signals, ...json.fatal,]) {
      assert.strictEqual(proc.listenerCount(event,), 1, `${event} must really be registered`,);
    }
  }
},);

test('a logging failure cannot prevent shutdown', async () => {
  const server = fakeServer();
  const closed = [];
  const store = { close: async () => { closed.push(true,); }, };
  const exit = recorder();
  const explodingLog = { log() { throw new Error('logger down',); }, error() { throw new Error('logger down',); }, };

  const lifecycle = createLifecycle({ server, store, log: explodingLog, exit: exit.fn, },);
  await lifecycle.shutdown('SIGTERM', 0,);

  assert.deepStrictEqual(exit.calls, [0,],);
  assert.strictEqual(closed.length, 1,);
},);
