/**
 * Agency plan and agency referrals, checked without API keys (throwaway DB):
 *   node test/agencyReferrals.test.js
 * Part 1 tests the projection and scorecard directly; part 2 starts the real
 * server and drives the referral and booked webhooks the way GHL would.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agency-ref-'));
process.env.DATA_DIR = DATA_DIR;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GHL_API_KEY;
delete process.env.GHL_LOCATION_ID;

const db = require('../src/store/db');
const { loadBrain } = require('../src/config/loadBrain');
const { buildAgencyPlan, parseAgencyPlan, project } = require('../src/agents/agencyPlan');
const { parseCases, setCases, recordReferral, buildReferralScorecard } = require('../src/agents/referrals');
const { classifyIntent, runCommand } = require('../src/agents/orchestrator');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
const gfg = { ...loadBrain('grove-financial'), clientId: 'grove-financial' };
const rowVal = (r, title, label) => {
  const s = r.sections.find((x) => x.title.startsWith(title));
  const row = s && s.rows.find((x) => String(x[0]).startsWith(label));
  return row && row[1];
};

// ---------------------------------------------------------------- part 1
test('reads an agency plan however it is typed', () => {
  assert.deepStrictEqual(parseAgencyPlan('agency plan 6 agents, 250 cases each, 10% referral rate, 30% close rate, $150,000 average account, 12 years, starting AUM $100,000'),
    { agents: 6, casesPerAgent: 250, referralRate: 0.1, closeRate: 0.3, avgAccount: 150000, years: 12, startingAum: 100000 });
  const p = parseAgencyPlan('agency plan 3 agents, referral rate 8%, close rate 35%, average account $175k, 4% growth, outflows 5%');
  assert.deepStrictEqual([p.agents, p.referralRate, p.closeRate, p.avgAccount, p.marketGrowth, p.outflows], [3, 0.08, 0.35, 175000, 0.04, 0.05]);
});

test('the projection compounds the book and the Medicare base', () => {
  const { rows } = project({ agents: 6, casesPerAgent: 250, referralRate: 0.1, closeRate: 0.3, avgAccount: 150000, marketGrowth: 0.04, outflows: 0.05,
    medicareRetention: 0.85, startingAum: 0, years: 2, feeRate: 0.01, payout: 0.7, renewalMonthly: 28 });
  // 1,500 cases -> 150 introduced -> 45 clients -> $6.75M a year
  assert.strictEqual(rows[0].newClients, 45);
  assert.strictEqual(rows[0].book, 6750000);
  assert.strictEqual(Math.round(rows[1].book), Math.round(6750000 * 0.99 + 6750000));
  assert.strictEqual(rows[0].renewals, 0); // no renewals in year one
  assert.strictEqual(Math.round(rows[1].renewals), Math.round(1500 * 0.85 * 28 * 12));
  assert.strictEqual(Math.round(rows[0].advisoryPay), 47250); // $6.75M x 1% x 70%
});

test('agency plan labels placeholders, keeps the compliance notes and saves typed numbers', () => {
  const b = { ...gfg, clientId: 'agency-plan-test' };
  const r = buildAgencyPlan({ brain: b, instruction: 'agency plan 6 agents, 250 cases each' });
  assert.ok(r.agencyPlan && r.monthlyReport);
  assert.strictEqual(rowVal(r, 'Each year', 'Medicare cases'), '1,500 (6 agents x 250)');
  assert.ok(r.sections.some((s) => s.title === 'Keep it compliant'));
  assert.ok(/placeholders/.test(r.summary), r.summary);
  assert.ok(/Gradient fee statement, Jan 2025: 70% payout/.test(JSON.stringify(r.sections)));
  const again = buildAgencyPlan({ brain: b, instruction: 'agency plan' });
  assert.strictEqual(rowVal(again, 'Each year', 'Medicare cases'), '1,500 (6 agents x 250)');
});

test('records Medicare cases by agent and month', () => {
  const now = new Date('2026-10-31T12:00:00');
  assert.deepStrictEqual(parseCases('Marcus Lee wrote 22 Medicare cases in November', now), { agent: 'Marcus Lee', cases: 22, month: '2026-11' });
  assert.deepStrictEqual(parseCases('Tanya enrolled 18 cases last month', now), { agent: 'Tanya', cases: 18, month: '2026-09' });
  assert.strictEqual(parseCases('income plan $120,000'), null);
});

test('scorecard credits each agent: cases, referrals, booked, won', () => {
  const b = { ...gfg, clientId: 'score-test' };
  const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  setCases({ brand: b.clientId, agent: 'Marcus Lee', month, cases: 20 });
  setCases({ brand: b.clientId, agent: 'Tanya Ruiz', month, cases: 10 });
  const r1 = recordReferral({ brain: b, firstName: 'Ann', phone: '+12515550001', referredBy: 'marcus lee', interest: 'CD renewal' });
  recordReferral({ brain: b, firstName: 'Bo', phone: '+12515550002', referredBy: 'Marcus Lee', interest: 'retirement income' });
  db.updateLeadSequence(r1.leadId, { bookedAt: db.toDbTime(new Date()) });
  db.updateLeadStatus(r1.leadId, 'won');
  const r = buildReferralScorecard({ brain: b, instruction: 'referral scorecard' });
  const marcus = r.sections[0].rows.find((x) => x[0] === 'Marcus Lee')[1];
  assert.strictEqual(marcus, '20 cases · 2 referred (10%) · 1 booked · 1 became clients');
  assert.ok(r.sections[0].rows.find((x) => x[0] === 'Tanya Ruiz'));
  assert.strictEqual(rowVal(r, 'Agency total', 'Clients referred to you'), '2 (6.7% of cases)');
  // a referral is held for the owner: no AI follow-ups, no booking sequence
  const lead = db.getLead(r1.leadId);
  assert.strictEqual(lead.referred_by, 'Marcus Lee');
  assert.strictEqual(lead.seq_status, 'held');
});

test('routes the new commands without an API key', async () => {
  const cases = [
    ['agency plan 6 agents, 250 cases each', 'agency_plan'],
    ['what would 4 Medicare agents do for my AUM in 10 years', 'agency_plan'],
    ['referral scorecard this year', 'referral_scorecard'],
    ['Marcus wrote 22 Medicare cases in November', 'set_cases'],
    ['income plan $1M AUM next quarter', 'income_plan'],
    ['booking report', 'booking_report'],
  ];
  for (const [line, intent] of cases) assert.strictEqual((await classifyIntent(line)).intent, intent, line);
  const saved = await runCommand({ brain: { ...gfg, clientId: 'cmd-test' }, instruction: 'Dana wrote 15 Medicare cases this month' });
  assert.ok(/Saved: Dana wrote 15 Medicare cases/.test(saved.response.message), saved.response.message);
});

// ---------------------------------------------------------------- part 2
const PORT = 3990 + Math.floor(Math.random() * 9);
const TOKEN = 'test-token';
let server;
const base = `http://127.0.0.1:${PORT}`;
const post = (p, body) => fetch(`${base}${p}${p.includes('?') ? '&' : '?'}token=${TOKEN}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

async function startServer() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), WEBHOOK_TOKEN: TOKEN, DATA_DIR, AUTO_FOLLOWUP: 'false', NODE_ENV: 'test', DEFAULT_BRAIN: 'grove-financial' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100; i++) {
    if (/listening/.test(log)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${log}`);
}

test('webhook: a referral is recorded, held for the owner and never messaged', async () => {
  await startServer();
  const r = await post('/webhook/referral', { contact_id: 'c-ref1', first_name: 'Cal', phone: '+12515550003', customData: { referred_by: 'Marcus Lee', interest: 'CD maturing in March' } });
  assert.ok(r.leadId && r.created && r.referredBy === 'Marcus Lee', JSON.stringify(r));
  const lead = db.findLeadByGhlContactId('c-ref1');
  assert.strictEqual(lead.status, 'needs_human');
  assert.strictEqual(lead.seq_status, 'held');
  assert.strictEqual(lead.interest, 'CD maturing in March');
  const touches = db.db.prepare('SELECT COUNT(*) n FROM touches WHERE lead_id = ?').get(lead.id).n;
  assert.strictEqual(touches, 0);
  const bad = await post('/webhook/referral', { contact_id: 'c-ref2' });
  assert.ok(/referring agent/.test(bad.error));
});

test('webhook: the owner\'s booking of a referral counts as booked-by-you', async () => {
  const r = await post('/webhook/status?status=booked', { contact_id: 'c-ref1' });
  assert.strictEqual(r.status, 'booked');
  const lead = db.findLeadByGhlContactId('c-ref1');
  assert.ok(lead.booked_at);
  const credit = db.db.prepare(`SELECT action FROM events WHERE lead_id = ? AND agent = 'statusSync' AND action LIKE 'booked_by_%'`).get(lead.id);
  assert.strictEqual(credit.action, 'booked_by_you');
});

(async () => {
  try {
    for (const [name, fn] of tests) {
      await fn();
      passed++;
      console.log(`ok - ${name}`);
    }
    console.log(`\n${passed} checks passed`);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    if (server) server.kill();
  }
})();
