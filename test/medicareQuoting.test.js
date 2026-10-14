/**
 * Checks the Medicare quoting-link rules without any API keys or server:
 *   node test/medicareQuoting.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { applyApprovalGates, brainToSystemPrompt } = require('../src/config/loadBrain');
const { checkMedicareQuoteLink, ensureMedicareDisclaimer } = require('../src/config/complianceGuard');

const raw = fs.readFileSync(path.join(__dirname, '..', 'config', 'grove-financial.json'), 'utf8');
function brainWith(flagOn) {
  if (flagOn) process.env.MEDICARE_QUOTING_APPROVED = 'true';
  else delete process.env.MEDICARE_QUOTING_APPROVED;
  return applyApprovalGates(JSON.parse(raw));
}

const URL = 'https://my.destinationrx.com/hub/s/SB814T87A';
const mobileLead = { postalCode: '36695' };
const draft = `You can compare the 2027 Medicare plans I represent in your area here, on your own time: ${URL}`;
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }

// Switched off (the default until compliance approves)
const off = brainWith(false);
test('off: link not in prompt', () => assert(!brainToSystemPrompt(off).includes(URL)));
test('off: listed as pending', () => assert(off.pendingWorkflows.some((p) => p.includes('Medicare online plan-comparison link'))));
test('off: draft with link is held', () => assert(checkMedicareQuoteLink(draft, { brain: off, leadText: 'medicare' }).hold));

// Switched on
const on = brainWith(true);
test('on: link and rules in prompt', () => {
  const p = brainToSystemPrompt(on);
  assert(p.includes(URL) && p.includes('MEDICARE QUOTE TOOL') && p.includes('Never cold-send'));
});
test('on: Medicare lead passes', () => assert(!checkMedicareQuoteLink(draft, { brain: on, leadText: 'Existing GoHighLevel tags on this contact: Medicare' }).hold));
test('on: turning 65 passes', () => assert(!checkMedicareQuoteLink(draft, { brain: on, leadText: "I'm turning 65 in March" }).hold));
test('on: no Medicare interest is held', () => assert(checkMedicareQuoteLink(draft, { brain: on, leadText: 'Interested in life insurance' }).hold));
test('on: altered link is held', () => assert(checkMedicareQuoteLink(draft.replace('SB814T87A', 'XX1'), { brain: on, leadText: 'medicare' }).hold));
test('on: trailing period is fine', () => assert(!checkMedicareQuoteLink(`${draft}.`, { brain: on, leadText: 'medicare' }).hold));
test('on: carrier name is held', () => assert(checkMedicareQuoteLink(`${draft} Humana plans included!`, { brain: on, leadText: 'medicare' }).hold));
test('on: social post skips interest check', () => assert(!checkMedicareQuoteLink(draft, { brain: on, leadText: null }).hold));
test('message without link is untouched', () => assert(!checkMedicareQuoteLink('Happy to talk Thursday.', { brain: on, leadText: '' }).hold));

// PlanEnroll (other FMO)
const PE = 'https://planenroll.com/?purl=Leon-Grove';
const peDraft = `Here's another place to compare 2027 plans in your area: ${PE}`;
test('on: both links in prompt', () => assert(brainToSystemPrompt(on).includes(PE)));
test('on: PlanEnroll link passes', () => assert(!checkMedicareQuoteLink(peDraft, { brain: on, leadText: 'medicare' }).hold));
test('on: wrong PlanEnroll purl is held', () => assert(checkMedicareQuoteLink(peDraft.replace('Leon-Grove', 'Someone-Else'), { brain: on, leadText: 'medicare' }).hold));
test('on: bare planenroll.com is held', () => assert(checkMedicareQuoteLink('Shop at planenroll.com today', { brain: on, leadText: 'medicare' }).hold));
test('on: two links in one message is held', () => assert(checkMedicareQuoteLink(`${draft} or ${PE}`, { brain: on, leadText: 'medicare' }).hold));
test('PlanEnroll link triggers disclaimer', () => assert(ensureMedicareDisclaimer(peDraft, { brain: on, lead: mobileLead }).disclaimerAppended));
test('off: PlanEnroll link is held', () => assert(checkMedicareQuoteLink(peDraft, { brain: brainWith(false), leadText: 'medicare' }).hold));

// Disclaimer always rides along with the link
test('link alone triggers county disclaimer', () => {
  const r = ensureMedicareDisclaimer(`Compare plans here: ${URL}`, { brain: on, lead: mobileLead });
  assert(r.disclaimerAppended && r.messageText.includes('We do not offer every plan available in your area'));
});
test('link with unknown ZIP is held for county', () => {
  assert(ensureMedicareDisclaimer(`Compare plans here: ${URL}`, { brain: on, lead: {} }).needsArea);
});

console.log(`\n${passed} checks passed`);
