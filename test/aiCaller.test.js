/**
 * Phase 2 AI caller, checked without API keys (DRY_RUN, throwaway DB):
 *   node test/aiCaller.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aicaller-'));
process.env.DATA_DIR = DATA_DIR;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GHL_API_KEY;
delete process.env.GHL_LOCATION_ID;
delete process.env.AI_CALLER_APPROVED;

const caller = require('../src/config/aiCaller');
const agent = require('../src/agents/aiCallerAgent');
const db = require('../src/store/db');
const { loadBrain } = require('../src/config/loadBrain');
const { buildBookingReport } = require('../src/agents/bookingReport');

const brain = loadBrain('grove-financial');
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
let n = 0;
const mkLead = (extra = {}) => {
  const id = db.insertLead({ brand: 'grove-financial', firstName: `Caller${++n}`, phone: '+12515550199', email: `c${n}@example.com`, source: 'form', state: 'AL', status: 'active', ghlContactId: `c-call-${n}`, ...extra });
  return id;
};

test('off until the script is approved (AI_CALLER_APPROVED)', () => {
  assert.strictEqual(caller.callerConfig(brain), null);
  assert.ok(caller.callerConfig(brain, { ignoreApproval: true }));
  process.env.AI_CALLER_APPROVED = 'true';
  assert.ok(caller.callerConfig(brain).approved);
});
test('call consent must be documented - email/text opt-in is not enough', () => {
  const cfg = caller.callerConfig(brain);
  assert.ok(!caller.hasCallConsent({ tags: ['opt-in', 'sms-opt-in'] }, cfg));
  assert.ok(caller.hasCallConsent({ tags: ['ai-call-consent'] }, cfg));
  assert.ok(caller.hasCallConsent({ customData: { call_consent: 'Yes' } }, cfg));
});
test('calling window is in the lead\'s time zone', () => {
  const cfg = caller.callerConfig(brain);
  assert.strictEqual(caller.windowFor(cfg, 'Florida').timezone, 'America/New_York');
  assert.strictEqual(caller.windowFor(cfg, 'AZ').timezone, 'America/Phoenix');
  const unknown = caller.windowFor(cfg, '');
  assert.deepStrictEqual([unknown.startHour, unknown.endHour], [12, 17]);
});
test('a form at 2 AM is called at 10 AM their time', () => {
  const win = caller.windowFor(caller.callerConfig(brain), 'AL');
  const t = caller.nextCallTime(win, new Date('2026-10-27T07:00:00Z')); // Tue 2:00 AM CDT
  assert.strictEqual(t.toISOString(), '2026-10-27T15:00:00.000Z'); // Tue 10:00 AM CDT
});
test('Friday evening waits for Monday; Saturday/Sunday never', () => {
  const win = caller.windowFor(caller.callerConfig(brain), 'AL');
  const t = caller.nextCallTime(win, new Date('2026-10-31T00:30:00Z')); // Fri 7:30 PM CDT
  assert.strictEqual(t.toISOString(), '2026-11-02T16:00:00.000Z'); // Mon 10:00 AM CST (clocks changed Nov 1)
});
test('inside the window it calls right away', () => {
  const win = caller.windowFor(caller.callerConfig(brain), 'FL');
  const from = new Date('2026-10-27T15:30:00Z'); // Tue 11:30 AM EDT
  assert.strictEqual(caller.nextCallTime(win, from).toISOString(), from.toISOString());
});
test('Medicare leads are not AI-called', async () => {
  const id = mkLead();
  const r = await agent.scheduleFirstCall({ brain, leadId: id, ghlContactId: 'x', phone: '+1', state: 'AL', interest: 'Turning 65, need Medicare help', tags: ['ai-call-consent'] });
  assert.strictEqual(r.scheduled, false);
  assert.strictEqual(db.getLead(id).call_status, 'excluded_medicare');
});
test('no consent, no call', async () => {
  const id = mkLead();
  const r = await agent.scheduleFirstCall({ brain, leadId: id, ghlContactId: 'x', phone: '+1', state: 'AL', tags: ['opt-in'] });
  assert.strictEqual(r.reason, 'no call consent on file');
});

test('sweep: review mode readies the call (nothing dialed), cap of 5 per day holds the rest', async () => {
  const now = new Date('2026-10-27T15:00:00Z'); // Tue 10 AM CDT
  const ids = [];
  for (let i = 0; i < 6; i++) {
    const id = mkLead();
    db.db.prepare('UPDATE leads SET created_at = ? WHERE id = ?').run('2026-10-27 07:00:00', id);
    await agent.scheduleFirstCall({ brain, leadId: id, ghlContactId: `c-call-${n}`, phone: '+1', state: 'AL', interest: 'life insurance', tags: ['ai-call-consent'], now: new Date('2026-10-27T07:00:00Z') });
    ids.push(id);
  }
  const r = await agent.callSweep(brain, now);
  const ready = r.processed.filter((p) => p.reviewMode).length;
  assert.strictEqual(ready, 5);
  assert.ok(r.processed.some((p) => p.waiting === 'daily cap reached'));
  assert.strictEqual(db.getLead(ids[0]).call_status, 'review_ready');
  assert.strictEqual(db.getLead(ids[0]).call_attempts, 1);
});
test('sweep: a booked or replied lead\'s call is cancelled; old leads expire', async () => {
  const a = mkLead();
  db.updateLeadCall(a, { callStatus: 'scheduled', callDueAt: '2026-10-28 15:00:00' });
  db.updateLeadSequence(a, { seqStatus: 'stopped_replied' });
  const b = mkLead();
  db.db.prepare('UPDATE leads SET created_at = ? WHERE id = ?').run('2026-10-20 15:00:00', b);
  db.updateLeadCall(b, { callStatus: 'scheduled', callDueAt: '2026-10-28 15:00:00' });
  await agent.callSweep(brain, new Date('2026-10-28T15:05:00Z'));
  assert.strictEqual(db.getLead(a).call_status, 'cancelled');
  assert.strictEqual(db.getLead(b).call_status, 'expired');
});
test('result: no answer is retried once on another day, then stops', async () => {
  const id = mkLead();
  db.updateLeadCall(id, { callStatus: 'placed', callAttempts: 1 });
  const r = await agent.handleCallResult({ brain, lead: db.getLead(id), callStatus: 'no-answer', now: new Date('2026-10-27T15:10:00Z') });
  assert.strictEqual(r.outcome, 'no_answer');
  assert.ok(r.retryAt && r.retryAt > new Date('2026-10-28T10:00:00Z'));
  assert.strictEqual(db.getLead(id).call_status, 'scheduled');
  db.updateLeadCall(id, { callStatus: 'placed', callAttempts: 2 });
  await agent.handleCallResult({ brain, lead: db.getLead(id), callStatus: 'no-answer' });
  assert.strictEqual(db.getLead(id).call_status, 'no_answer');
});
test('result: "stop calling me" stops calls, texts and emails', async () => {
  const id = mkLead();
  db.updateLeadSequence(id, { seqStatus: 'active' });
  db.updateLeadCall(id, { callStatus: 'placed', callAttempts: 1 });
  const r = await agent.handleCallResult({ brain, lead: db.getLead(id), callStatus: 'completed', transcript: 'AI: Hi... Person: Please stop calling me.' });
  assert.strictEqual(r.outcome, 'opted_out');
  const lead = db.getLead(id);
  assert.strictEqual(lead.status, 'opted_out');
  assert.strictEqual(lead.seq_status, 'stopped_opted_out');
});
test('result: a 401(k) mention is flagged for Leon', async () => {
  const id = mkLead();
  db.updateLeadCall(id, { callStatus: 'placed', callAttempts: 1 });
  const r = await agent.handleCallResult({ brain, lead: db.getLead(id), callStatus: 'completed', summary: 'They want to talk about rolling over a 401(k).' });
  assert.ok(r.tags.includes('gwm-investment-inquiry'));
});
test('script renders for review with name and interest filled in', () => {
  const s = caller.renderScript(brain, { firstName: 'Ann', interest: 'long-term care' });
  assert.ok(/AI assistant calling on behalf of Leon Grove/.test(s));
  assert.ok(/Ann/.test(s) && /long-term care/.test(s));
  assert.ok(/say "stop"/.test(s));
  assert.ok(!/\{firstName\}|\{interest\}/.test(s));
});

// Server: lead webhook schedules the call, reply cancels it, call webhook reads it.
const PORT = 4000 + Math.floor(Math.random() * 90);
const TOKEN = 't';
let server;
const base = `http://127.0.0.1:${PORT}`;
const post = (p, body) => fetch(`${base}${p}${p.includes('?') ? '&' : '?'}token=${TOKEN}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

test('webhook: consented form lead gets the email AND a call scheduled in their window', async () => {
  server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), WEBHOOK_TOKEN: TOKEN, DATA_DIR, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100 && !/listening/.test(log); i++) await new Promise((r) => setTimeout(r, 100));
  const r = await post('/webhook/lead', { contact_id: 'c-srv1', first_name: 'Eve', email: 'eve@example.com', phone: '+12515550123', state: 'AL', contact_source: 'form: Contact', message: 'Life insurance for my family', tags: 'opt-in, ai-call-consent, send-to-sales-agent' });
  assert.ok(r.sequence && r.sequence.started, JSON.stringify(r));
  assert.ok(r.call && r.call.scheduled, JSON.stringify(r.call));
  assert.ok(caller.inWindow(caller.windowFor(caller.callerConfig(brain), 'AL'), new Date(r.call.dueAt)));
});
test('webhook: a reply cancels the scheduled call', async () => {
  await post('/webhook/reply', { contact_id: 'c-srv1', customData: { reply_text: 'Can we talk Thursday?', reply_channel: 'Email' } });
  assert.strictEqual(db.findLeadByGhlContactId('c-srv1').call_status, 'cancelled');
});
test('webhook: call result is read and noted', async () => {
  await post('/webhook/lead', { contact_id: 'c-srv2', first_name: 'Fay', email: 'fay@example.com', phone: '+12515550124', state: 'FL', contact_source: 'form', tags: 'opt-in, ai-call-consent, send-to-sales-agent' });
  const r = await post('/webhook/call', { contact_id: 'c-srv2', customData: { call_status: 'voicemail' } });
  assert.strictEqual(r.outcome, 'voicemail');
});

test('booking report shows the AI calls section', () => {
  const rep = buildBookingReport({ brain, instruction: 'booking report October 2026', now: new Date('2026-10-28T15:00:00Z') });
  const sec = rep.sections.find((s) => s.title === 'AI calls');
  assert.ok(sec, JSON.stringify(rep.sections.map((s) => s.title)));
});

(async () => {
  try {
    for (const [name, fn] of tests) { await fn(); console.log(`ok - ${name}`); }
    console.log(`\n${tests.length} checks passed`);
  } catch (e) { console.error(e); process.exitCode = 1; } finally { if (server) server.kill(); }
})();
