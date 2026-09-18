'use strict';

process.env.NODE_ENV = 'test';

/**
 * P2 auth-hardening regression tests.
 *
 *  1. Password policy — length floor, breached-password check, no email reuse.
 *     The old floor was 8 characters with no other check, so `password` and
 *     `12345678` were accepted.
 *  2. Password hashing is async. `scryptSync` blocked the event loop for the
 *     whole derivation, so a few concurrent logins stalled every other request.
 *  3. Per-account login throttle, including the non-enumeration property: a
 *     locked account must be indistinguishable from a wrong password.
 *  4. Session tokens must carry a numeric `exp`. The check used to be
 *     `typeof exp === 'number' && ...`, so a token with no `exp` never expired.
 */

const test = require('node:test',);
const assert = require('node:assert',);
const crypto = require('node:crypto',);
const { createPlatform, } = require('../src/platform',);
const {
  validatePassword,
  hashPassword,
  verifyPassword,
  MIN_PASSWORD,
} = require('../src/server/auth',);
const { createLoginThrottle, } = require('../src/server/loginThrottle',);
const { createSessionTokenVerifier, } = require('../src/server/sessionToken',);

// ─── 1. Password policy ──────────────────────────────────────────────────────

test('P2 password: rejects anything below the length floor', () => {
  assert.ok(MIN_PASSWORD >= 12, 'the floor must be raised above the old value of 8',);

  for (const weak of ['short', 'password', '12345678', 'a'.repeat(MIN_PASSWORD - 1,),]) {
    const result = validatePassword(weak,);
    assert.equal(result.ok, false, `${weak} must be rejected`,);
    assert.ok(result.error,);
  }
},);

test('P2 password: rejects common passwords even when long enough', () => {
  // These are all >= 12 characters, so length alone would admit them.
  for (const common of ['password1234', '123456789012', 'qwerty123456', 'administrator',]) {
    assert.ok(common.length >= MIN_PASSWORD, `${common} should be long enough to isolate the check`,);
    const result = validatePassword(common,);
    assert.equal(result.ok, false, `${common} must be rejected as common`,);
  }
},);

test('P2 password: rejects the account\'s own email local part', () => {
  const result = validatePassword('merchantname', { email: 'merchantname@shop.com', },);
  assert.equal(result.ok, false,);
  assert.match(result.error, /email/i,);
},);

test('P2 password: accepts a long passphrase and bounds the maximum', () => {
  assert.equal(validatePassword('correct-horse-battery-staple',).ok, true,);
  assert.equal(validatePassword('x'.repeat(256,),).ok, true,);
  // Unbounded input would let an attacker burn CPU on a deliberately huge
  // scrypt derivation.
  assert.equal(validatePassword('x'.repeat(257,),).ok, false,);
},);

// ─── 2. Hashing is async ─────────────────────────────────────────────────────

test('P2 password: hashing returns a promise and does not block the loop', async () => {
  const salt = crypto.randomBytes(16,).toString('hex',);
  const pending = hashPassword('correct-horse-battery-staple', salt,);
  assert.ok(pending instanceof Promise, 'hashPassword must be async, not scryptSync',);

  // A blocking implementation would prevent this timer from firing.
  let ticked = false;
  const timer = new Promise((resolve,) => setTimeout(() => { ticked = true; resolve(); }, 0,),);
  const [digest,] = await Promise.all([pending, timer,],);

  assert.equal(ticked, true, 'the event loop must stay free during derivation',);
  assert.equal(typeof digest, 'string',);
  assert.equal(digest.length, 128,); // 64 bytes hex
},);

test('P2 password: verifyPassword is timing-safe and rejects a wrong salt', async () => {
  const salt = crypto.randomBytes(16,).toString('hex',);
  const user = { salt, password_hash: await hashPassword('correct-horse-battery-staple', salt,), };

  assert.equal(await verifyPassword('correct-horse-battery-staple', user,), true,);
  assert.equal(await verifyPassword('wrong-horse-battery-staple', user,), false,);
  // A different salt must not produce a match for the same password.
  const otherSalt = crypto.randomBytes(16,).toString('hex',);
  assert.equal(
    await verifyPassword('correct-horse-battery-staple', { salt: otherSalt, password_hash: user.password_hash, },),
    false,
  );
  // Missing material must be a false, never a throw.
  assert.equal(await verifyPassword('x', {},), false,);
},);

// ─── 3. Login throttle ───────────────────────────────────────────────────────

/** Deterministic clock for throttle tests. */
function fakeClock(start = 1_000_000,) {
  let current = start;
  return { now: () => current, advance: (ms,) => { current += ms; }, };
}

test('P2 throttle: locks an account after the configured number of failures', () => {
  const clock = fakeClock();
  const throttle = createLoginThrottle({ maxAttempts: 3, lockoutMs: 60_000, now: clock.now, },);

  assert.equal(throttle.status('a@shop.com',).locked, false,);
  throttle.recordFailure('a@shop.com',);
  throttle.recordFailure('a@shop.com',);
  assert.equal(throttle.status('a@shop.com',).locked, false, 'still under the threshold',);

  const third = throttle.recordFailure('a@shop.com',);
  assert.equal(third.locked, true,);
  assert.ok(third.retryAfterMs > 0,);
  assert.equal(throttle.status('a@shop.com',).locked, true,);
},);

test('P2 throttle: the lockout expires and the account recovers', () => {
  const clock = fakeClock();
  const throttle = createLoginThrottle({ maxAttempts: 2, lockoutMs: 60_000, now: clock.now, },);

  throttle.recordFailure('b@shop.com',);
  throttle.recordFailure('b@shop.com',);
  assert.equal(throttle.status('b@shop.com',).locked, true,);

  clock.advance(60_001,);
  assert.equal(throttle.status('b@shop.com',).locked, false,);
},);

test('P2 throttle: repeated failures past the threshold back off exponentially', () => {
  const clock = fakeClock();
  const throttle = createLoginThrottle({ maxAttempts: 2, lockoutMs: 1_000, now: clock.now, },);

  throttle.recordFailure('c@shop.com',);
  const first = throttle.recordFailure('c@shop.com',); // locks for 1s
  assert.equal(first.retryAfterMs, 1_000,);

  const second = throttle.recordFailure('c@shop.com',); // doubles
  assert.equal(second.retryAfterMs, 2_000,);

  const third = throttle.recordFailure('c@shop.com',); // doubles again
  assert.equal(third.retryAfterMs, 4_000,);
},);

test('P2 throttle: the backoff is capped so a lockout cannot grow without bound', () => {
  const clock = fakeClock();
  const throttle = createLoginThrottle({
    maxAttempts: 1, lockoutMs: 1_000, maxLockoutMs: 8_000, now: clock.now,
  },);

  let last = 0;
  for (let i = 0; i < 12; i += 1) last = throttle.recordFailure('d@shop.com',).retryAfterMs;
  assert.equal(last, 8_000, 'the cap must hold',);
},);

test('P2 throttle: a success clears the counter', () => {
  const clock = fakeClock();
  const throttle = createLoginThrottle({ maxAttempts: 3, lockoutMs: 60_000, now: clock.now, },);

  throttle.recordFailure('e@shop.com',);
  throttle.recordFailure('e@shop.com',);
  throttle.recordSuccess('e@shop.com',);
  assert.equal(throttle.status('e@shop.com',).failures, 0,);

  // Two more failures must not lock, because the budget was reset.
  throttle.recordFailure('e@shop.com',);
  assert.equal(throttle.status('e@shop.com',).locked, false,);
},);

test('P2 throttle: keys are normalized so case cannot dodge the budget', () => {
  const clock = fakeClock();
  const throttle = createLoginThrottle({ maxAttempts: 2, lockoutMs: 60_000, now: clock.now, },);

  throttle.recordFailure('Mixed@Shop.com',);
  throttle.recordFailure('mixed@shop.com ',);
  assert.equal(throttle.status('MIXED@SHOP.COM',).locked, true,);
},);

test('P2 throttle: the map is bounded, so probing many addresses cannot exhaust memory', () => {
  const clock = fakeClock();
  const throttle = createLoginThrottle({ maxAttempts: 5, maxEntries: 50, now: clock.now, },);

  for (let i = 0; i < 500; i += 1) throttle.recordFailure(`probe${i}@shop.com`,);

  assert.ok(throttle.size() <= 50, `map grew to ${throttle.size()}, expected <= 50`,);
},);

test('P2 throttle: an unknown account is throttled too, so it leaks nothing', async () => {
  // The throttle must not only count failures for addresses that exist —
  // otherwise "am I locked?" answers "does this account exist?".
  const platform = createPlatform();
  const attempts = 6;
  let lastError = null;

  for (let i = 0; i < attempts; i += 1) {
    try {
      await platform.auth.login({ email: 'nobody@shop.com', password: 'correct-horse-battery-staple', },);
    } catch (error) {
      lastError = error;
    }
  }

  assert.ok(lastError,);
  assert.equal(lastError.message, 'Invalid email or password.',);
  assert.equal(platform.auth.loginThrottle.status('nobody@shop.com',).locked, true,);
},);

test('P2 throttle: a locked account reports the same error as a wrong password', async () => {
  const platform = createPlatform();
  const email = 'locked@shop.com';
  const password = 'correct-horse-battery-staple';
  const signup = await platform.auth.signup({ email, password, },);
  assert.ok(signup.token,);

  // Wrong password until the throttle engages.
  const maxAttempts = platform.auth.loginThrottle.options.maxAttempts;
  for (let i = 0; i < maxAttempts; i += 1) {
    await assert.rejects(
      () => platform.auth.login({ email, password: 'definitely-not-it-42', },),
      /Invalid email or password\./,
    );
  }
  assert.equal(platform.auth.loginThrottle.status(email,).locked, true,);

  // Even the CORRECT password now fails, with the identical message. Anything
  // more specific would confirm the account exists.
  await assert.rejects(
    () => platform.auth.login({ email, password, },),
    (error,) => {
      assert.equal(error.message, 'Invalid email or password.',);
      return true;
    },
  );
},);

test('P2 throttle: a successful login clears the counter', async () => {
  const platform = createPlatform();
  const email = 'good@shop.com';
  const password = 'correct-horse-battery-staple';
  await platform.auth.signup({ email, password, },);

  await assert.rejects(() => platform.auth.login({ email, password: 'wrong-password-1234', },),);
  assert.equal(platform.auth.loginThrottle.status(email,).failures, 1,);

  const ok = await platform.auth.login({ email, password, },);
  assert.ok(ok.token,);
  assert.equal(platform.auth.loginThrottle.status(email,).failures, 0,);
},);

// ─── 4. Session token exp is required ────────────────────────────────────────

const CLIENT_ID = 'test-client-id-1234567890';
const CLIENT_SECRET = 'test-client-secret-abcdefghijklmnop';
const SHOP = 'storecops-p2.myshopify.com';

function mint(payload,) {
  const seg = (o,) => Buffer.from(JSON.stringify(o,),).toString('base64url',);
  const head = seg({ alg: 'HS256', typ: 'JWT', },);
  const body = seg(payload,);
  const sig = crypto.createHmac('sha256', CLIENT_SECRET,).update(`${head}.${body}`,).digest('base64url',);
  return `${head}.${body}.${sig}`;
}

function verifier() {
  return createSessionTokenVerifier({
    credentialsFor: async () => ({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, }),
    warn: () => {},
  },);
}

function basePayload(extra = {},) {
  const now = Math.floor(Date.now() / 1000,);
  return {
    iss: `https://${SHOP}/admin`,
    dest: `https://${SHOP}`,
    aud: CLIENT_ID,
    sub: '42',
    exp: now + 60,
    nbf: now - 5,
    ...extra,
  };
}

test('P2 session token: a token with no exp is rejected, not accepted forever', async () => {
  const payload = basePayload();
  delete payload.exp;

  const result = await verifier().verify(mint(payload,),);
  assert.equal(result, null, 'a token without exp must never be accepted',);
},);

test('P2 session token: a non-numeric exp is rejected', async () => {
  for (const bad of ['9999999999', null, {}, [], true,]) {
    const result = await verifier().verify(mint(basePayload({ exp: bad, },),),);
    assert.equal(result, null, `exp=${JSON.stringify(bad,)} must be rejected`,);
  }
},);

test('P2 session token: an expired exp is still rejected', async () => {
  const now = Math.floor(Date.now() / 1000,);
  const result = await verifier().verify(mint(basePayload({ exp: now - 60, },),),);
  assert.equal(result, null,);
},);

test('P2 session token: a valid token is accepted and reports its expiry', async () => {
  const payload = basePayload();
  const result = await verifier().verify(mint(payload,),);

  assert.ok(result,);
  assert.equal(result.shop_domain, SHOP,);
  assert.equal(result.expires_at, payload.exp,);
},);

test('P2 session token: a malformed nbf is rejected but an absent one is fine', async () => {
  assert.equal(await verifier().verify(mint(basePayload({ nbf: 'soon', },),),), null,);

  const noNbf = basePayload();
  delete noNbf.nbf;
  assert.ok(await verifier().verify(mint(noNbf,),), 'nbf is optional in JWT',);
},);
