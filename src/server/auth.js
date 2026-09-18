'use strict';

/**
 * Real authentication: signup, login, sessions.
 *
 *  - Passwords hashed with scrypt + per-user random salt.
 *  - Login returns a bearer token persisted in the sessions
 *    collection (survives restarts, expires after sessionTtlDays).
 *  - Every signup provisions its own tenant store + private API key,
 *    so tenants are isolated and the master dev key is no longer the
 *    only way in.
 */

const crypto = require('crypto',);
const { verifyTOTP, } = require('./twoFactorAuth',);
const { createLoginThrottle, } = require('./loginThrottle',);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Password policy.
 *
 * Length + a breached-password check, following NIST SP 800-63B. Deliberately
 * NO composition rules ("one uppercase, one symbol") — they push users toward
 * `Password1!` and measurably reduce entropy. The previous floor was 8
 * characters with no other check, which admitted `password` and `12345678`.
 */
const MIN_PASSWORD = 12;

/**
 * Upper bound exists for a different reason: scrypt cost scales with input
 * length, so an unbounded password is a cheap way to burn server CPU.
 */
const MAX_PASSWORD = 256;

/** Passwords so common that length alone must not admit them.
 *
 * This is a small local list, not a breach corpus — it stops the handful of
 * guesses that appear first in every credential-stuffing dictionary. A real
 * check would query a k-anonymity range API (e.g. Have I Been Pwned's
 * `/range/` endpoint, which never sends the full hash). Worth wiring up before
 * the app takes on paying merchants. */
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'passw0rd', 'p@ssw0rd', 'p@ssword',
  '123456', '1234567', '12345678', '123456789', '1234567890', '12345678901',
  '123456789012', 'qwerty', 'qwertyuiop', 'qwerty123', 'letmein', 'letmein123',
  'welcome', 'welcome1', 'welcome123', 'admin', 'admin123', 'administrator',
  'iloveyou', 'monkey', 'dragon', 'sunshine', 'princess', 'football',
  'baseball', 'superman', 'trustno1', 'abc123', 'abcd1234', 'changeme',
  'changeme123', 'secret', 'secret123', 'default', 'test1234', 'storecops',
  'storecops123', 'shopify', 'shopify123', 'mypassword', 'newpassword',
  'temppassword', 'password!', 'password1!', 'qwerty12345', '1qaz2wsx3edc',
],);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a password reset link stays valid. Short on purpose: the token is
 * a bearer credential delivered over email, so its window is the window an
 * attacker has if the mailbox is compromised. 30 minutes is the ceiling.
 */
const RESET_TTL_MS = 30 * 60 * 1000;

/** SHA-256 of a reset token. The raw token is never stored. */
function hashResetToken(token,) {
  return crypto.createHash('sha256',).update(String(token,),).digest('hex',);
}

/**
 * Check a candidate password against the policy.
 *
 * @returns {{ok: boolean, error: string|null}}
 */
function validatePassword(password, { email = '', } = {},) {
  const value = String(password ?? '',);

  if (value.length < MIN_PASSWORD) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD} characters.`, };
  }
  if (value.length > MAX_PASSWORD) {
    return { ok: false, error: `Password must be at most ${MAX_PASSWORD} characters.`, };
  }

  const lower = value.toLowerCase();
  // A fixed list is trivially evaded by appending digits — `password1234` is
  // the same guess as `password`. Strip leading/trailing non-letters before
  // consulting the list so the obvious padding does not buy a pass.
  const stem = lower.replace(/^[^a-z]+/, '',).replace(/[^a-z]+$/, '',);
  if (COMMON_PASSWORDS.has(lower,) || (stem && COMMON_PASSWORDS.has(stem,))) {
    return { ok: false, error: 'That password is too common. Choose something less predictable.', };
  }

  // Reject a password that is just the account's own address. Cheap to check,
  // and it is the first thing anyone tries.
  const local = String(email || '',).trim().toLowerCase().split('@',)[0];
  if (local && local.length >= 4 && lower === local) {
    return { ok: false, error: 'Password must not be the same as your email address.', };
  }

  return { ok: true, error: null, };
}

/**
 * Derive a password hash. Async on purpose: `crypto.scryptSync` blocks the
 * event loop for the whole derivation (~50-100ms at these parameters), so a
 * handful of concurrent logins would stall every other request on the process.
 * scrypt is deliberately CPU-and-memory-hard, which is exactly what makes the
 * blocking version a denial-of-service lever.
 */
function hashPassword(password, salt,) {
  return new Promise((resolve, reject,) => {
    crypto.scrypt(String(password,), String(salt,), 64, (err, derivedKey,) => {
      if (err) return reject(err,);
      return resolve(derivedKey.toString('hex',),);
    },);
  },);
}

/** Timing-safe comparison of a candidate password against a stored hash. */
async function verifyPassword(password, user,) {
  if (!user?.password_hash || !user?.salt) return false;
  const candidate = Buffer.from(await hashPassword(String(password || '',), user.salt,),);
  const actual = Buffer.from(user.password_hash,);
  return candidate.length === actual.length && crypto.timingSafeEqual(candidate, actual,);
}

function slugify(text,) {
  return String(text || '',)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_',)
    .replace(/^_+|_+$/g, '',)
    .slice(0, 40,);
}

/**
 * Operators who may reach the platform-wide /admin/* surface.
 * Tenant owners are NOT platform admins — they only ever see their own
 * store. Configure with a comma-separated list of operator emails.
 */
function platformAdminEmails() {
  return String(process.env.PLATFORM_ADMIN_EMAILS || '',)
    .split(',',)
    .map((e,) => e.trim().toLowerCase(),)
    .filter(Boolean,);
}

function isPlatformAdminEmail(email,) {
  if (!email) return false;
  return platformAdminEmails().includes(String(email,).toLowerCase(),);
}

/** Strip secrets before a user document leaves the server. */
function publicUser(user,) {
  if (!user) return null;
  // eslint-disable-next-line no-unused-vars
  const { password_hash, salt, api_key, ingest_key, ...safe } = user;
  return safe;
}

/**
 * Minimal projection for cross-tenant listings (e.g. the operator console).
 * Never includes credentials — leaking these would allow account takeover.
 */
function safeUser(user,) {
  if (!user) return null;
  return {
    _id: user._id,
    email: user.email,
    name: user.name,
    role: user.role,
    store_id: user.store_id,
    store_name: user.store_name,
    plan: user.plan,
    platform_admin: user.platform_admin === true,
    created_at: user.created_at || user.createdAt,
  };
}

function createAuthService({ store, config, auditLog, },) {
  /**
   * Per-account brute-force protection. The route-level limiter in
   * `createApp` caps requests per IP; this caps guesses per account, which is
   * the axis a distributed credential-stuffing attack actually moves on.
   */
  const loginThrottle = createLoginThrottle({
    maxAttempts: config?.security?.loginMaxAttempts,
    lockoutMs: config?.security?.loginLockoutMs,
  },);

  async function createSession(user,) {
    const token = crypto.randomBytes(32,).toString('hex',);
    // Default rather than trust: `createPlatform({ config })` replaces the
    // config wholesale, so a caller that omits `sessionTtlDays` used to make
    // this `Date.now() + undefined * DAY_MS` -> NaN -> `new Date(NaN)` ->
    // "Invalid time value" thrown out of signup. A missing TTL should mean the
    // documented default, not an opaque crash on the login path.
    const ttlDays = Number(config?.sessionTtlDays,) || 7;
    const expires_at = new Date(Date.now() + ttlDays * DAY_MS,).toISOString();
    await store.sessions.insert({
      token,
      user_id: user._id,
      email: user.email,
      store_id: user.store_id,
      created_at: new Date().toISOString(),
      expires_at,
    },);
    return { token, expires_at, };
  }

  async function sessionPayload(user, session,) {
    return {
      user: publicUser(user,),
      store_id: user.store_id,
      api_key: user.api_key,
      ingest_key: user.ingest_key,
      token: session.token,
      expires_at: session.expires_at,
    };
  }

  return {
    /** Create an account + tenant store; auto-login on success. */
    async signup({ email, password, name = '', storeName = '', } = {},) {
      email = String(email || '',).trim().toLowerCase();
      if (!EMAIL_RE.test(email,)) throw new Error('A valid email is required.',);

      const policy = validatePassword(password, { email, },);
      if (!policy.ok) throw new Error(policy.error,);

      const existing = await store.users.findOne({ email, },);
      if (existing) throw new Error('An account with this email already exists.',);

      // Unique tenant store id: slug of the store name, de-collided.
      let store_id = slugify(storeName,) || `store_${crypto.randomBytes(3,).toString('hex',)}`;
      while (await store.users.findOne({ store_id, },)) {
        store_id = `${slugify(storeName,) || 'store'}_${crypto.randomBytes(3,).toString('hex',)}`;
      }

      const salt = crypto.randomBytes(16,).toString('hex',);
      const user = await store.users.insert({
        email,
        name: String(name || '',).trim(),
        role: 'admin', // the account owner admins their own tenant
        // Tenant owner !== platform operator. Only emails listed in
        // PLATFORM_ADMIN_EMAILS (and the master key) reach /admin/*.
        platform_admin: isPlatformAdminEmail(email,),
        store_id,
        store_name: String(storeName || store_id,).trim(),
        api_key: `sk_${crypto.randomBytes(18,).toString('hex',)}`,
        // Write-only key used by the browser tracking snippet; it can
        // only POST /track, never read or mutate anything else.
        ingest_key: `pub_${crypto.randomBytes(12,).toString('hex',)}`,
        plan: 'free',
        salt,
        password_hash: await hashPassword(String(password,), salt,),
        created_at: new Date().toISOString(),
      },);
      await auditLog.record(email, 'signup', { store_id, },);

      const session = await createSession(user,);
      return sessionPayload(user, session,);
    },

    /** Verify credentials and open a session. */
    async login({ email, password, totpCode, } = {},) {
      email = String(email || '',).trim().toLowerCase();

      // Brute-force gate. When the account is locked we stop before the
      // credential check — but we still raise the SAME generic error a wrong
      // password would. Reporting "account locked" would confirm the account
      // exists and turn the throttle into an enumeration oracle.
      const gate = loginThrottle.status(email,);
      if (gate.locked) {
        await auditLog.record(email, 'login_throttled', {
          retry_after_ms: gate.retryAfterMs,
          failures: gate.failures,
        },);
        throw new Error('Invalid email or password.',);
      }

      const user = await store.users.findOne({ email, },);
      if (!user || !user.password_hash) {
        // Count failures against unknown accounts too, so the throttle does
        // not itself reveal which addresses exist.
        loginThrottle.recordFailure(email,);
        throw new Error('Invalid email or password.',);
      }

      if (!(await verifyPassword(String(password || '',), user,))) {
        const state = loginThrottle.recordFailure(email,);
        if (state.locked) {
          await auditLog.record(email, 'login_locked', {
            retry_after_ms: state.retryAfterMs,
            failures: state.failures,
          },);
        }
        throw new Error('Invalid email or password.',);
      }

      // Password was correct — but the throttle stays engaged until 2FA has
      // also passed. Resetting here would let an attacker who knows the
      // password keep guessing TOTP codes with a fresh budget every time.
      // 2FA: if enabled, require TOTP code
      if (user.twoFactor?.enabled) {
        if (!totpCode) {
          return { requires2FA: true, message: 'Two-factor authentication code required.', };
        }
        const valid = verifyTOTP(user.twoFactor.secret, totpCode,);
        if (!valid) {
          loginThrottle.recordFailure(email,);
          throw new Error('Invalid two-factor authentication code.',);
        }
      }

      loginThrottle.recordSuccess(email,);

      const session = await createSession(user,);
      return sessionPayload(user, session,);
    },

    /** Resolve a bearer token to a live session, or null. */
    async verify(token,) {
      if (!token) return null;
      const session = await store.sessions.findOne({ token, },);
      if (!session || session.revoked_at) return null;
      if (session.expires_at <= new Date().toISOString()) {
        await this.logout(token,);
        return null;
      }
      const user = await store.users.findById(session.user_id,);
      return user ? { user: publicUser(user,), store_id: session.store_id, } : null;
    },

    /**
     * Destroy a session (idempotent).
     *
     * The row is deleted, not tombstoned. It used to be rewritten with a
     * `revoked_at` flag, which left every logged-out session in the database
     * forever — each one carrying an email, user id and store id, with no
     * retention rule covering it. A deleted row cannot be reused either, so
     * nothing is lost. The `revoked_at` check in `verify` stays for rows
     * written by earlier versions.
     */
    async logout(token,) {
      const session = token ? await store.sessions.findOne({ token, },) : null;
      if (!session) return { ok: true, };

      if (typeof store.sessions.deleteMany === 'function') {
        await store.sessions.deleteMany({ token, },);
      } else {
        await store.sessions.update(session._id, { revoked_at: new Date().toISOString(), },);
      }
      return { ok: true, };
    },

    /**
     * Revoke every session belonging to a user.
     *
     * Needed on password reset: a reset is the recovery path for a compromised
     * account, so any session an attacker already holds has to die with it.
     * @returns {Promise<number>} number of sessions revoked
     */
    async revokeUserSessions(userId,) {
      if (!userId) return 0;
      if (typeof store.sessions.deleteMany !== 'function') return 0;
      const removed = await store.sessions.deleteMany({ user_id: userId, },);
      return Number(removed,) || 0;
    },

    /**
     * Begin a password reset.
     *
     * Always resolves with the same generic message, whether or not the address
     * exists — a different response would turn this endpoint into an account
     * enumeration oracle, and it is unauthenticated by definition.
     *
     * The raw token IS returned to the caller so it can be emailed, but the
     * route must never echo it to the client. Only the SHA-256 of the token is
     * persisted, so a database leak does not yield usable reset links.
     *
     * @returns {Promise<{ok: true, message: string, token?: string, expires_at?: string, user?: object}>}
     */
    async requestPasswordReset({ email, } = {},) {
      const generic = {
        ok: true,
        message: 'If an account exists for that address, a reset link has been sent.',
      };

      const normalized = String(email || '',).trim().toLowerCase();
      if (!EMAIL_RE.test(normalized,)) return generic;

      const user = await store.users.findOne({ email: normalized, },);
      // Unknown address: identical response, no token, nothing recorded.
      if (!user || !user.password_hash) return generic;

      const token = crypto.randomBytes(32,).toString('hex',);
      const expires_at = new Date(Date.now() + RESET_TTL_MS,).toISOString();

      // Invalidate any outstanding reset for this user before issuing a new
      // one, so an older email cannot still be redeemed.
      await store.passwordResets.deleteMany({ user_id: user._id, },);
      await store.passwordResets.insert({
        user_id: user._id,
        email: normalized,
        token_hash: hashResetToken(token,),
        expires_at,
        created_at: new Date().toISOString(),
      },);

      await auditLog.record(normalized, 'password_reset_requested', { user_id: user._id, },);

      return { ...generic, token, expires_at, user, };
    },

    /**
     * Complete a password reset with a token from `requestPasswordReset`.
     *
     * Single use: the row is deleted the moment it is redeemed, so a replayed
     * link fails even inside its validity window. Every existing session is
     * revoked, because a reset is the recovery path for a compromised account.
     */
    async resetPassword({ token, password, } = {},) {
      const raw = String(token || '',).trim();
      if (!raw) throw new Error('A reset token is required.',);

      const policy = validatePassword(password,);
      if (!policy.ok) throw new Error(policy.error,);

      const record = await store.passwordResets.findOne({ token_hash: hashResetToken(raw,), },);
      // One message for missing, already-used and expired tokens alike — the
      // caller should not be able to tell which.
      const invalid = new Error('That reset link is invalid or has expired. Request a new one.',);
      if (!record) throw invalid;

      if (record.expires_at <= new Date().toISOString()) {
        await store.passwordResets.deleteMany({ token_hash: record.token_hash, },);
        throw invalid;
      }

      const user = await store.users.findById(record.user_id,);
      if (!user) {
        await store.passwordResets.deleteMany({ token_hash: record.token_hash, },);
        throw invalid;
      }

      const salt = crypto.randomBytes(16,).toString('hex',);
      await store.users.update(user._id, {
        salt,
        password_hash: await hashPassword(String(password,), salt,),
        password_changed_at: new Date().toISOString(),
      },);

      // Burn the token, then drop every session the account had.
      await store.passwordResets.deleteMany({ token_hash: record.token_hash, },);
      const revoked = await this.revokeUserSessions(user._id,);

      await auditLog.record(user.email, 'password_reset_completed', {
        user_id: user._id,
        sessions_revoked: revoked,
      },);

      return { ok: true, sessions_revoked: revoked, };
    },

    /** Change the password for a signed-in user, verifying the current one. */
    async changePassword({ userId, currentPassword, newPassword, } = {},) {
      const user = userId ? await store.users.findById(userId,) : null;
      if (!user) throw new Error('Account not found.',);

      if (!(await verifyPassword(String(currentPassword || '',), user,))) {
        throw new Error('Current password is incorrect.',);
      }

      const policy = validatePassword(newPassword, { email: user.email, },);
      if (!policy.ok) throw new Error(policy.error,);

      const salt = crypto.randomBytes(16,).toString('hex',);
      await store.users.update(user._id, {
        salt,
        password_hash: await hashPassword(String(newPassword,), salt,),
        password_changed_at: new Date().toISOString(),
      },);

      await auditLog.record(user.email, 'password_changed', { user_id: user._id, },);
      return { ok: true, };
    },

    /**
     * Open a session for an already-resolved user.
     * Exposed for flows that authenticate a user outside of login()
     * (e.g. Shopify embedded auth after session-token verification).
     */
    async createSession(user,) {
      if (!user || !user._id) throw new Error('A valid user is required to open a session.',);
      return createSession(user,);
    },

    /**
     * Short-lived placeholder session for a Shopify shop that has not
     * completed signup yet. Resolves to no user, so it grants no access —
     * it only lets the client carry state through the onboarding flow.
     */
    async createTempSession(shopDomain,) {
      const domain = slugify(shopDomain,) || 'unknown';
      const token = crypto.randomBytes(32,).toString('hex',);
      const expires_at = new Date(Date.now() + 60 * 60 * 1000,).toISOString(); // 1 hour
      await store.sessions.insert({
        token,
        user_id: null, // deliberately unresolvable — grants no access
        email: `${domain}@pending.shopify`,
        store_id: null,
        shop_domain: String(shopDomain || '',).toLowerCase(),
        pending: true,
        created_at: new Date().toISOString(),
        expires_at,
      },);
      return { token, expires_at, shop_domain: String(shopDomain || '',).toLowerCase(), pending: true, };
    },

    /** True when the identity may reach platform-wide operator surfaces. */
    isPlatformAdmin(user,) {
      if (!user) return false;
      return user.platform_admin === true || isPlatformAdminEmail(user.email,);
    },

    /**
     * Per-account brute-force throttle. Exposed for tests and for operators
     * who need to inspect or clear a stuck account.
     */
    loginThrottle,

    /** Find the tenant owning a private API key (for the gateway). */
    async userByApiKey(apiKey,) {
      if (!apiKey) return null;
      const user = await store.users.findOne({ api_key: apiKey, },);
      return publicUser(user,);
    },

    /** Resolve the public write-only ingest key (tracking snippet). */
    async userByIngestKey(ingestKey,) {
      if (!ingestKey) return null;
      const user = await store.users.findOne({ ingest_key: ingestKey, },);
      return publicUser(user,);
    },
  };
}

module.exports = {
  createAuthService,
  hashPassword,
  verifyPassword,
  validatePassword,
  MIN_PASSWORD,
  publicUser,
  safeUser,
  isPlatformAdminEmail,
};
