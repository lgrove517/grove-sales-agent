/**
 * Checks the agency brain's rules without any API keys or server:
 *   node test/agency.test.js
 */
const assert = require('assert');
const { loadBrain, brainToSystemPrompt } = require('../src/config/loadBrain');
const {
  checkSeparation, detectDonorHandoff, ensureMedicareDisclaimer, checkMedicareQuoteLink, checkAdvisoryAutoSend,
} = require('../src/config/complianceGuard');

const agency = loadBrain('gfg-agency');
const gfg = loadBrain('grove-financial');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`ok - ${name}`); }
const held = (t) => checkSeparation(t, agency).blocked;
const handoff = (t) => detectDonorHandoff(t, agency);

// Prompt
test('prompt names all three offers', () => {
  const p = brainToSystemPrompt(agency);
  assert(p.includes('Agent Discovery Call') && p.includes('Mentorship and Training') && p.includes('Professional Partner Introduction'));
});
test('prompt carries partner content topics', () => assert(brainToSystemPrompt(agency).includes('Estate liquidity')));
test('prompt says no referral fees', () => assert(/no referral fees/i.test(brainToSystemPrompt(agency))));
test('prompt never uses Dr. in messages rule', () => assert(brainToSystemPrompt(agency).includes('never with "Dr." in front')));

// Drafts that are held
test('income claim is held', () => assert(held('Our agents build six-figure practices.')));
test('earn-up-to claim is held', () => assert(held('You could earn up to $10,000 a month.')));
test('dollar-per-year claim is held', () => assert(held('Top agents make $150k per year.')));
test('referral fee is held', () => assert(held("We'll pay a referral fee for every client you send.")));
test('commission split is held', () => assert(held('We split the commission with partner CPAs.')));
test('securities licensing is held', () => assert(held('We can sponsor your Series 7.')));
test('contract level is held', () => assert(held('You start at 110% commission on annuities.')));
test('advisory content still blocked from auto-send', () => assert(checkAdvisoryAutoSend('Email', 'Leon offers investment advisory services through Gradient Advisors.', agency).blocked));

// Drafts that pass
test('ordinary recruiting draft passes', () => assert(!held('Leon works with licensed Medicare and P&C agents on mentorship, case design and contracting. Would a 20-minute call this week help?')));
test('ordinary CPA draft passes', () => assert(!held('Leon handles the insurance and retirement-income side and sends tax work back to you. Open to a short introduction call?')));

// Lead text routed to Dr. Grove
test('Series 65 interest -> securities tag', () => assert.strictEqual(handoff("I'd like to get my Series 65 too").tagKey, 'securities'));
test('investments interest -> securities tag', () => assert.strictEqual(handoff('I want to do investments eventually').tagKey, 'securities'));
test('referral fee question -> handoff', () => assert.strictEqual(handoff('Do you pay a referral fee?').tagKey, 'handoff'));
test('contract level question -> handoff', () => assert.strictEqual(handoff("What's the contract level on Medicare?").tagKey, 'handoff'));
test('earnings question -> handoff', () => assert(handoff('How much can I make in my first year?')));
test('consumer turning 65 -> consumer tag', () => assert.strictEqual(handoff("I'm turning 65 and need a plan").tagKey, 'consumer'));
test('agent talking about policyholders is not a consumer', () => assert(!handoff('I have 400 auto policyholders and want to add Medicare')));
test('plain agent inquiry is not handed off', () => assert(!handoff('Licensed P&C agent in Mobile, interested in mentorship')));
test('CPA inquiry is not handed off', () => assert(!handoff("I'm a CPA with a lot of clients near retirement")));

// Medicare consumer rules
test('no TPMO disclaimer on agent recruiting', () => {
  const r = ensureMedicareDisclaimer('We help agents grow their Medicare Advantage business.', { brain: agency, lead: {} });
  assert(!r.disclaimerAppended && !r.needsArea);
});
test('GFG still gets the disclaimer', () => assert(ensureMedicareDisclaimer('Medicare Advantage plans', { brain: gfg, lead: { postalCode: '36695' } }).disclaimerAppended));
test('quoting link is held for the agency', () => assert(checkMedicareQuoteLink('Compare: https://my.destinationrx.com/hub/s/SB814T87A', { brain: agency, leadText: 'medicare' }).hold));
test('SOA survey link is held for the agency', () => assert(checkMedicareQuoteLink('https://retireflo.com/leon-grove-chfc-ricp', { brain: agency, leadText: 'medicare' }).hold));

// Tags
test('agency tags are its own', () => assert(agency.agentTags.securities === 'agency-securities-interest' && agency.agentTags.consumer === 'agency-route-to-gfg'));

console.log(`\n${passed} checks passed`);
