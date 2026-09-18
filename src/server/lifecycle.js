'use strict';

/**
 * Process lifecycle — graceful shutdown and fatal-error handling (OBS-001).
 *
 * The app previously registered **no** `process.on(...)` handler at all. Two
 * consequences, both silent:
 *
 *   1. **SIGTERM killed it outright.** Railway (and every container host) sends
 *      SIGTERM before stopping an instance. With no handler the process died
 *      immediately, so anything queued but not yet delivered — recovery
 *      messages, the delivery drain, the growth cycle's in-flight work — was
 *      lost on **every deploy**. `sqliteStore` also exposes `close()` and
 *      nothing called it, leaving the write-ahead log to the next open.
 *   2. **A crash produced an unstructured stack trace and nothing else.** No
 *      record of which subsystem failed, no exit-code contract for the
 *      orchestrator, no chance to release the database handle.
 *
 * Extracted from `server.js` because that file binds a port at module scope and
 * nothing inside it is reachable from a test — the same reason `healthProbe`
 * and `growthScheduler` were extracted.
 *
 * Deliberate behaviour choice: an unhandled rejection or uncaught exception
 * still **exits** (code 1). Node's own default is to fail fast, and silently
 * continuing after one is how a process ends up serving from undefined state.
 * What changes here is that it fails *loudly and cleanly* rather than quietly.
 */

const DEFAULT_GRACE_MS = 10_000;

/** Structured line, matching the `[SECURITY] {json}` convention already in use. */
function emit(log, level, event, detail = {},) {
  const line = {
    event,
    ...detail,
    timestamp: new Date().toISOString(),
  };
  const write = level === 'error' ? log.error : log.log;
  try {
    write.call(log, `[LIFECYCLE] ${JSON.stringify(line,)}`,);
  } catch {
    // Logging must never be the thing that prevents shutdown.
  }
}

/**
 * Stop accepting connections and wait for in-flight requests to finish.
 * Never throws — the caller only needs to know whether it worked.
 */
async function closeServer(server,) {
  if (!server || typeof server.close !== 'function') {
    return { ok: true, skipped: true, };
  }

  return new Promise((resolve,) => {
    let settled = false;
    const done = (ok, error,) => {
      if (settled) return;
      settled = true;
      resolve({ ok, error, },);
    };

    try {
      server.close((err,) => done(!err, err?.message,),);
    } catch (err) {
      done(false, err.message,);
      return;
    }

    // An idle keep-alive socket never ends on its own, so `close()` alone would
    // wait for the full grace period and then be force-killed. Releasing idle
    // sockets lets the drain finish promptly; requests still in flight are left
    // alone so they can complete.
    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }
  },);
}

/**
 * @param {object}   options
 * @param {object}   options.server    HTTP server handle (from `app.listen`).
 * @param {object}   options.store     Storage adapter; `close()` if present.
 * @param {object}   [options.log]     Logger (defaults to `console`).
 * @param {Function} [options.exit]    Exit function (injected for tests).
 * @param {number}   [options.graceMs] Hard deadline before a forced exit.
 */
function createLifecycle({ server, store, log = console, exit = process.exit, graceMs = DEFAULT_GRACE_MS, },) {
  let shuttingDown = false;
  let completed = null;

  async function shutdown(reason, exitCode = 0,) {
    // A host sends SIGTERM and then SIGKILL after a timeout, and an operator may
    // send SIGINT as well. Re-running the drain on a second signal would try to
    // close an already-closed server and could exit with the wrong code.
    if (shuttingDown) {
      return { alreadyShuttingDown: true, reason, };
    }
    shuttingDown = true;

    emit(log, 'log', 'shutdown_started', { reason, exit_code: exitCode, },);

    // Hard deadline. A stuck connection must not hold the instance open until
    // the host escalates to SIGKILL, which would lose the same work twice.
    const deadline = setTimeout(() => {
      emit(log, 'error', 'shutdown_timeout', { reason, grace_ms: graceMs, },);
      exit(1,);
    }, graceMs,);
    if (typeof deadline.unref === 'function') deadline.unref();

    const result = { reason, exit_code: exitCode, server: null, store: null, errors: [], };

    result.server = await closeServer(server,);

    if (store && typeof store.close === 'function') {
      try {
        result.store = await store.close();
      } catch (err) {
        // A store that fails to close must not prevent the process from exiting.
        result.errors.push(`store.close: ${err.message}`,);
        result.store = { ok: false, error: err.message, };
      }
    } else {
      result.store = { ok: true, skipped: true, };
    }

    clearTimeout(deadline,);
    emit(log, 'log', 'shutdown_complete', {
      reason,
      server_closed: result.server?.ok === true && result.server?.skipped !== true,
      store_closed: result.store?.ok === true && result.store?.skipped !== true,
      errors: result.errors,
    },);

    completed = result;
    exit(exitCode,);
    return result;
  }

  return {
    shutdown,
    isShuttingDown: () => shuttingDown,
    lastResult: () => completed,
  };
}

/**
 * Attach the process-level handlers. Split from `createLifecycle` so the drain
 * can be exercised in a test without touching the real `process`.
 */
function installProcessHandlers({ target = process, lifecycle, log = console, } = {},) {
  const onSignal = (signal,) => () => {
    emit(log, 'log', 'signal_received', { signal, },);
    lifecycle.shutdown(signal, 0,);
  };

  target.on('SIGTERM', onSignal('SIGTERM',),);
  target.on('SIGINT', onSignal('SIGINT',),);

  target.on('uncaughtException', (err,) => {
    emit(log, 'error', 'uncaught_exception', {
      message: err?.message,
      stack: err?.stack,
    },);
    // Exit non-zero: the orchestrator should restart, and the process state
    // after an uncaught exception is not safe to keep serving from.
    lifecycle.shutdown('uncaughtException', 1,);
  },);

  target.on('unhandledRejection', (reason,) => {
    emit(log, 'error', 'unhandled_rejection', {
      message: reason?.message ?? String(reason,),
      stack: reason?.stack,
    },);
    lifecycle.shutdown('unhandledRejection', 1,);
  },);

  // Recorded so an operator can confirm a deploy actually has graceful shutdown,
  // and so a local run that "does not drain" is not mistaken for a broken
  // handler: Node does not deliver SIGTERM on Windows — the OS terminates the
  // process instead. Linux hosts (Railway) do deliver it.
  emit(log, 'log', 'handlers_installed', {
    signals: ['SIGTERM', 'SIGINT',],
    fatal: ['uncaughtException', 'unhandledRejection',],
    platform: target.platform,
    sigterm_supported: target.platform !== 'win32',
  },);

  return target;
}

module.exports = { createLifecycle, installProcessHandlers, DEFAULT_GRACE_MS, };
