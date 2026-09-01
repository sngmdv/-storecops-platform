'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test',);
const assert = require('node:assert',);
const payment = require('../src/layers/intelligence/paymentEngine',);

const mockConfig = {
  payment: {
    stripe: { secretKey: 'sk_test_xxx', webhookSecret: 'whsec_test123', publicKey: 'pk_test_xxx', },
    razorpay: { keyId: 'rzp_test_xxx', keySecret: 'rzp_secret_xxx', webhookSecret: 'rzp_whsec_test123', },
    plans: {
      starter: { monthly: 29, annual: 290, currency: 'usd', },
      growth: { monthly: 49, annual: 490, currency: 'usd', },
      premium: { monthly: 99, annual: 990, currency: 'usd', },
      starter_inr: { monthly: 2499, annual: 24990, currency: 'inr', },
      growth_inr: { monthly: 4199, annual: 41990, currency: 'inr', },
      premium_inr: { monthly: 8499, annual: 84990, currency: 'inr', },
    },
    gstRate: 18,
    refundWindowDays: 14,
    autoRenewNoticeDays: 7,
  },
  publicUrl: 'http://localhost:4000',
};

// ─── Stripe Checkout ──────────────────────────────────────────────────────────

test('Stripe: creates checkout session for global customer', async () => {
  const result = await payment.createStripeCheckout({
    config: mockConfig,
    customer: { email: 'test@us.com', name: 'US Customer', country: 'US', id: 'c1', },
    plan: 'growth',
    billingCycle: 'monthly',
  },);
  assert.ok(result.session,);
  assert.equal(result.provider, 'stripe',);
  assert.equal(result.session.mode, 'subscription',);
  assert.equal(result.session.customer_email, 'test@us.com',);
  assert.ok(result.session.id.startsWith('cs_',),);
},);

test('Stripe: annual billing uses annual price', async () => {
  const result = await payment.createStripeCheckout({
    config: mockConfig,
    customer: { email: 'test@us.com', country: 'US', },
    plan: 'growth',
    billingCycle: 'annual',
  },);
  assert.equal(result.session.line_items[0].price_data.unit_amount, 490 * 100,);
},);

test('Stripe: rejects unknown plan', async () => {
  const result = await payment.createStripeCheckout({
    config: mockConfig,
    customer: { email: 'test@us.com', },
    plan: 'enterprise',
  },);
  assert.ok(result.error,);
},);

test('Stripe: PCI-DSS — no raw card data in session', async () => {
  const result = await payment.createStripeCheckout({
    config: mockConfig,
    customer: { email: 'test@us.com', country: 'US', },
    plan: 'growth',
  },);
  const sessionStr = JSON.stringify(result.session,);
  assert.ok(!sessionStr.includes('card_number',),);
  assert.ok(!sessionStr.includes('cvv',),);
  assert.ok(!sessionStr.includes('pan',),);
},);

// ─── Stripe Webhook Verification ─────────────────────────────────────────────

test('Stripe webhook: verifies valid signature', () => {
  const crypto = require('node:crypto',);
  const timestamp = Math.floor(Date.now() / 1000,);
  const payload = '{"type":"checkout.session.completed"}';
  const signedPayload = `${timestamp}.${payload}`;
  const sig = crypto.createHmac('sha256', 'whsec_test123',).update(signedPayload,).digest('hex',);
  const header = `t=${timestamp},v1=${sig}`;

  const result = payment.verifyStripeWebhook({
    payload, signature: header, webhookSecret: 'whsec_test123',
  },);
  assert.equal(result.valid, true,);
},);

test('Stripe webhook: rejects tampered payload', () => {
  const crypto = require('node:crypto',);
  const timestamp = Math.floor(Date.now() / 1000,);
  const payload = '{"type":"checkout.session.completed"}';
  const signedPayload = `${timestamp}.${payload}`;
  const sig = crypto.createHmac('sha256', 'whsec_test123',).update(signedPayload,).digest('hex',);
  const header = `t=${timestamp},v1=${sig}`;

  const result = payment.verifyStripeWebhook({
    payload: '{"type":"hacked"}', signature: header, webhookSecret: 'whsec_test123',
  },);
  assert.equal(result.valid, false,);
},);

test('Stripe webhook: rejects missing signature', () => {
  const result = payment.verifyStripeWebhook({
    payload: '{}', signature: null, webhookSecret: 'whsec_test123',
  },);
  assert.equal(result.valid, false,);
},);

// ─── Razorpay Order ───────────────────────────────────────────────────────────

test('Razorpay: creates order for Indian customer with GST', async () => {
  const result = await payment.createRazorpayOrder({
    config: mockConfig,
    customer: { email: 'test@in.com', name: 'Indian Customer', country: 'IN', phone: '+919876543210', },
    plan: 'growth',
    billingCycle: 'monthly',
  },);
  assert.ok(result.order,);
  assert.equal(result.provider, 'razorpay',);
  assert.equal(result.order.currency, 'INR',);
  assert.ok(result.order.gst,);
  assert.equal(result.order.gst.rate, 18,);
  assert.ok(result.order.gst.cgst > 0,);
  assert.ok(result.order.gst.sgst > 0,);
},);

test('Razorpay: includes e-mandate for recurring payments', async () => {
  const result = await payment.createRazorpayOrder({
    config: mockConfig,
    customer: { email: 'test@in.com', country: 'IN', },
    plan: 'growth',
    billingCycle: 'monthly',
  },);
  assert.ok(result.order.recurring,);
  assert.equal(result.order.recurring.enabled, true,);
  assert.ok(result.order.recurring.max_amount > 0,);
},);

test('Razorpay: enables Indian payment methods', async () => {
  const result = await payment.createRazorpayOrder({
    config: mockConfig,
    customer: { email: 'test@in.com', country: 'IN', },
    plan: 'growth',
  },);
  assert.equal(result.order.payment_methods.upi, true,);
  assert.equal(result.order.payment_methods.card, true,);
  assert.equal(result.order.payment_methods.netbanking, true,);
  assert.equal(result.order.payment_methods.wallet, true,);
},);

test('Razorpay: INR pricing used for Indian customers', async () => {
  const result = await payment.createRazorpayOrder({
    config: mockConfig,
    customer: { email: 'test@in.com', country: 'IN', },
    plan: 'growth',
    billingCycle: 'monthly',
  },);
  // growth_inr monthly = 4199 + 18% GST = 4199 + 755 = 4954
  const expectedTotal = (4199 + Math.round(4199 * 0.18,)) * 100;
  assert.equal(result.order.amount, expectedTotal,);
},);

// ─── Razorpay Webhook Verification ───────────────────────────────────────────

test('Razorpay webhook: verifies valid signature', () => {
  const crypto = require('node:crypto',);
  const payload = '{"event":"payment.captured"}';
  const sig = crypto.createHmac('sha256', 'rzp_whsec_test123',).update(payload,).digest('hex',);

  const result = payment.verifyRazorpayWebhook({
    payload, signature: sig, webhookSecret: 'rzp_whsec_test123',
  },);
  assert.equal(result.valid, true,);
},);

test('Razorpay webhook: rejects tampered payload', () => {
  const crypto = require('node:crypto',);
  const payload = '{"event":"payment.captured"}';
  const sig = crypto.createHmac('sha256', 'rzp_whsec_test123',).update(payload,).digest('hex',);

  const result = payment.verifyRazorpayWebhook({
    payload: '{"event":"hacked"}', signature: sig, webhookSecret: 'rzp_whsec_test123',
  },);
  assert.equal(result.valid, false,);
},);

// ─── Subscription Management ─────────────────────────────────────────────────

test('Subscription: creates new subscription', () => {
  const result = payment.createSubscription({ subscriptions: [], }, {
    customerId: 'c1', plan: 'growth', billingCycle: 'monthly',
    provider: 'stripe', amount: 49, currency: 'usd', country: 'US',
  },);
  assert.ok(result.subscription,);
  assert.equal(result.subscription.status, 'active',);
  assert.equal(result.subscription.plan, 'growth',);
  assert.equal(result.subscription.autoRenew, true,);
  assert.ok(result.subscription.refundEligibleUntil,);
},);

test('Subscription: Indian subscription includes GST', () => {
  const result = payment.createSubscription({ subscriptions: [], }, {
    customerId: 'c2', plan: 'growth', billingCycle: 'monthly',
    provider: 'razorpay', amount: 4199, currency: 'inr', country: 'IN',
  },);
  assert.ok(result.subscription.gst,);
  assert.equal(result.subscription.gst.rate, 18,);
  assert.ok(result.subscription.gst.amount > 0,);
},);

test('Subscription: cancels with access until period end', () => {
  const subs = [{
    id: 'sub_1', customerId: 'c1', plan: 'growth', status: 'active',
    currentPeriodEnd: new Date(Date.now() + 15 * 86400000,).toISOString(),
    refundEligibleUntil: new Date(Date.now() + 10 * 86400000,).toISOString(),
  },];
  const result = payment.cancelSubscription({ subscriptions: subs, }, 'sub_1', 'too_expensive',);
  assert.equal(result.subscription.status, 'cancelled',);
  assert.ok(result.subscription.accessUntil,);
  assert.equal(result.refundEligible, true,);
},);

test('Subscription: pauses and resumes', () => {
  const subs = [{ id: 'sub_1', status: 'active', billingCycle: 'monthly', },];
  const paused = payment.pauseSubscription({ subscriptions: subs, }, 'sub_1',);
  assert.equal(paused.subscription.status, 'paused',);

  const resumed = payment.resumeSubscription({ subscriptions: subs, }, 'sub_1',);
  assert.equal(resumed.subscription.status, 'active',);
},);

test('Subscription: cannot resume non-paused subscription', () => {
  const subs = [{ id: 'sub_1', status: 'active', },];
  const result = payment.resumeSubscription({ subscriptions: subs, }, 'sub_1',);
  assert.ok(result.error,);
},);

// ─── Invoice Generation ──────────────────────────────────────────────────────

test('Invoice: generates with GST for Indian customer', () => {
  const sub = { id: 'sub_1', customerId: 'c1', plan: 'growth', billingCycle: 'monthly', amount: 4199, currency: 'inr', };
  const result = payment.generateInvoice({ invoices: [], }, {
    subscription: sub, customer: { country: 'IN', },
  },);
  assert.ok(result.invoice,);
  assert.ok(result.invoice.number.startsWith('INV-',),);
  assert.ok(result.invoice.gst,);
  assert.equal(result.invoice.gst.rate, 18,);
  assert.ok(result.invoice.lineItems[0].hsnCode,); // HSN on line item
  assert.ok(result.invoice.gst.cgst > 0,);
},);

test('Invoice: no GST for global customer', () => {
  const sub = { id: 'sub_1', customerId: 'c1', plan: 'growth', billingCycle: 'monthly', amount: 49, currency: 'usd', };
  const result = payment.generateInvoice({ invoices: [], }, {
    subscription: sub, customer: { country: 'US', },
  },);
  assert.ok(result.invoice,);
  assert.equal(result.invoice.gst, null,);
},);

test('Invoice: includes auto-debit notice for Indian customers', () => {
  const sub = { id: 'sub_1', customerId: 'c1', plan: 'growth', amount: 4199, currency: 'inr', billingCycle: 'monthly', currentPeriodEnd: new Date(Date.now() + 30 * 86400000,).toISOString(), };
  const result = payment.generateInvoice({ invoices: [], }, {
    subscription: sub, customer: { country: 'IN', },
  },);
  assert.ok(result.invoice.compliance.autoDebitNotice,);
},);

// ─── Refund Processing ───────────────────────────────────────────────────────

test('Refund: processes within refund window', () => {
  const subs = [{ id: 'sub_1', customerId: 'c1', },];
  const invs = [{
    id: 'inv_1', subscriptionId: 'sub_1', status: 'paid', total: 58, currency: 'usd',
    createdAt: new Date(Date.now() - 5 * 86400000,).toISOString(), // 5 days ago
    gst: null,
  },];
  const result = payment.processRefund({ subscriptions: subs, invoices: invs, }, {
    subscriptionId: 'sub_1', reason: 'not_satisfied',
  },);
  assert.ok(result.refund,);
  assert.equal(result.refund.status, 'pending',);
  assert.equal(result.refund.amount, 58,);
},);

test('Refund: rejects after refund window', () => {
  const subs = [{ id: 'sub_1', },];
  const invs = [{
    id: 'inv_1', subscriptionId: 'sub_1', status: 'paid', total: 58,
    createdAt: new Date(Date.now() - 20 * 86400000,).toISOString(), // 20 days ago
  },];
  const result = payment.processRefund({ subscriptions: subs, invoices: invs, }, {
    subscriptionId: 'sub_1',
  },);
  assert.ok(result.error,);
  assert.ok(result.error.includes('expired',),);
},);

// ─── Webhook Processing ──────────────────────────────────────────────────────

test('Webhook: processes checkout completed event', () => {
  const result = payment.processWebhook({ subscriptions: [], invoices: [], payments: [], }, {
    provider: 'stripe', event: 'checkout.session.completed', data: { id: 'cs_123', },
  },);
  assert.ok(result.payment,);
  assert.equal(result.payment.action, 'activate_subscription',);
},);

test('Webhook: processes payment failed event', () => {
  const result = payment.processWebhook({ subscriptions: [], invoices: [], payments: [], }, {
    provider: 'razorpay', event: 'payment.failed', data: { error: 'insufficient_funds', },
  },);
  assert.equal(result.payment.action, 'flag_payment_failure',);
},);

// ─── Payment Analytics ───────────────────────────────────────────────────────

test('Analytics: calculates MRR and revenue breakdown', () => {
  const subs = [
    { id: 's1', status: 'active', plan: 'growth', amount: 49, provider: 'stripe', country: 'US', },
    { id: 's2', status: 'active', plan: 'growth_inr', amount: 4199, provider: 'razorpay', country: 'IN', },
    { id: 's3', status: 'paused', plan: 'starter', amount: 29, provider: 'stripe', country: 'US', },
  ];
  const result = payment.getPaymentAnalytics({ subscriptions: subs, invoices: [], payments: [], },);
  assert.equal(result.activeSubscriptions, 2,);
  assert.equal(result.pausedSubscriptions, 1,);
  assert.equal(result.byProvider.stripe, 1,);
  assert.equal(result.byProvider.razorpay, 1,);
},);

// ─── Compliance ──────────────────────────────────────────────────────────────

test('Compliance: generates report with all sections', () => {
  const result = payment.generateComplianceReport({ subscriptions: [], invoices: [], payments: [], },);
  assert.ok(result.pciDss,);
  assert.ok(result.rbi,);
  assert.ok(result.gst,);
  assert.ok(result.refundPolicy,);
  assert.ok(result.dataProtection,);
  assert.equal(result.pciDss.compliant, true,);
  assert.equal(result.pciDss.cardDataStored, false,);
},);

test('Compliance: detects upcoming auto-debits for Indian subscriptions', () => {
  const subs = [{
    id: 'sub_1', status: 'active', country: 'IN', autoRenew: true,
    amount: 4199, currency: 'inr',
    currentPeriodEnd: new Date(Date.now() + 3 * 86400000,).toISOString(), // 3 days away
  },];
  const result = payment.getUpcomingAutoDebits({ subscriptions: subs, },);
  assert.ok(result.length >= 1,);
  assert.equal(result[0].noticeRequired, true,);
},);

test('Compliance: ignores non-Indian auto-debits', () => {
  const subs = [{
    id: 'sub_1', status: 'active', country: 'US', autoRenew: true,
    currentPeriodEnd: new Date(Date.now() + 3 * 86400000,).toISOString(),
  },];
  const result = payment.getUpcomingAutoDebits({ subscriptions: subs, },);
  assert.equal(result.length, 0,);
},);

// ─── Helpers ─────────────────────────────────────────────────────────────────

test('Helper: isIndianCustomer detects IN country', () => {
  assert.equal(payment.isIndianCustomer({ country: 'IN', },), true,);
  assert.equal(payment.isIndianCustomer({ country: 'US', },), false,);
  assert.equal(payment.isIndianCustomer({ currency: 'inr', },), true,);
},);

test('Helper: formatCurrency formats correctly', () => {
  assert.equal(payment.formatCurrency(49, 'usd',), '$49',);
  assert.equal(payment.formatCurrency(4199, 'inr',), '₹4,199',);
},);
