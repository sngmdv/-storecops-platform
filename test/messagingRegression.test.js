"use strict";

process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert");
const { createPlatform } = require("../src/platform");

const STORE = "store_msg_regress";

test("messaging regression: recovery email requires consent", async () => {
  const platform = createPlatform();

  // Seed a shopper with cart abandonment.
  await platform.eventTracker.track({
    event_type: "product_view",
    store_id: STORE,
    customer_id: "consent_shopper",
    product_id: "p1",
  });

  // Without explicit consent, the event tracker should still track
  // but the execution layer should check consent before sending.
  const tracked = await platform.trackAndReact({
    event_type: "cart_abandoned",
    store_id: STORE,
    customer_id: "consent_shopper",
  });
  assert.equal(tracked.accepted, true);
  assert.equal(tracked.decision.actions.length, 1);

  // Suppress the email channel for this customer.
  await platform.consentService.suppressChannel(STORE, "consent_shopper", "email");

  // Execution should not deliver via email when suppressed.
  const result = await platform.executionService.processStore(STORE);
  const deliveries = await platform.store.deliveries.find({
    store_id: STORE,
    customer_id: "consent_shopper",
    channel: "email",
  });
  // The delivery may or may not exist depending on consent check in execution,
  // but the key assertion is that suppressed customers don't get emails.
  const emailDeliveries = deliveries.filter((d) => d.status === "delivered");
  assert.equal(emailDeliveries.length, 0, "suppressed customer must not receive email");
});

test("messaging regression: opt-out persists across future sends", async () => {
  const platform = createPlatform();

  // Grant marketing + recovery consent.
  await platform.consentService.setConsent(STORE, "optout_shopper", {
    marketing: true,
    recovery: true,
  });
  const granted = await platform.consentService.canSend(STORE, "optout_shopper", "cart_recovery", "email");
  assert.equal(granted.allowed, true, "recovery should be allowed with consent");

  // Suppress the email channel.
  await platform.consentService.suppressChannel(STORE, "optout_shopper", "email");
  const blocked = await platform.consentService.canSend(STORE, "optout_shopper", "cart_recovery", "email");
  assert.equal(blocked.allowed, false, "email must be blocked after channel suppression");
  assert.equal(blocked.reason, "channel_suppressed");

  // WhatsApp should still be allowed (only email was suppressed).
  const whatsappOk = await platform.consentService.canSend(STORE, "optout_shopper", "cart_recovery", "whatsapp");
  assert.equal(whatsappOk.allowed, true, "whatsapp should still be allowed");

  // Re-granting email channel should unblock.
  await platform.consentService.unsuppressChannel(STORE, "optout_shopper", "email");
  const unblocked = await platform.consentService.canSend(STORE, "optout_shopper", "cart_recovery", "email");
  assert.equal(unblocked.allowed, true, "email should be unblocked after unsuppress");
});

test("messaging regression: global email suppression via unsubscribe token", async () => {
  // Set the env var so the token builder has a secret.
  process.env.EMAIL_UNSUBSCRIBE_SECRET = "test-secret-for-tokens";
  const platform = createPlatform();

  // Build an unsubscribe token for an email.
  const token = platform.consentService.buildUnsubscribeToken("unsub@test.com", STORE);
  assert.ok(token, "token should be generated");
  assert.ok(token.includes("."), "token should have payload.signature format");

  // Parse the token back.
  const parsed = platform.consentService.parseUnsubscribeToken(token);
  assert.ok(parsed, "token should parse successfully");
  assert.equal(parsed.email, "unsub@test.com", "token should resolve to the email");

  // Globally suppress the email.
  await platform.consentService.suppressEmailGlobally(parsed.email, { source: "unsubscribe_link" });

  // The email should now be blocked across all stores.
  const blocked = await platform.consentService.isEmailGloballySuppressed(parsed.email);
  assert.equal(blocked, true, "globally suppressed email must be blocked");

  // Cleanup.
  delete process.env.EMAIL_UNSUBSCRIBE_SECRET;
});

test("messaging regression: full cart recovery → delivery → attribution loop", async () => {
  const platform = createPlatform();

  // 1. Shopper views a product.
  await platform.eventTracker.track({
    event_type: "product_view",
    store_id: STORE,
    customer_id: "full_loop_shopper",
    product_id: "p1",
  });

  // 2. Cart abandonment triggers recovery.
  const reaction = await platform.trackAndReact({
    event_type: "cart_abandoned",
    store_id: STORE,
    customer_id: "full_loop_shopper",
  });
  assert.equal(reaction.accepted, true);
  assert.equal(reaction.decision.actions.length, 1);
  assert.equal(reaction.decision.actions[0].rule_id, "cart_recovery");

  // 3. Execution delivers the message.
  const exec = await platform.executionService.processStore(STORE);
  assert.equal(exec.delivered, 1);

  // 4. Shopper converts.
  await platform.eventTracker.track({
    event_type: "purchase",
    store_id: STORE,
    customer_id: "full_loop_shopper",
    total: 150,
    items: [{ product_id: "p1", quantity: 1 }],
  });

  // 5. Attribution credits the recovery.
  const attr = await platform.attribution.attributeStore(STORE);
  assert.equal(attr.conversions, 1);
  assert.equal(attr.attributed_revenue, 150);
});

test("messaging regression: duplicate abandonment does not send twice", async () => {
  const platform = createPlatform();

  await platform.eventTracker.track({
    event_type: "product_view",
    store_id: STORE,
    customer_id: "dedup_shopper",
    product_id: "p1",
  });

  // First abandonment.
  const first = await platform.trackAndReact({
    event_type: "cart_abandoned",
    store_id: STORE,
    customer_id: "dedup_shopper",
  });
  assert.equal(first.decision.actions.length, 1);

  // Second abandonment — should be deduplicated.
  const second = await platform.trackAndReact({
    event_type: "cart_abandoned",
    store_id: STORE,
    customer_id: "dedup_shopper",
  });
  assert.equal(second.decision.actions.length, 0, "duplicate abandonment must not queue again");

  // Execute — should deliver only once.
  const exec = await platform.executionService.processStore(STORE);
  assert.equal(exec.delivered, 1, "only one message should be delivered");
});
