const crypto = require('crypto');
const { db } = require('../store/db');

/**
 * STRIPE -> GOHIGHLEVEL BRIDGE (Webtech Design billing).
 *
 * Stripe calls POST /webhook/stripe when something happens to a payment or
 * subscription. This module checks the message really came from Stripe
 * (signature), then turns the event into a plain action: which client
 * (email), which tags to add/remove in GoHighLevel, and a note for the
 * contact. GoHighLevel workflows on those tags send the onboarding email,
 * the "please update your card" email, and so on.
 *
 * Events handled (select exactly these in Stripe):
 *   checkout.session.completed     - new client paid (or paid an upgrade fee)
 *   invoice.paid                   - a monthly payment went through
 *   invoice.payment_failed         - a card was declined
 *   customer.subscription.deleted  - the subscription ended
 */

// ---- Signature check (Stripe's documented scheme, no Stripe library needed)
// Header looks like: t=1700000000,v1=<hex hmac>,v1=<...>
// Signed payload is `${t}.${rawBody}`, HMAC-SHA256 with the whsec_ secret.
function verifySignature(rawBody, header, secret, toleranceSec = 300) {
  if (!secret) return { ok: false, reason: 'STRIPE_WEBHOOK_SECRET is not set' };
  if (!header || !rawBody) return { ok: false, reason: 'missing Stripe-Signature header or body' };
  const parts = String(header).split(',').map((p) => p.split('='));
  const t = (parts.find(([k]) => k === 't') || [])[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !sigs.length) return { ok: false, reason: 'malformed Stripe-Signature header' };
  const age = Math.abs(Date.now() / 1000 - Number(t));
  if (!Number.isFinite(age) || age > toleranceSec) return { ok: false, reason: 'signature timestamp too old' };
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
  const match = sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  return match ? { ok: true } : { ok: false, reason: 'signature does not match (wrong STRIPE_WEBHOOK_SECRET?)' };
}

// ---- Remember which Stripe customer is which email, because the
// "subscription ended" event carries only the customer id.
db.exec(`
  CREATE TABLE IF NOT EXISTS stripe_customers (
    customer_id TEXT PRIMARY KEY,
    email TEXT,
    name TEXT,
    phone TEXT,
    plan TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS stripe_events (
    event_id TEXT PRIMARY KEY,
    received_at TEXT DEFAULT (datetime('now'))
  );
`);

function rememberCustomer({ customerId, email, name, phone, plan }) {
  if (!customerId) return;
  db.prepare(`
    INSERT INTO stripe_customers (customer_id, email, name, phone, plan) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(customer_id) DO UPDATE SET
      email = COALESCE(excluded.email, email), name = COALESCE(excluded.name, name),
      phone = COALESCE(excluded.phone, phone), plan = COALESCE(excluded.plan, plan),
      updated_at = datetime('now')
  `).run(customerId, email || null, name || null, phone || null, plan || null);
}

function lookupCustomer(customerId) {
  if (!customerId) return null;
  return db.prepare('SELECT * FROM stripe_customers WHERE customer_id = ?').get(customerId) || null;
}

/**
 * Stripe re-sends events (and retries any we fail on). An event is marked
 * handled only after it succeeded, so a GoHighLevel hiccup gets retried.
 */
function alreadyHandled(eventId) {
  if (!eventId) return false;
  return Boolean(db.prepare('SELECT 1 FROM stripe_events WHERE event_id = ?').get(eventId));
}
function markHandled(eventId) {
  if (eventId) db.prepare('INSERT OR IGNORE INTO stripe_events (event_id) VALUES (?)').run(eventId);
}

// ---- Which plan was bought. Payment Link metadata "plan" wins (most
// reliable); otherwise match the amount charged at checkout against the
// brain's stripe.plans table (setup fee + first month, or an upgrade fee).
function identifyPlan(session, stripeCfg) {
  const meta = (session.metadata && session.metadata.plan) || '';
  if (meta) return { key: meta.toLowerCase(), label: meta };
  const cents = session.amount_total;
  const plans = (stripeCfg && stripeCfg.plans) || {};
  for (const [key, p] of Object.entries(plans)) {
    if (p.checkoutTotalCents === cents) return { key, label: p.label || key };
  }
  return null;
}

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') };
}

const money = (cents, cur) => (typeof cents === 'number' ? `$${(cents / 100).toFixed(2)}${cur && cur !== 'usd' ? ` ${cur.toUpperCase()}` : ''}` : '');

/**
 * Turn a verified Stripe event into { email, name, phone, addTags, removeTags, note }
 * or { ignore: reason }. Tag names come from brain.stripe.tags.
 */
function eventToAction(event, brain) {
  const cfg = brain.stripe || {};
  const T = cfg.tags || {};
  const o = (event.data && event.data.object) || {};

  if (event.type === 'checkout.session.completed') {
    const cd = o.customer_details || {};
    const plan = identifyPlan(o, cfg);
    const isUpgrade = plan && plan.key.startsWith('upgrade');
    rememberCustomer({ customerId: o.customer, email: cd.email, name: cd.name, phone: cd.phone, plan: plan && !isUpgrade ? plan.key : null });
    const planTag = plan && cfg.plans && cfg.plans[plan.key] && cfg.plans[plan.key].tag;
    return {
      email: cd.email, name: cd.name, phone: cd.phone, company: o.custom_fields?.find?.((f) => /business|company/i.test(f.key))?.text?.value,
      addTags: [isUpgrade ? T.upgraded : T.paid, planTag, T.current].filter(Boolean),
      removeTags: [T.paymentFailed, T.canceled].filter(Boolean),
      note: [
        `STRIPE: ${isUpgrade ? 'Upgrade paid' : 'New client paid'} - ${money(o.amount_total, o.currency)}`,
        plan ? `Plan: ${plan.label}` : `Plan: not recognized from the amount - check Stripe and tag the plan by hand.`,
        o.subscription ? `Subscription: ${o.subscription}` : '',
        isUpgrade ? 'Next: switch their subscription to the new monthly plan in Stripe (Update subscription).' : 'Next: onboarding email goes out from the GHL workflow on the paid tag.',
      ].filter(Boolean).join('\n'),
    };
  }

  if (event.type === 'invoice.paid') {
    rememberCustomer({ customerId: o.customer, email: o.customer_email, name: o.customer_name, phone: o.customer_phone });
    // The first invoice of a new subscription is already covered by
    // checkout.session.completed - don't double-note it.
    const first = o.billing_reason === 'subscription_create';
    if (!o.amount_paid) return { ignore: 'zero-dollar invoice' };
    return {
      email: o.customer_email, name: o.customer_name, phone: o.customer_phone,
      addTags: [T.current].filter(Boolean),
      removeTags: [T.paymentFailed].filter(Boolean),
      note: first ? null : `STRIPE: Monthly payment received - ${money(o.amount_paid, o.currency)}${o.hosted_invoice_url ? `\nInvoice: ${o.hosted_invoice_url}` : ''}`,
    };
  }

  if (event.type === 'invoice.payment_failed') {
    rememberCustomer({ customerId: o.customer, email: o.customer_email, name: o.customer_name, phone: o.customer_phone });
    const next = o.next_payment_attempt ? new Date(o.next_payment_attempt * 1000).toLocaleDateString('en-US', { timeZone: 'America/Chicago' }) : null;
    return {
      email: o.customer_email, name: o.customer_name, phone: o.customer_phone,
      addTags: [T.paymentFailed].filter(Boolean),
      removeTags: [T.current].filter(Boolean),
      note: [
        `STRIPE: Payment FAILED - ${money(o.amount_due, o.currency)} (attempt ${o.attempt_count || 1})`,
        next ? `Stripe will retry on ${next}.` : 'No more automatic retries scheduled.',
        o.hosted_invoice_url ? `Pay/update card link for the client: ${o.hosted_invoice_url}` : '',
      ].filter(Boolean).join('\n'),
      paymentLink: o.hosted_invoice_url || null,
    };
  }

  if (event.type === 'customer.subscription.deleted') {
    const known = lookupCustomer(o.customer);
    if (!known || !known.email) return { ignore: `subscription ended for customer ${o.customer}, but no email on file for them yet - check Stripe` , needsAttention: true };
    return {
      email: known.email, name: known.name, phone: known.phone,
      addTags: [T.canceled].filter(Boolean),
      removeTags: [T.current, T.paymentFailed].filter(Boolean),
      note: `STRIPE: Subscription ENDED${o.cancellation_details?.reason ? ` (${o.cancellation_details.reason.replace(/_/g, ' ')})` : ''}.\nNext: pause their services and reach out personally.`,
    };
  }

  return { ignore: `event type ${event.type} is not used` };
}

module.exports = { verifySignature, eventToAction, alreadyHandled, markHandled, splitName, identifyPlan, lookupCustomer };
