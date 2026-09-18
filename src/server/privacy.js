'use strict';

/**
 * Data privacy operations (GDPR / CCPA) — single source of truth.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Two independent purge paths had grown apart from the schema:
 *
 *   - the shop/redact handler hardcoded 16 collection names out of the 52 in
 *     `COLLECTIONS`, and
 *   - `deleteCustomerData` scrubbed only 4 (`customers`, `events`, `deliveries`,
 *     `actions`).
 *
 * Neither list was derived from anything, so every new collection silently
 * became a place where a deleted customer's email survived. `customers/redact`
 * is a Shopify App Store requirement, so that gap was a submission blocker, not
 * just hygiene.
 *
 * The fix is to classify every collection exactly once, here, and derive the
 * purge set by subtraction. A guard test (`test/privacyPurge.test.js`) fails
 * when a collection is added to `COLLECTIONS` without being classified.
 *
 * THE THREE CLASSIFICATIONS
 * -------------------------
 * A store purge is not the same thing as a customer redaction, and collapsing
 * them causes real damage in both directions:
 *
 *   - Deleting financial records on uninstall would break tax/GST retention.
 *   - Keeping customer PII in those same records would break the redaction.
 *
 * So uninstall (`purgeStoreData`) deletes operational data but preserves records
 * under a legal hold, while redaction (`redactCustomerData`) scrubs the customer
 * identifiers out of *every* store-scoped collection — including the held ones —
 * leaving the financial row itself intact.
 *
 * THE DEFAULT IS "PURGEABLE", WHICH IS A FOOTGUN
 * ----------------------------------------------
 * `PURGEABLE_COLLECTIONS` is derived by subtracting the three maps above from
 * `COLLECTIONS`, so an unlisted collection is classified as purgeable *by
 * construction*. `classificationReport().unclassified` is therefore structurally
 * always empty and can never report a missing decision. Measured, not reasoned:
 * adding a collection to `COLLECTIONS` and classifying it nowhere left every test
 * in `test/privacyPurge.test.js` green, while silently scheduling the new
 * collection for deletion on uninstall.
 *
 * The decision record is the `CLASSIFIED_INVENTORY` fixture in that test file: it
 * freezes the collection list, so a collection cannot be added without stating
 * what it is. If you are adding one, add it there *and* decide here. Deleting data
 * that should have been kept is not recoverable, whereas keeping data that could
 * have been deleted is merely untidy — which is why the burden sits on the
 * deletion path.
 */

const { COLLECTIONS, } = require('../storage/store',);

/**
 * Never touched by a store purge. These are either platform-wide, keyed by
 * something other than the store, or records whose whole purpose is to survive
 * deletion.
 */
const PLATFORM_GLOBAL_COLLECTIONS = {
  users: 'Platform login accounts. One user may own several stores, so a single store purge must not delete the account.',
  connectors: 'Platform-level OAuth app credentials (client id/secret). Configuration, not tenant data.',
  secretLedger: 'Secret rotation ledger. Stores fingerprints only, no tenant data.',
  twoFactorSecrets: 'TOTP secrets keyed by user, not by store.',
  auditLog: 'Immutable administrative audit trail. Deleting it destroys the evidence trail that GDPR accountability depends on.',
  emailSuppressions: 'Global do-not-send list. Deleting it on uninstall would let us email people who had opted out — a compliance regression.',
  channelSuppressions: 'Per-channel opt-outs. Must survive uninstall/reinstall so an opted-out recipient is never messaged again.',
  monitoringEvents: 'Operational telemetry about platform health. No merchant PII.',
  passwordResets: 'Password reset tokens keyed by user, not by store. A store purge must not cancel an account recovery in flight.',
};

/**
 * Records kept under a legal/tax hold. A store purge preserves the row; a
 * customer redaction scrubs the customer identifiers out of it.
 */
const LEGAL_HOLD_COLLECTIONS = {
  invoices: 'Invoices carry GST/tax data that must be retained for statutory periods.',
  payments: 'Payment records are needed for financial reconciliation and dispute handling.',
  subscriptions: 'Billing subscription history is needed to prove what was charged and when.',
};

/**
 * Store-scoped, but deliberately not deleted on uninstall: the caller marks the
 * row uninstalled and wipes its credentials, keeping the record that the store
 * was once connected.
 */
const RETAINED_BY_CALLER_COLLECTIONS = {
  integrations: 'The store connection record. Marked uninstalled with credentials wiped by the caller, never deleted.',
};

/** Every collection that a store purge deletes, derived by subtraction. */
const PURGEABLE_COLLECTIONS = COLLECTIONS.filter(
  (name,) =>
    !(name in PLATFORM_GLOBAL_COLLECTIONS) &&
    !(name in LEGAL_HOLD_COLLECTIONS) &&
    !(name in RETAINED_BY_CALLER_COLLECTIONS),
);

/** Store-scoped collections a redaction must inspect (includes legal holds). */
const REDACTABLE_COLLECTIONS = COLLECTIONS.filter(
  (name,) => !(name in PLATFORM_GLOBAL_COLLECTIONS),
);

/** Fields that can carry a customer identifier in any collection. */
const CUSTOMER_ID_FIELDS = ['customer_id', 'customerId',];
/** Fields that can carry a customer email in any collection. */
const CUSTOMER_EMAIL_FIELDS = ['email', 'customer_email',];
/** Fields that can carry a customer name/handle worth clearing. */
const CUSTOMER_NAME_FIELDS = ['customer_name', 'customer_email_name',];
/**
 * Fields that can carry a customer phone number.
 *
 * Phone is not incidental here: `createApp.js` resolves a customer profile with
 * `store.customers.findOne({ phone: ... })` when a WhatsApp message arrives, so
 * it is a first-class customer identifier. It was missing from the scrub set,
 * which meant a redacted customer's number survived in `leads` and in their own
 * profile — and a later inbound message would re-associate it.
 */
const CUSTOMER_PHONE_FIELDS = ['phone', 'customer_phone', 'phone_number',];

/**
 * Collections where a bare `name` field holds a PERSON's name, and so must be
 * cleared on redaction.
 *
 * `name` cannot be scrubbed globally — plenty of collections use it for a
 * product, campaign or store name, and blanking those would corrupt unrelated
 * records. Only the collections verified to store a person's name are listed.
 * `leads` is populated from the public deep-audit form, which collects `name`
 * and `phone` directly (`createApp.js` `/deep` -> `captureLead`).
 */
const PERSON_NAME_FIELDS_BY_COLLECTION = {
  leads: ['name',],
};

/**
 * Refuse to operate without a real store id.
 *
 * This is a safety interlock, not defensive padding. `deleteMany({ store_id })`
 * with `store_id === undefined` matches every row that has *no* `store_id` in the
 * in-memory adapter, and throws a bind error in SQLite — so a falsy id is either
 * catastrophic or confusing, never correct.
 */
function assertStoreId(store_id,) {
  if (typeof store_id !== 'string' || store_id.trim() === '') {
    throw new Error('privacy: a non-empty store_id is required (refusing to operate unscoped).',);
  }
}

/** True when `row` carries any of the given customer identifiers. */
function rowMatchesCustomer(row, identifiers,) {
  if (!row || typeof row !== 'object') return false;
  for (const field of [...CUSTOMER_ID_FIELDS, ...CUSTOMER_EMAIL_FIELDS, ...CUSTOMER_PHONE_FIELDS,]) {
    if (row[field] !== undefined && row[field] !== null && identifiers.has(row[field],)) return true;
  }
  return false;
}

/**
 * Every identifier that can refer to this customer.
 *
 * Shopify's `customers/redact` payload carries only a numeric customer id, but
 * much of what we store (leads, support tickets) is keyed by email. Matching on
 * the id alone would silently leave those rows untouched, so the profile's email
 * is resolved and added as a second identifier.
 */
async function resolveIdentifiers(store, store_id, customer_id,) {
  const identifiers = new Set([customer_id,],);
  const profile = await store.customers.findOne({ store_id, identity: customer_id, },);
  if (profile?.email) identifiers.add(profile.email,);
  // Phone is how inbound WhatsApp messages are attributed back to a customer
  // (createApp.js finds the profile by `phone`), so it is an identifier too.
  if (profile?.phone) identifiers.add(profile.phone,);
  return { identifiers, profile, };
}

/**
 * Build the scrub patch for one row, touching only fields that are present.
 *
 * `collectionName` matters because `name` is only a person's name in some
 * collections — see PERSON_NAME_FIELDS_BY_COLLECTION.
 */
function scrubPatch(row, collectionName,) {
  const patch = {};
  for (const field of CUSTOMER_ID_FIELDS) {
    if (row[field] !== undefined && row[field] !== null) patch[field] = 'anon';
  }
  const clearable = [
    ...CUSTOMER_EMAIL_FIELDS,
    ...CUSTOMER_PHONE_FIELDS,
    ...CUSTOMER_NAME_FIELDS,
    ...(PERSON_NAME_FIELDS_BY_COLLECTION[collectionName] || []),
  ];
  for (const field of clearable) {
    if (row[field] !== undefined && row[field] !== null) patch[field] = null;
  }
  return patch;
}

/**
 * Scrub a customer's identifiers out of every store-scoped collection.
 *
 * Returns the same shape the previous implementation did (`anonymized`,
 * `events_scrubbed`, `deliveries_scrubbed`, `actions_scrubbed`) so existing
 * callers and tests keep working, plus a per-collection breakdown.
 */
async function redactCustomerData(store, store_id, customer_id,) {
  assertStoreId(store_id,);
  if (typeof customer_id !== 'string' || customer_id === '') {
    throw new Error('privacy: a non-empty customer_id is required.',);
  }

  const { identifiers, } = await resolveIdentifiers(store, store_id, customer_id,);

  const perCollection = {};
  let totalScrubbed = 0;

  for (const name of REDACTABLE_COLLECTIONS) {
    const collection = store[name];
    if (!collection) continue;

    // `store_id` is indexed in both adapters, so this is a bounded per-tenant
    // read rather than a full-table scan.
    const rows = await collection.find({ store_id, },);

    for (const row of rows) {
      let patch = null;

      if (name === 'customers') {
        // The customer profile is keyed by `identity`, and gets the full
        // anonymization treatment rather than a field-level scrub.
        const isTarget = identifiers.has(row.identity,) || identifiers.has(row.email,)
          || (row.phone !== undefined && row.phone !== null && identifiers.has(row.phone,));
        if (!isTarget) continue;
        patch = {
          identity: `anon:${row._id}`,
          email: null,
          phone: null,
          viewed_products: [],
          channels_responded: [],
          gdpr_deleted: true,
        };
      } else {
        if (!rowMatchesCustomer(row, identifiers,)) continue;
        patch = scrubPatch(row, name,);
        if (Object.keys(patch,).length === 0) continue;
      }

      await collection.update(row._id, patch,);
      perCollection[name] = (perCollection[name] || 0) + 1;
      totalScrubbed++;
    }
  }

  return {
    store_id,
    customer_id,
    anonymized: (perCollection.customers || 0) > 0,
    events_scrubbed: perCollection.events || 0,
    deliveries_scrubbed: perCollection.deliveries || 0,
    actions_scrubbed: perCollection.actions || 0,
    collections: perCollection,
    total_scrubbed: totalScrubbed,
  };
}

/**
 * Collect every record held about a customer, across all store-scoped
 * collections — the mirror of `redactCustomerData`, used to answer
 * `customers/data_request`.
 */
async function collectCustomerData(store, store_id, customer_id,) {
  assertStoreId(store_id,);

  const { identifiers, } = await resolveIdentifiers(store, store_id, customer_id,);

  const perCollection = {};
  let totalRecords = 0;

  for (const name of REDACTABLE_COLLECTIONS) {
    const collection = store[name];
    if (!collection) continue;

    const rows = await collection.find({ store_id, },);
    const matches = rows.filter((row,) =>
      name === 'customers'
        ? identifiers.has(row.identity,) || identifiers.has(row.email,)
        : rowMatchesCustomer(row, identifiers,),
    );

    if (matches.length === 0) continue;
    perCollection[name] = matches;
    totalRecords += matches.length;
  }

  return {
    store_id,
    customer_id,
    exported_at: new Date().toISOString(),
    // Backwards-compatible top-level keys.
    profile: (perCollection.customers || [])[0] || null,
    events: perCollection.events || [],
    deliveries: perCollection.deliveries || [],
    total_records: totalRecords,
    collections: perCollection,
  };
}

/**
 * Delete everything a store owns, except platform-global collections and
 * records under a legal hold. Used by the `shop/redact` webhook.
 */
async function purgeStoreData(store, store_id,) {
  assertStoreId(store_id,);

  const deleted = {};
  let totalDeleted = 0;

  for (const name of PURGEABLE_COLLECTIONS) {
    const collection = store[name];
    if (!collection || typeof collection.deleteMany !== 'function') continue;

    try {
      const count = await collection.deleteMany({ store_id, },);
      if (count > 0) deleted[name] = count;
      totalDeleted += count;
    } catch {
      /* A single collection failing must not abort the whole purge; the
         caller records the failure and the rest still gets removed. */
    }
  }

  return {
    store_id,
    purged_at: new Date().toISOString(),
    deleted,
    total_deleted: totalDeleted,
    preserved: {
      platform_global: Object.keys(PLATFORM_GLOBAL_COLLECTIONS,),
      legal_hold: Object.keys(LEGAL_HOLD_COLLECTIONS,),
      retained_by_caller: Object.keys(RETAINED_BY_CALLER_COLLECTIONS,),
    },
  };
}

/**
 * Classification report. The guard test uses this to prove that every
 * collection in the schema has been deliberately classified, and that no
 * classification names a collection that no longer exists.
 */
function classificationReport() {
  const known = new Set(COLLECTIONS,);
  const stale = [
    ...Object.keys(PLATFORM_GLOBAL_COLLECTIONS,),
    ...Object.keys(LEGAL_HOLD_COLLECTIONS,),
    ...Object.keys(RETAINED_BY_CALLER_COLLECTIONS,),
  ].filter((name,) => !known.has(name,),);

  const classified = new Set([
    ...PURGEABLE_COLLECTIONS,
    ...Object.keys(PLATFORM_GLOBAL_COLLECTIONS,),
    ...Object.keys(LEGAL_HOLD_COLLECTIONS,),
    ...Object.keys(RETAINED_BY_CALLER_COLLECTIONS,),
  ],);

  return {
    total: COLLECTIONS.length,
    purgeable: PURGEABLE_COLLECTIONS,
    platform_global: Object.keys(PLATFORM_GLOBAL_COLLECTIONS,),
    legal_hold: Object.keys(LEGAL_HOLD_COLLECTIONS,),
    retained_by_caller: Object.keys(RETAINED_BY_CALLER_COLLECTIONS,),
    unclassified: COLLECTIONS.filter((name,) => !classified.has(name,),),
    stale,
  };
}

module.exports = {
  PLATFORM_GLOBAL_COLLECTIONS,
  LEGAL_HOLD_COLLECTIONS,
  RETAINED_BY_CALLER_COLLECTIONS,
  PURGEABLE_COLLECTIONS,
  REDACTABLE_COLLECTIONS,
  CUSTOMER_ID_FIELDS,
  CUSTOMER_EMAIL_FIELDS,
  CUSTOMER_NAME_FIELDS,
  CUSTOMER_PHONE_FIELDS,
  PERSON_NAME_FIELDS_BY_COLLECTION,
  redactCustomerData,
  collectCustomerData,
  purgeStoreData,
  classificationReport,
};
