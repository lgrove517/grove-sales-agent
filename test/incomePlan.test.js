/**
 * Income plan, checked without API keys (throwaway DB):
 *   node test/incomePlan.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'incomeplan-'));
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GHL_API_KEY;
delete process.env.GHL_LOCATION_ID;

const db = require('../src/store/db');
const { buildIncomePlan, parseIncomeGoal, workBackward } = require('../src/agents/incomePlan');
const { classifyIntent } = require('../src/agents/orchestrator');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
const brain = { clientId: 'plan-test', businessName: 'Plan Test' };
const rowVal = (r, label) => {
  for (const s of r.sections) for (const row of s.rows) if (String(row[0]).startsWith(label)) return row[1];
  return undefined;
};

test('reads goals in the ways people type them', () => {
  const g = parseIncomeGoal('income plan $120,000');
  assert.strictEqual(g.goal, 120000); assert.strictEqual(g.period, 'year'); assert.strictEqual(g.line, null); assert.deepStrictEqual(g.rates, {});
  assert.strictEqual(parseIncomeGoal('income plan 150k').goal, 150000);
  const m = parseIncomeGoal('how many leads do I need to make $10,000 a month?');
  assert.strictEqual(m.goal, 10000);
  assert.strictEqual(m.period, 'month');
});

test('reads typed rates and keeps them out of the goal', () => {
  const p = parseIncomeGoal('income plan $120,000 with average commission $1,800, close rate 35%, show rate 75%, booking rate 20%');
  assert.strictEqual(p.goal, 120000);
  assert.deepStrictEqual(p.rates, { avgCommission: 1800, closeRate: 0.35, showRate: 0.75, bookingRate: 0.2 });
  const q = parseIncomeGoal('$2,500 per sale, income plan 90k');
  assert.strictEqual(q.rates.avgCommission, 2500);
  assert.strictEqual(q.goal, 90000);
});

test('the arithmetic rounds up at every step', () => {
  // $10,000 / $2,000 = 5 sales; /0.3 = 16.7 -> 17 held; /0.8 = 21.25 -> 22 booked; /0.15 = 146.7 -> 147 leads
  assert.deepStrictEqual(workBackward({ monthlyIncome: 10000, avgCommission: 2000, closeRate: 0.3, showRate: 0.8, bookingRate: 0.15 }),
    { sales: 5, held: 17, booked: 22, leads: 147 });
});

test('with no history, every rate is labeled a starting assumption', () => {
  const r = buildIncomePlan({ brain, instruction: 'income plan $120,000' });
  assert.ok(r.incomePlan && r.monthlyReport);
  assert.strictEqual(rowVal(r, 'Opted-in leads (at'), 147);
  assert.ok(/4 of the numbers are placeholders/.test(r.summary), r.summary);
  assert.ok(r.sections.some((s) => s.title === 'Make it yours'));
});

test('typed rates are used, saved, and reused next time', () => {
  buildIncomePlan({ brain, instruction: 'income plan $120,000 with average commission $2,500, close rate 40%, show rate 75%, booking rate 20%' });
  const r = buildIncomePlan({ brain, instruction: 'income plan $120,000' });
  // 10000/2500 = 4 sales; /0.4 = 10 held; /0.75 = 13.3 -> 14 booked; /0.2 = 70 leads
  assert.strictEqual(rowVal(r, 'Opted-in leads (at'), 70);
  assert.ok(!r.sections.some((s) => s.title === 'Make it yours'));
  assert.ok(/your earlier entry/.test(JSON.stringify(r.sections)));
});

test('booking rate comes from the agent\'s own results once there are enough', () => {
  const b2 = { clientId: 'plan-measured', businessName: 'Measured' };
  for (let i = 0; i < 40; i++) {
    const id = db.insertLead({ brand: b2.clientId, firstName: `L${i}`, source: 'form' });
    db.updateLeadSequence(id, { optInVia: 'form', ...(i < 10 ? { bookedAt: db.toDbTime(new Date()) } : {}) });
  }
  const r = buildIncomePlan({ brain: b2, instruction: 'income plan $60,000' });
  assert.ok(/measured: 10 booked of 40/.test(JSON.stringify(r.sections)), JSON.stringify(r.sections));
  assert.strictEqual(r.sections.find((x) => x.title.startsWith('Where you are now')).rows[0][1], 40); // last 30 days
  // 5000/2000 = 3 sales; /0.3 = 10; /0.8 = 12.5 -> 13 booked; /0.25 = 52 leads
  assert.strictEqual(rowVal(r, 'Opted-in leads (at'), 52);
});

test('asks for a goal when there is none', () => {
  const r = buildIncomePlan({ brain, instruction: 'income plan' });
  assert.ok(/Tell me the goal/.test(r.message));
});

test('the command center routes it without an API key', async () => {
  for (const line of ['income plan $120,000', 'how many leads do I need to make $10,000 a month?', 'I want to earn 150k a year']) {
    const routed = await classifyIntent(line);
    assert.strictEqual(routed.intent, 'income_plan', line);
  }
  assert.strictEqual((await classifyIntent('booking report')).intent, 'booking_report');
  assert.strictEqual((await classifyIntent('spent $250 on Facebook in November')).intent, 'set_spend');
});


const { loadBrain } = require('../src/config/loadBrain');
const gfg = { ...loadBrain('grove-financial'), clientId: 'plan-gfg' };

test('reads the line of business, the goal type and the period', () => {
  const a = parseIncomeGoal('income plan $2M annuity premium at 6%, average case $100,000');
  assert.deepStrictEqual([a.line, a.goal, a.goalType, a.facts.rate, a.facts.caseSize], ['annuity', 2000000, 'production', 0.06, 100000]);
  const b = parseIncomeGoal('income plan $120,000 from annuities at 6%');
  assert.deepStrictEqual([b.line, b.goal, b.goalType], ['annuity', 120000, 'income']);
  const c = parseIncomeGoal('I want to generate $1M in AUM next quarter');
  assert.deepStrictEqual([c.line, c.goal, c.goalType, c.period], ['aum', 1000000, 'production', 'quarter']);
  assert.strictEqual(parseIncomeGoal('income plan $20,000 from Medicare plan changes').line, 'medicare_switch');
  assert.strictEqual(parseIncomeGoal('income plan $25,000 from new to Medicare').line, 'medicare_new');
  assert.strictEqual(parseIncomeGoal('income plan $30,000 in planning fees, $1,500 per plan').facts.fee, 1500);
});

test('life insurance uses 90% of annual premium from the GFG settings', () => {
  const r = buildIncomePlan({ brain: gfg, instruction: 'income plan $90,000 from life insurance, average premium $2,000' });
  // $2,000 x 90% = $1,800 per sale; $90,000 / $1,800 = 50 sales a year
  assert.strictEqual(rowVal(r, 'Sales needed a year'), 50);
  assert.ok(/Dr. Grove, Oct 31 2026: 90%/.test(JSON.stringify(r.sections)));
});

test('an annuity production goal converts to cases and commission', () => {
  const r = buildIncomePlan({ brain: gfg, instruction: 'income plan $2M annuity premium, average case $100,000' });
  assert.strictEqual(rowVal(r, 'Sales needed a year'), 20);
  assert.ok(/\$120,000 first-year commission/.test(rowVal(r, '  that is $2,000,000')), rowVal(r, '  that is $2,000,000'));
});

test('Medicare counts enrollments and shows the renewals they add', () => {
  const r = buildIncomePlan({ brain: gfg, instruction: 'income plan $25,600 from new to Medicare' });
  assert.strictEqual(rowVal(r, 'Enrollments needed a year'), 40); // 25,600 / 640
  assert.ok(/\$13,440 a year/.test(rowVal(r, '  renewals')), rowVal(r, '  renewals')); // 40 x $28 x 12
});

test('an AUM goal stays in assets, shows the payout and never markets investments', () => {
  const r = buildIncomePlan({ brain: gfg, instruction: 'income plan $1M AUM next quarter, average account $250,000' });
  assert.strictEqual(rowVal(r, 'New accounts needed'), 4);
  assert.ok(/\$7,000 a year/.test(rowVal(r, 'What those assets pay you')), rowVal(r, 'What those assets pay you')); // 1M x 1% x 70%
  assert.ok(r.sections.some((s) => s.title === 'Note' && /never discusses investments/.test(s.rows[0][0])));
  assert.ok(r.sections.some((s) => s.title === 'Working backward (whole quarter)'));
  assert.ok(/Gradient fee statement, Jan 2025: 70% payout/.test(JSON.stringify(r.sections)));
  assert.ok(/placeholder/.test(JSON.stringify(r.sections))); // the fee rate is still a placeholder
});

test('line rates are saved under the line, not over the general ones', () => {
  buildIncomePlan({ brain: gfg, instruction: 'income plan $2M annuity premium, close rate 50%' });
  const r = buildIncomePlan({ brain: gfg, instruction: 'income plan $2M annuity premium' });
  assert.ok(JSON.stringify(r.sections).includes('Close rate (of appointments held): 50%'));
  const g = buildIncomePlan({ brain: gfg, instruction: 'income plan $120,000' });
  assert.ok(JSON.stringify(g.sections).includes('Close rate (of appointments held): 30%'));
});

test('routes line-of-business goals without an API key', async () => {
  for (const line of ['income plan $2M annuity premium at 6%', 'I want to generate $1M in AUM next quarter', 'income plan $25,000 from Medicare']) {
    assert.strictEqual((await classifyIntent(line)).intent, 'income_plan', line);
  }
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
  }
  console.log(`\n${passed}/${tests.length} income plan tests passed`);
})();
