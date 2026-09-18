'use strict';

process.env.NODE_ENV = 'test';

/**
 * Password reset regression tests (P2).
 *
 * Before this, the platform had NO password reset at all: a merchant who
 * forgot their password lost their account permanently, and a compromised
 * account had no recovery path.
 *
 * The properties that matter, and that are easy to get wrong:
 *   1. No account enumeration — an unknown address gets an identical response.
 *   2. The raw token is never persisted; only its SHA-256 is stored.
 *   3. Single use — a replayed link fails even inside its validity window.
 *   4. Expiry is enforced.
 *   5. Every existing session dies on success, because a reset is the recovery
 *      path for a compromised account.
 *   6. The HTTP route never echoes the token to the client.
 */

const test = require('node:test',);
const assert = require('node:assert',);
const crypto = require('node:crypto',);
const { createPlatform, } = require('../src/platform',);
const { createApp, } = require('../src/server/createApp',);

const STRONG = 'correct-horse-battery-staple';
const STRONG_2 = 'another-long-passphrase-here';

function bootServer() {
  const platform = createPlatform();
  const app = createApp(platform,);
  return new Promise((resolve,) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port, } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        platform,
        close: () => new Promise((done,) => server.close(done,),),
      },);
    },);
  },);
}

/** Register an account and return { platform, email, password, user }. */
async function withAccount(email = 'reset@shop.com',) {
  const platform = createPlatform();
  const signup = await platform.auth.signup({ email, password: STRONG, storeName: 'Reset Co', },);
  const user = await platform.store.users.findOne({ email, },);
  return { platform, email, password: STRONG, user, signup, };
}

// ─── 1. No enumeration ───────────────────────────────────────────────────────

test('P2 reset: an unknown address gets the identical response to a known one', async () => {
  const { platform, } = await withAccount();

  const known = await platform.auth.requestPasswordReset({ email: 'reset@shop.com', },);
  const unknown = await platform.auth.requestPasswordReset({ email: 'nobody@shop.com', },);

  assert.deepEqual(unknown.message, known.message,);
  assert.equal(unknown.ok, true,);
  assert.equal(unknown.token, undefined, 'no token may be minted for an unknown address',);
  assert.ok(known.token, 'a token is minted for a real address',);
},);

test('P2 reset: a malformed address is answered the same way, not rejected', async () => {
  const { platform, } = await withAccount();
  const result = await platform.auth.requestPasswordReset({ email: 'not-an-email', },);

  assert.equal(result.ok, true,);
  assert.equal(result.token, undefined,);
},);

// ─── 2. The raw token is never stored ────────────────────────────────────────

test('P2 reset: only the SHA-256 of the token is persisted', async () => {
  const { platform, user, } = await withAccount();

  const { token, } = await platform.auth.requestPasswordReset({ email: 'reset@shop.com', },);
  const rows = await platform.store.passwordResets.find({ user_id: user._id, },);

  assert.equal(rows.length, 1,);
  const expected = crypto.createHash('sha256',).update(token,).digest('hex',);
  assert.equal(rows[0].token_hash, expected,);

  // The raw token must appear nowhere in the stored row.
  const serialized = JSON.stringify(rows[0],);
  assert.ok(!serialized.includes(token,), 'the raw token must not be stored',);
},);

test('P2 reset: issuing a new token invalidates the previous one', async () => {
  const { platform, } = await withAccount();

  const first = await platform.auth.requestPasswordReset({ email: 'reset@shop.com', },);
  const second = await platform.auth.requestPasswordReset({ email: 'reset@shop.com', },);

  await assert.rejects(
    () => platform.auth.resetPassword({ token: first.token, password: STRONG_2, },),
    /invalid or has expired/,
  );

  const result = await platform.auth.resetPassword({ token: second.token, password: STRONG_2, },);
  assert.equal(result.ok, true,);
},);

// ─── 3–5. Redeeming the token ────────────────────────────────────────────────

test('P2 reset: the new password works, the old one stops working', async () => {
  const { platform, email, } = await withAccount();
  const { token, } = await platform.auth.requestPasswordReset({ email, },);

  await platform.auth.resetPassword({ token, password: STRONG_2, },);

  await assert.rejects(() => platform.auth.login({ email, password: STRONG, },), /Invalid email or password/,);

  const ok = await platform.auth.login({ email, password: STRONG_2, },);
  assert.ok(ok.token,);
},);

test('P2 reset: the token is single use', async () => {
  const { platform, email, } = await withAccount();
  const { token, } = await platform.auth.requestPasswordReset({ email, },);

  await platform.auth.resetPassword({ token, password: STRONG_2, },);
  // Same token, still inside its window — must still fail.
  await assert.rejects(
    () => platform.auth.resetPassword({ token, password: 'yet-another-long-passphrase', },),
    /invalid or has expired/,
  );
},);

test('P2 reset: an expired token is refused and cleaned up', async () => {
  const { platform, email, } = await withAccount();
  const { token, } = await platform.auth.requestPasswordReset({ email, },);

  // Force expiry.
  const row = await platform.store.passwordResets.findOne({ email, },);
  await platform.store.passwordResets.update(row._id, {
    expires_at: new Date(Date.now() - 1000,).toISOString(),
  },);

  await assert.rejects(
    () => platform.auth.resetPassword({ token, password: STRONG_2, },),
    /invalid or has expired/,
  );
  assert.equal((await platform.store.passwordResets.find({ email, },)).length, 0,);
},);

test('P2 reset: the TTL is at most 30 minutes', async () => {
  const { platform, email, } = await withAccount();
  const { expires_at, } = await platform.auth.requestPasswordReset({ email, },);

  const windowMs = new Date(expires_at,).getTime() - Date.now();
  assert.ok(windowMs > 0,);
  assert.ok(windowMs <= 30 * 60 * 1000 + 1000, `reset window was ${windowMs}ms, must be <= 30 min`,);
},);

test('P2 reset: a weak new password is rejected and the token survives', async () => {
  const { platform, email, } = await withAccount();
  const { token, } = await platform.auth.requestPasswordReset({ email, },);

  await assert.rejects(() => platform.auth.resetPassword({ token, password: 'password1234', },), /too common|at least/,);

  // A rejected password must not burn the token.
  const result = await platform.auth.resetPassword({ token, password: STRONG_2, },);
  assert.equal(result.ok, true,);
},);

test('P2 reset: every existing session is revoked on success', async () => {
  const { platform, email, } = await withAccount();

  // Two live sessions for the account.
  const sessionA = await platform.auth.login({ email, password: STRONG, },);
  const sessionB = await platform.auth.login({ email, password: STRONG, },);
  assert.ok(await platform.auth.verify(sessionA.token,),);
  assert.ok(await platform.auth.verify(sessionB.token,),);

  const { token, } = await platform.auth.requestPasswordReset({ email, },);
  const result = await platform.auth.resetPassword({ token, password: STRONG_2, },);

  assert.ok(result.sessions_revoked >= 2, `expected >= 2 revoked, got ${result.sessions_revoked}`,);
  assert.equal(await platform.auth.verify(sessionA.token,), null, 'session A must be dead',);
  assert.equal(await platform.auth.verify(sessionB.token,), null, 'session B must be dead',);
},);

test('P2 reset: logout deletes the session row rather than tombstoning it', async () => {
  const { platform, email, } = await withAccount();
  const session = await platform.auth.login({ email, password: STRONG, },);

  const before = await platform.store.sessions.count({},);
  await platform.auth.logout(session.token,);
  const after = await platform.store.sessions.count({},);

  assert.equal(after, before - 1, 'the row must be gone, not flagged',);
  assert.equal(await platform.auth.verify(session.token,), null,);
},);

// ─── 6. HTTP contract ────────────────────────────────────────────────────────

test('P2 reset: the HTTP route never echoes the token', async () => {
  const { base, platform, close, } = await bootServer();

  try {
    await platform.auth.signup({ email: 'http-reset@shop.com', password: STRONG, },);

    const res = await fetch(`${base}/api/v1/auth/forgot-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', },
      body: JSON.stringify({ email: 'http-reset@shop.com', },),
    },);
    const body = await res.json();

    assert.equal(res.status, 200,);
    assert.equal(body.ok, true,);
    assert.ok(body.message,);
    assert.equal(body.token, undefined, 'the token must never reach the client',);
    assert.ok(!JSON.stringify(body,).includes('token',),);
  } finally {
    await close();
  }
},);

test('P2 reset: unknown and known addresses return the same HTTP status and body', async () => {
  const { base, platform, close, } = await bootServer();

  try {
    await platform.auth.signup({ email: 'known@shop.com', password: STRONG, },);

    const post = async (email,) => {
      const res = await fetch(`${base}/api/v1/auth/forgot-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', },
        body: JSON.stringify({ email, },),
      },);
      return { status: res.status, body: await res.json(), };
    };

    const known = await post('known@shop.com',);
    const unknown = await post('ghost@shop.com',);

    assert.equal(unknown.status, known.status,);
    assert.deepEqual(unknown.body, known.body,);
  } finally {
    await close();
  }
},);

test('P2 reset: a token minted by the service completes over HTTP', async () => {
  const { base, platform, close, } = await bootServer();
  const email = 'e2e-reset@shop.com';

  try {
    await platform.auth.signup({ email, password: STRONG, },);
    const { token, } = await platform.auth.requestPasswordReset({ email, },);

    const res = await fetch(`${base}/api/v1/auth/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', },
      body: JSON.stringify({ token, password: STRONG_2, },),
    },);
    const body = await res.json();

    assert.equal(res.status, 200,);
    assert.equal(body.ok, true,);

    // The new password works over HTTP too.
    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', },
      body: JSON.stringify({ email, password: STRONG_2, },),
    },);
    assert.equal(login.status, 200,);
  } finally {
    await close();
  }
},);

test('P2 reset: an invalid token is a 400 with no account detail', async () => {
  const { base, close, } = await bootServer();

  try {
    const res = await fetch(`${base}/api/v1/auth/reset-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', },
      body: JSON.stringify({ token: 'deadbeef'.repeat(8,), password: STRONG_2, },),
    },);
    const body = await res.json();

    assert.equal(res.status, 400,);
    assert.match(body.error, /invalid or has expired/,);
  } finally {
    await close();
  }
},);

// ─── changePassword (authenticated) ─────────────────────────────────────────

test('P2 password: changePassword verifies the current password', async () => {
  const { platform, user, } = await withAccount('changer@shop.com',);

  await assert.rejects(
    () => platform.auth.changePassword({ userId: user._id, currentPassword: 'wrong', newPassword: STRONG_2, },),
    /Current password is incorrect/,
  );

  const ok = await platform.auth.changePassword({
    userId: user._id,
    currentPassword: STRONG,
    newPassword: STRONG_2,
  },);
  assert.equal(ok.ok, true,);
  assert.ok(await platform.auth.login({ email: 'changer@shop.com', password: STRONG_2, },),);
},);

test('P2 password: changePassword enforces the policy', async () => {
  const { platform, user, } = await withAccount('policy@shop.com',);

  await assert.rejects(
    () => platform.auth.changePassword({ userId: user._id, currentPassword: STRONG, newPassword: 'short', },),
    /at least 12/,
  );
},);
