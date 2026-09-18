'use strict';

/**
 * Inbound webhook tenant binding and delivery idempotency.
 *
 * THE DEFECT
 * ----------
 * `/webhooks/orders/:store_id` and `/webhooks/returns/:store_id` were HMAC-gated
 * but not tenant-gated. Shopify signs the request BODY with the app's client
 * secret — and that secret is per-APP, not per-shop — so every merchant's delivery
 * verifies against the same key. The `:store_id` in the path was therefore chosen
 * entirely by the caller, and a captured signed body could be POSTed to a different
 * store's path. Because stock decrements downstream of `eventTracker.track`, that
 * injects a purchase *and* corrupts the victim store's inventory.
 *
 * WHAT CAN AND CANNOT BE FIXED
 * ----------------------------
 * The obvious mitigation — "check the payload's `myshopify_domain` against the
 * path" — does not work for these two topics. Verified against Shopify's own docs
 * (`shopify.dev/docs/apps/build/webhooks/delivery-structure`): the body is "the
 * full REST resource payload for the topic", and neither the Order nor the Return
 * REST resource carries a shop field. The only shop identifier Shopify sends for
 * these topics is the `X-Shopify-Shop-Domain` header, and the HMAC does NOT cover
 * headers — the signature is over the raw body only. So whoever replays a body can
 * set that header to anything, and checking it proves nothing.
 *
 * There is consequently no way to bind the FIRST use of a body to a tenant, because
 * the signed material contains no tenant. What *can* be done, and is done here, is
 * to make a captured body consumable exactly ONCE:
 *
 *   - the sha256 of the raw signed body is recorded against the store it was
 *     processed for, and
 *   - a second presentation of that body is refused when it names a different store
 *     (and reported as a cross-tenant event), or short-circuited when it names the
 *     same one.
 *
 * Before this, one body could be replayed an unlimited number of times into an
 * unlimited number of tenants. After, it is usable once and every later attempt is
 * attributed. The residual — an attacker who both intercepts a delivery and wins the
 * race to present it first — is inherent to the signing scheme rather than to this
 * implementation, and is documented rather than papered over.
 *
 * THE SECOND DEFECT THIS FIXES
 * ----------------------------
 * The platform had no delivery idempotency at all on the order path, and
 * `eventTracker.track` inserts unconditionally. Shopify retries a failed delivery
 * **8 times over 4 hours**, so a retried `orders/create` inserted a second
 * `purchase` event and decremented stock a second time. That is an everyday
 * correctness bug, not an attack, and it is fixed by the same record.
 */

const crypto = require('crypto',);

/** How long a delivery digest is remembered. Shopify retries for 4 hours. */
const DELIVERY_TTL_MS = 24 * 60 * 60 * 1000;

/** Sweep at most once per hour per process. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * How far back the sweep walks, in whole days.
 *
 * A day bucket is only swept once it is *entirely* past its window, so a record
 * written moments ago can never be removed. With a 24h TTL that means buckets from
 * the day before yesterday and older; the two extra days of retention are harmless
 * (a digest is a dedupe key, not data) and they err toward remembering a delivery
 * for longer rather than forgetting it too soon.
 */
const SWEEP_LOOKBACK_DAYS = 7;

let lastSweepAt = 0;

/** UTC day bucket for a timestamp — an equality-matchable sweep key. */
function bucketFor(ms,) {
  return new Date(ms,).toISOString().slice(0, 10,);
}

/**
 * sha256 of the raw signed body, hex.
 *
 * Full width, and taken over the *raw* bytes. The previous dedupe helper in
 * `createApp.js` truncated the digest to 16 hex characters and fell back to
 * `JSON.stringify(req.body)` when `rawBody` was missing — a re-serialization is not
 * the signed byte string, and key order is not preserved by a parse/stringify
 * round trip, so two genuinely different deliveries could hash alike and one of
 * them would be silently dropped as a duplicate.
 */
function deliveryDigest(rawBody,) {
  const buf = Buffer.isBuffer(rawBody,)
    ? rawBody
    : Buffer.from(String(rawBody ?? '',), 'utf8',);
  return crypto.createHash('sha256',).update(buf,).digest('hex',);
}

/** Lower-case a shop domain and strip any scheme or trailing slash. */
function normaliseDomain(value,) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value.trim().toLowerCase().replace(/^https?:\/\//, '',).replace(/\/$/, '',);
}

/**
 * The shop a payload claims to come from, if it carries one.
 *
 * This value is inside the body, so the HMAC covers it and it is trustworthy.
 * Order and Return payloads do not have it; the compliance topics do.
 */
function signedShopDomain(payload,) {
  if (!payload || typeof payload !== 'object') return null;
  return normaliseDomain(
    payload.myshopify_domain || payload.shop_domain || payload.shop || payload.domain,
  );
}

function isExpired(row, now,) {
  const expires = Date.parse(row?.expires_at || '',);
  if (!Number.isFinite(expires,)) return false; // undateable — keep it, matching retention's rule
  return expires <= now;
}

/**
 * Compare the tenant claims that are available against the path parameter.
 *
 * The two sources are treated differently on purpose:
 *
 *   - the payload's shop domain comes from the BODY, so the HMAC covers it. A
 *     mismatch there is proof of misrouting and is always refused.
 *   - `X-Shopify-Shop-Domain` is NOT covered by the HMAC, so anyone replaying a
 *     body can set it. It is checked for consistency — it catches a misconfigured
 *     subscription or a hand-rolled request — but it is not a security control and
 *     must not be described as one.
 *
 * A shop that cannot be resolved is NOT refused. Refusing would mean a store whose
 * `integrations.config.shopDomain` is stored in an unexpected shape could never
 * receive a `customers/redact`, turning a data-integrity guard into a compliance
 * failure. Only a POSITIVE mismatch — the claim resolving to a *different* store we
 * actually know — is refused.
 */
async function assertTenant({ store_id, payload, headerShopDomain, resolveShop, },) {
  if (typeof resolveShop !== 'function') return { ok: true, };

  const claims = [
    ['the signed payload shop domain', signedShopDomain(payload,),],
    ['the X-Shopify-Shop-Domain header', normaliseDomain(headerShopDomain,),],
  ];

  for (const [label, domain,] of claims) {
    if (!domain) continue;

    let owner;
    try {
      owner = await resolveShop(domain,);
    } catch (error) {
      // Fail closed: an unresolvable lookup is not evidence of a match.
      return { ok: false, status: 503, reason: 'tenant-lookup-failed', error: error.message, };
    }

    if (owner?.store_id && owner.store_id !== store_id) {
      return {
        ok: false,
        status: 403,
        reason: 'tenant-mismatch',
        error: `Delivery for ${label} "${domain}" does not belong to store ${store_id}.`,
      };
    }
  }

  return { ok: true, };
}

/**
 * Decide whether a signature-verified delivery may be processed for `store_id`, and
 * reserve its digest so it cannot be used again.
 *
 * @returns {Promise<{ok: boolean, duplicate?: boolean, digest?: string, status?: number, reason?: string, error?: string}>}
 *   `ok: true` means process it (unless `duplicate`, in which case answer 200 and
 *   do nothing). `ok: false` carries the HTTP status to answer with.
 */
async function admitDelivery(
  { store, store_id, rawBody, topic, payload, headerShopDomain, resolveShop, onCrossTenant, now = Date.now(), },
) {
  const digest = deliveryDigest(rawBody,);

  // The tenant check runs BEFORE the reservation. A refused delivery must not leave
  // a digest row behind, or it would block the legitimate delivery that follows.
  const claim = await assertTenant({ store_id, payload, headerShopDomain, resolveShop, },);
  if (!claim.ok) return claim;

  let existing;
  try {
    existing = await store.webhookDeliveries.findOne({ digest, },);
  } catch (error) {
    // Fail CLOSED. The digest is the only thing that can bind this delivery to a
    // tenant, and the storage layer is the only thing that can evaluate it. 503
    // rather than 200 because Shopify retries for four hours, so a transient
    // storage failure costs a retry rather than the event — whereas processing an
    // unverifiable delivery could double-count an order or land it in the wrong
    // tenant. Note the same store is used to process the event, so a storage
    // failure would have failed the processing too.
    return { ok: false, status: 503, reason: 'storage-unavailable', error: error.message, };
  }

  if (existing) {
    if (isExpired(existing, now,)) {
      // Past its window, so it no longer blocks anything. Remove it rather than
      // leaving a second row for the same digest behind the insert below.
      try {
        await store.webhookDeliveries.delete(existing._id,);
      } catch {
        // The sweep will collect it; a stale row must not fail the delivery.
      }
    } else if (existing.store_id !== store_id) {
      if (typeof onCrossTenant === 'function') {
        try {
          await onCrossTenant(
            { digest, attributed_to: existing.store_id, presented_as: store_id, topic, },
          );
        } catch {
          // Reporting must never change the decision.
        }
      }
      return {
        ok: false,
        status: 409,
        reason: 'cross-tenant-replay',
        digest,
        error: 'This delivery has already been attributed to a different store.',
      };
    } else {
      return { ok: true, duplicate: true, digest, };
    }
  }

  try {
    await store.webhookDeliveries.insert({
      store_id,
      digest,
      bucket: bucketFor(now,),
      topic: topic || null,
      shop_domain: signedShopDomain(payload,) || normaliseDomain(headerShopDomain,) || null,
      received_at: new Date(now,).toISOString(),
      expires_at: new Date(now + DELIVERY_TTL_MS,).toISOString(),
    },);
  } catch (error) {
    return { ok: false, status: 503, reason: 'storage-unavailable', error: error.message, };
  }

  return { ok: true, duplicate: false, digest, };
}

/**
 * Release a reservation after processing failed, so Shopify's retry is not swallowed.
 *
 * Without this, one transient failure would make the delivery permanently "already
 * seen": the retry would be answered 200 as a duplicate and dropped, losing the
 * event for good. Returns `true` when a row was removed.
 */
async function releaseDelivery({ store, digest, },) {
  try {
    const row = await store.webhookDeliveries.findOne({ digest, },);
    if (!row) return false;
    await store.webhookDeliveries.delete(row._id,);
    return true;
  } catch {
    // Nothing useful to do — the record expires on its own within 24h.
    return false;
  }
}

/**
 * Delete digest records whose window has closed.
 *
 * Keyed on the UTC day `bucket`, which is an indexed column, so each pass is an
 * equality match rather than a table scan. The table grows with order volume, so a
 * `find({})` sweep would degrade exactly as the merchant succeeds — on a timer.
 *
 * @returns {Promise<{swept: number, skipped: boolean}>}
 */
async function sweepExpiredDeliveries({ store, now = Date.now(), force = false, },) {
  if (!force && now - lastSweepAt < SWEEP_INTERVAL_MS) return { swept: 0, skipped: true, };
  lastSweepAt = now;

  let swept = 0;
  // Buckets older than yesterday are wholly past their window, so they are safe to
  // drop without reading the rows.
  for (let back = 2; back <= SWEEP_LOOKBACK_DAYS + 1; back++) {
    const bucket = bucketFor(now - back * DELIVERY_TTL_MS,);
    try {
      swept += await store.webhookDeliveries.deleteMany({ bucket, },);
    } catch {
      // A sweep failure must never fail a webhook; the next pass retries.
    }
  }

  return { swept, skipped: false, };
}

/** Test seam — the once-per-hour throttle is process-global. */
function resetSweepThrottle() {
  lastSweepAt = 0;
}

module.exports = {
  admitDelivery,
  assertTenant,
  bucketFor,
  deliveryDigest,
  isExpired,
  normaliseDomain,
  releaseDelivery,
  resetSweepThrottle,
  signedShopDomain,
  sweepExpiredDeliveries,
  DELIVERY_TTL_MS,
  SWEEP_INTERVAL_MS,
};
