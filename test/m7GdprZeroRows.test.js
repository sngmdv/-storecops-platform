'use strict';

/**
 * M7 — "GDPR zero-rows".
 *
 * WHAT WAS WRONG WITH THE EXISTING COVERAGE
 * -----------------------------------------
 * `test/privacyPurge.test.js` has a test named "scrubs the identifier from
 * every collection that can hold it". It seeds **12** of the 53 collections and
 * then asserts on those same 12. That is a tautology: it verifies the
 * collections the author thought of, which is precisely the failure mode that
 * created the original defect. The shop/redact handler had hardcoded 16 of 52
 * collections, and `deleteCustomerData` scrubbed 4 — nobody noticed because
 * nothing derived the expectation from the schema.
 *
 * WHAT THIS DOES INSTEAD
 * ----------------------
 * The seeded set is derived from `COLLECTIONS` itself, so a collection added
 * tomorrow is covered automatically. After the operation, every collection is
 * scanned and asserted to hold ZERO rows still carrying the identifier.
 *
 * A control test plants a survivor and confirms the scanner actually finds it,
 * so the zero-row assertion cannot pass vacuously.
 */

const test = require('node:test',);
const assert = require('node:assert',);

const { createStore, COLLECTIONS, } = require('../src/storage/store',);
const {
  purgeStoreData,
  redactCustomerData,
  collectCustomerData,
  PURGEABLE_COLLECTIONS,
  REDACTABLE_COLLECTIONS,
  PLATFORM_GLOBAL_COLLECTIONS,
  LEGAL_HOLD_COLLECTIONS,
  RETAINED_BY_CALLER_COLLECTIONS,
  CUSTOMER_ID_FIELDS,
  CUSTOMER_EMAIL_FIELDS,
  CUSTOMER_PHONE_FIELDS,
  PERSON_NAME_FIELDS_BY_COLLECTION,
} = require('../src/server/privacy',);

const STORE = 'store_m7';
const OTHER = 'store_m7_other';
const CUST = 'cust_m7_1';
const EMAIL = 'm7-customer@example.com';
const PHONE = '+919876500000';
const PERSON_NAME = 'Jane M7';

/**
 * Which identifier field (if any) a row still exposes.
 *
 * Covers id, email, phone and — for the collections where `name` is a person's
 * name — the name. Phone and `leads.name` were both surviving a redaction
 * before this test existed: the module scrubbed `customer_name` but `leads`
 * stores a bare `name`, and phone was not in the scrub set at all.
 */
function leakedField(row, collectionName,) {
  for (const field of [...CUSTOMER_ID_FIELDS, 'identity',]) {
    if (row[field] === CUST) return `${field}=customer_id`;
  }
  for (const field of CUSTOMER_EMAIL_FIELDS) {
    if (row[field] === EMAIL) return `${field}=email`;
  }
  for (const field of CUSTOMER_PHONE_FIELDS) {
    if (row[field] === PHONE) return `${field}=phone`;
  }
  for (const field of (PERSON_NAME_FIELDS_BY_COLLECTION[collectionName] || [])) {
    if (row[field] === PERSON_NAME) return `${field}=name`;
  }
  return null;
}

/**
 * Seed EVERY collection with a row that carries both identifiers.
 *
 * Derived from COLLECTIONS, never from a hand-written list — that is the whole
 * point. Each row also carries a non-identifying field so we can prove the
 * redaction scrubbed rather than deleted.
 *
 * `customers` is seeded with `identity` because that is its real key
 * (customerProfile.js inserts `identity`, never `customer_id`). Seeding it
 * generically made the profile unresolvable, which made the redaction look
 * broken when it was in fact correct.
 */
async function seedEveryCollection(store, storeId,) {
  const seeded = [];
  for (const name of COLLECTIONS) {
    const collection = store[name];
    if (!collection || typeof collection.insert !== 'function') continue;
    if (name === 'customers') {
      await collection.insert({
        store_id: storeId,
        identity: CUST,
        email: EMAIL,
        phone: PHONE,
        total_spent: 42,
        viewed_products: [],
        channels_responded: [],
      },);
    } else {
      await collection.insert({
        store_id: storeId,
        customer_id: CUST,
        email: EMAIL,
        phone: PHONE,
        ...(PERSON_NAME_FIELDS_BY_COLLECTION[name]
          ? Object.fromEntries(PERSON_NAME_FIELDS_BY_COLLECTION[name].map((f,) => [f, PERSON_NAME,],),)
          : {}),
        amount: 42,
      },);
    }
    seeded.push(name,);
  }
  return seeded;
}

/**
 * Every row across the given collections still exposing the identifier.
 *
 * Callers pass an explicit collection list rather than always scanning all 53:
 * platform-global collections are out of a customer redaction by design, so
 * including them here would only ever produce a permanent, meaningless failure.
 * The complement is pinned exactly by the "scoped to redactable" test below, so
 * nothing escapes the two together.
 */
async function survivors(store, storeId, collections = COLLECTIONS,) {
  const leaks = [];
  for (const name of collections) {
    const collection = store[name];
    if (!collection || typeof collection.find !== 'function') continue;
    const rows = await collection.find({ store_id: storeId, },);
    for (const row of rows) {
      const field = leakedField(row, name,);
      if (field) leaks.push(`${name}: ${field}`,);
    }
  }
  return leaks;
}

// ── Redaction ───────────────────────────────────────────────────────────────

test('M7: customer redaction leaves ZERO rows exposing the identifier, across all collections', async () => {
  const store = createStore();
  const seeded = await seedEveryCollection(store, STORE,);
  assert.ok(
    seeded.length >= 50,
    `expected to seed every collection, only reached ${seeded.length}`,
  );

  // Establish the precondition: before redaction the identifier is everywhere.
  const before = await survivors(store, STORE,);
  assert.ok(before.length >= 50, `precondition failed: only ${before.length} seeded rows found`,);

  const result = await redactCustomerData(store, STORE, CUST,);
  assert.equal(result.anonymized, true, 'the customer profile must be anonymized',);

  const leaks = await survivors(store, STORE, REDACTABLE_COLLECTIONS,);
  assert.deepEqual(
    leaks,
    [],
    `redactable collections still exposing the customer after a customers/redact:\n${leaks.join('\n',)}`,
  );

  // And nothing outside the documented platform-global set may be skipped.
  const allLeaks = await survivors(store, STORE,);
  const outsideScope = allLeaks.filter((l,) => {
    const name = l.split(':',)[0].trim();
    return !(name in PLATFORM_GLOBAL_COLLECTIONS);
  },);
  assert.deepEqual(
    outsideScope,
    [],
    `rows survived outside the documented platform-global set:\n${outsideScope.join('\n',)}`,
  );
},);

test('M7 control: the survivor scanner actually detects a planted leak', async () => {
  const store = createStore();

  // A row that the redaction deliberately cannot match, planted AFTER the
  // scan set is defined. If the scanner were vacuous this would pass silently.
  await store.events.insert({ store_id: STORE, customer_id: CUST, email: EMAIL, },);
  const leaks = await survivors(store, STORE,);
  assert.ok(
    leaks.length > 0,
    'the scanner must report a row that still holds the identifier — otherwise the zero-row test proves nothing',
  );
},);

test('M7: redaction preserves non-identifying fields instead of deleting rows', async () => {
  const store = createStore();
  await store.invoices.insert({
    store_id: STORE, customer_id: CUST, email: EMAIL, amount: 42,
  },);

  await redactCustomerData(store, STORE, CUST,);

  const invoices = await store.invoices.find({ store_id: STORE, },);
  assert.equal(invoices.length, 1, 'a legal-hold row must survive a redaction',);
  assert.equal(invoices[0].amount, 42, 'non-identifying fields must be preserved',);
  assert.equal(invoices[0].customer_id, 'anon', 'the identifier must be replaced',);
  assert.equal(invoices[0].email, null,);
},);

test('M7: redaction is idempotent and does not touch another tenant', async () => {
  const store = createStore();
  await seedEveryCollection(store, STORE,);
  await seedEveryCollection(store, OTHER,);

  await redactCustomerData(store, STORE, CUST,);
  const second = await redactCustomerData(store, STORE, CUST,);

  assert.equal(second.total_scrubbed, 0, 'a second redaction must find nothing left to scrub',);

  const otherLeaks = await survivors(store, OTHER,);
  assert.ok(
    otherLeaks.length >= 50,
    'the same customer id in another tenant must be completely unaffected',
  );
},);

test('M7: redaction is scoped to the collections the schema says are redactable', async () => {
  const store = createStore();
  await seedEveryCollection(store, STORE,);

  await redactCustomerData(store, STORE, CUST,);

  // Platform-global collections are intentionally out of scope. Pin the exact
  // set so that widening or narrowing it is a deliberate, visible change.
  //
  // NOTE: this is where an erasure request can still leave the address behind.
  // `emailSuppressions` / `channelSuppressions` hold a customer's email if they
  // opted out, and the module deliberately keeps them so the opt-out continues
  // to be honoured. That is the right call for consent, but it does mean a
  // literal "zero rows holding this address" reading of GDPR is not met for
  // those two. The usual resolution is to store a hash rather than the address.
  const stillHolding = [];
  for (const name of COLLECTIONS) {
    if (!(name in PLATFORM_GLOBAL_COLLECTIONS)) continue;
    const rows = await store[name].find({ store_id: STORE, },);
    if (rows.some((r,) => leakedField(r, name,),)) stillHolding.push(name,);
  }

  assert.deepEqual(
    stillHolding.sort(),
    Object.keys(PLATFORM_GLOBAL_COLLECTIONS,).sort(),
    'only platform-global collections may retain the identifier — and all of them do, by design',
  );

  // Every redactable collection, by contrast, must be clean.
  for (const name of REDACTABLE_COLLECTIONS) {
    const rows = await store[name].find({ store_id: STORE, },);
    for (const row of rows) {
      assert.equal(
        leakedField(row, name,),
        null,
        `${name} is redactable but still exposes the customer`,
      );
    }
  }
},);

// ── Purge (shop/redact) ─────────────────────────────────────────────────────

test('M7: shop purge leaves ZERO rows for that store, across all purgeable collections', async () => {
  const store = createStore();
  const seeded = await seedEveryCollection(store, STORE,);
  await seedEveryCollection(store, OTHER,);

  const result = await purgeStoreData(store, STORE,);

  assert.ok(result.total_deleted > 0, 'the purge must have deleted something',);

  // Zero rows anywhere in the store's purgeable surface.
  const leftover = [];
  for (const name of PURGEABLE_COLLECTIONS) {
    const rows = await store[name].find({ store_id: STORE, },);
    if (rows.length > 0) leftover.push(`${name}: ${rows.length} row(s) survived`,);
  }
  assert.deepEqual(
    leftover,
    [],
    `purgeable collections that survived a shop/redact:\n${leftover.join('\n',)}`,
  );

  // The purge set plus the three preserved sets must account for every
  // collection — nothing may be silently in neither.
  const accounted =
    PURGEABLE_COLLECTIONS.length +
    Object.keys(PLATFORM_GLOBAL_COLLECTIONS,).length +
    Object.keys(LEGAL_HOLD_COLLECTIONS,).length +
    Object.keys(RETAINED_BY_CALLER_COLLECTIONS,).length;
  assert.equal(accounted, COLLECTIONS.length, 'every collection must be classified once',);
  assert.ok(seeded.length >= 50,);
},);

test('M7: shop purge preserves legal holds, opt-outs and the audit trail', async () => {
  const store = createStore();
  await seedEveryCollection(store, STORE,);

  await purgeStoreData(store, STORE,);

  for (const name of Object.keys(LEGAL_HOLD_COLLECTIONS,)) {
    const rows = await store[name].find({ store_id: STORE, },);
    assert.equal(rows.length, 1, `${name} is under a legal hold and must survive`,);
  }
  for (const name of Object.keys(PLATFORM_GLOBAL_COLLECTIONS,)) {
    const rows = await store[name].find({ store_id: STORE, },);
    assert.equal(rows.length, 1, `${name} is platform-global and must survive`,);
  }
  for (const name of Object.keys(RETAINED_BY_CALLER_COLLECTIONS,)) {
    const rows = await store[name].find({ store_id: STORE, },);
    assert.equal(rows.length, 1, `${name} is retained by the caller and must survive`,);
  }
},);

test('M7: shop purge never reaches another tenant', async () => {
  const store = createStore();
  await seedEveryCollection(store, STORE,);
  const otherSeeded = await seedEveryCollection(store, OTHER,);

  await purgeStoreData(store, STORE,);

  const wrongfullyDeleted = [];
  for (const name of otherSeeded) {
    const rows = await store[name].find({ store_id: OTHER, },);
    if (rows.length !== 1) wrongfullyDeleted.push(`${name}: expected 1 row, found ${rows.length}`,);
  }
  assert.deepEqual(
    wrongfullyDeleted,
    [],
    `the purge crossed tenants:\n${wrongfullyDeleted.join('\n',)}`,
  );
},);

test('M7: redaction clears the customer name and phone, not just id and email', async () => {
  const store = createStore();

  // The exact shapes the real code writes:
  //   `customers` — customerProfile.js inserts `identity`/`email`/`phone`
  //   `leads`     — revenueIntelligence.captureLead inserts `name`/`phone`
  //                 from the public deep-audit form (createApp.js `/deep`)
  await store.customers.insert({
    store_id: STORE,
    identity: CUST,
    email: EMAIL,
    phone: PHONE,
  },);
  await store.leads.insert({
    store_id: STORE,
    email: EMAIL,
    name: PERSON_NAME,
    phone: PHONE,
  },);

  await redactCustomerData(store, STORE, CUST,);

  const customer = await store.customers.findOne({ store_id: STORE, },);
  assert.equal(customer.email, null,);
  assert.equal(
    customer.phone,
    null,
    'the profile phone must be cleared — it is how inbound WhatsApp is re-attributed',
  );
  assert.equal(customer.gdpr_deleted, true,);

  const lead = await store.leads.findOne({ store_id: STORE, },);
  assert.equal(lead.email, null,);
  assert.equal(
    lead.name,
    null,
    'leads.name holds a person name from the public audit form and must be cleared',
  );
  assert.equal(lead.phone, null,);
},);

test('M7: a row identifiable ONLY by phone is still found and scrubbed', async () => {
  const store = createStore();
  await store.customers.insert({
    store_id: STORE, identity: CUST, email: EMAIL, phone: PHONE,
  },);
  // No customer_id and no email — phone is the only thing tying this row to
  // the customer, which is exactly the case a field-name-only scan would miss.
  await store.deliveries.insert({ store_id: STORE, phone: PHONE, channel: 'whatsapp', },);

  await redactCustomerData(store, STORE, CUST,);

  const rows = await store.deliveries.find({ store_id: STORE, },);
  assert.equal(rows.length, 1,);
  assert.equal(rows[0].phone, null, 'a phone-only match must still be scrubbed',);
  assert.equal(rows[0].channel, 'whatsapp', 'non-identifying fields are preserved',);
},);

test('M7: a bare `name` is NOT scrubbed in collections where it is not a person name', async () => {
  const store = createStore();
  await store.customers.insert({ store_id: STORE, identity: CUST, email: EMAIL, },);
  // A campaign name and a product name are not personal data; blanking them
  // would corrupt unrelated records. The redaction must leave them alone.
  await store.campaigns.insert({
    store_id: STORE, customer_id: CUST, email: EMAIL, name: 'Spring Sale', amount: 42,
  },);

  await redactCustomerData(store, STORE, CUST,);

  const campaign = await store.campaigns.findOne({ store_id: STORE, },);
  assert.equal(campaign.customer_id, 'anon', 'the identifier must still be scrubbed',);
  assert.equal(
    campaign.name,
    'Spring Sale',
    'a campaign name is not personal data and must be preserved',
  );
},);

// ── Export mirrors the redaction ────────────────────────────────────────────

test('M7: the data-request export covers every collection the redaction covers', async () => {
  const store = createStore();
  await seedEveryCollection(store, STORE,);

  const exported = await collectCustomerData(store, STORE, CUST,);

  // If the export and the redaction disagree about where data lives, a
  // data_request reply is incomplete while a redact still finds the rows.
  const exportedNames = new Set(Object.keys(exported.collections,),);
  const missing = [];
  for (const name of REDACTABLE_COLLECTIONS) {
    const rows = await store[name].find({ store_id: STORE, },);
    if (rows.length > 0 && !exportedNames.has(name,)) missing.push(name,);
  }

  assert.deepEqual(
    missing,
    [],
    `collections holding the customer that the export omits:\n${missing.join('\n',)}`,
  );
  // Exactly one seeded row per redactable collection — 53 minus the 9
  // platform-global collections, which are out of scope for a customer export.
  assert.equal(
    exported.total_records,
    REDACTABLE_COLLECTIONS.length,
    'the export must return every matching row from every redactable collection',
  );
},);
