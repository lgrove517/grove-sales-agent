/**
 * Principal Protection Strategies: the annuity / bank-product disclosure.
 *   node test/annuityDisclosure.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'annuity-'));
delete process.env.GHL_API_KEY;
delete process.env.GHL_LOCATION_ID;

const { ensureAnnuityDisclosure } = require('../src/config/complianceGuard');
const { loadBrain } = require('../src/config/loadBrain');
const ghl = require('../src/integrations/ghl');

const gfg = loadBrain('grove-financial');
let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('GFG offer is named Principal Protection Strategies', () => {
  assert.ok(gfg.offers.some((o) => o.name === 'Principal Protection Strategies'));
  assert.ok(gfg.voice.bannedPhrases.includes('safe money'));
});
test('comparing annuities to CDs adds the disclosure', () => {
  const r = ensureAnnuityDisclosure('Tired of low CD rates? A fixed annuity may be worth a look.', gfg);
  assert.ok(r.appended && /not FDIC-insured/.test(r.messageText));
});
test('talking about principal protection adds it too', () => {
  assert.ok(ensureAnnuityDisclosure('Ask me about Principal Protection Strategies.', gfg).appended);
});
test('unrelated messages are left alone', () => {
  const msg = 'Hi Ann, happy to talk about your Medicare options. Pick a time below.';
  assert.strictEqual(ensureAnnuityDisclosure(msg, gfg).messageText, msg);
  assert.ok(!ensureAnnuityDisclosure('Your CD matures next month? Let us talk.', gfg).appended, 'a CD alone is not a comparison');
});
test('not added twice', () => {
  const once = ensureAnnuityDisclosure('CDs vs annuities', gfg).messageText;
  assert.strictEqual(ensureAnnuityDisclosure(once, gfg).messageText, once);
});
test('every outgoing lead message gets it (sendMessage, DRY_RUN)', async () => {
  const r = await ghl.runWithBrain(gfg, () => ghl.sendMessage({ contactId: 'c1', type: 'Email', message: 'Compare your CD to a fixed indexed annuity.', subject: 'x', html: '<div><p>Compare</p>\n</div>' }));
  assert.ok(/not FDIC-insured/.test(r.wouldHaveSent.message));
  assert.ok(/not FDIC-insured/.test(r.wouldHaveSent.html));
});

(async () => {
  for (const [name, fn] of tests) { await fn(); passed++; console.log(`ok - ${name}`); }
  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
