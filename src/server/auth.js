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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

function hashPassword(password, salt,) {
  return crypto.scryptSync(password, salt, 64,).toString('hex',);
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
  async function createSession(user,) {
    const token = crypto.randomBytes(32,).toString('hex',);
    const expires_at = new Date(Date.now() + config.sessionTtlDays * DAY_MS,).toISOString();
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
      if (!password || String(password,).length < MIN_PASSWORD) {
        throw new Error(`Password must be at least ${MIN_PASSWORD} characters.`,);
      }

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
        password_hash: hashPassword(String(password,), salt,),
        created_at: new Date().toISOString(),
      },);
      await auditLog.record(email, 'signup', { store_id, },);

      const session = await createSession(user,);
      return sessionPayload(user, session,);
    },

    /** Verify credentials and open a session. */
    async login({ email, password, totpCode, } = {},) {
      email = String(email || '',).trim().toLowerCase();
      const user = await store.users.findOne({ email, },);
      if (!user || !user.password_hash) {
        throw new Error('Invalid email or password.',);
      }

      const candidate = Buffer.from(hashPassword(String(password || '',), user.salt,),);
      const actual = Buffer.from(user.password_hash,);
      if (candidate.length !== actual.length || !crypto.timingSafeEqual(candidate, actual,)) {
        throw new Error('Invalid email or password.',);
      }

      // 2FA: if enabled, require TOTP code
      if (user.twoFactor?.enabled) {
        if (!totpCode) {
          return { requires2FA: true, message: 'Two-factor authentication code required.', };
        }
        const valid = verifyTOTP(user.twoFactor.secret, totpCode,);
        if (!valid) {
          throw new Error('Invalid two-factor authentication code.',);
        }
      }

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

    /** Destroy a session (idempotent). */
    async logout(token,) {
      const session = token ? await store.sessions.findOne({ token, },) : null;
      if (!session) return { ok: true, };

      // Sessions are immutable documents; drop expired token rows by
      // rewriting them with a revoked flag so nothing is ever reused.
      await store.sessions.update(session._id, { revoked_at: new Date().toISOString(), },);
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
  publicUser,
  safeUser,
  isPlatformAdminEmail,
};
