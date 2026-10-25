/**
 * Phase 1 booking sequence, checked without API keys (DRY_RUN, throwaway DB):
 *   node test/bookingSequence.test.js
 * Part 1 tests the rules directly; part 2 starts the real server on a spare
 * port and drives the webhooks (lead -> clicks/opens -> follow-ups -> reply
 * / booking) the way GoHighLevel would.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bookseq-'));
process.env.DATA_DIR = DATA_DIR;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GHL_API_KEY;
delete process.env.GHL_LOCATION_ID;
process.env.PUBLIC_BASE_URL = 'https://agent.example.com';

const seq = require('../src/config/bookingSequence');
const db = require('../src/store/db');
const { loadBrain } = require('../src/config/loadBrain');
const { runFollowUpSweep } = require('../src/scheduler/followUpScheduler');
const { buildBookingReport, parseSpend } = require('../src/agents/bookingReport');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const brain = loadBrain('grove-financial');
const cfg = seq.sequenceConfig(brain);

// ---------------------------------------------------------------- part 1
test('GFG has the booking sequence on, day 1/3/7', () => {
  assert.ok(cfg);
  assert.deepStrictEqual(cfg.steps.map((s) => s.day), [1, 3, 7]);
});
test('form, referral and RetireFlo leads are opted in', () => {
  assert.ok(seq.checkOptIn({ source: 'form: LTC Seminar' }, cfg).optedIn);
  assert.ok(seq.checkOptIn({ source: 'Referral' }, cfg).optedIn);
  assert.ok(seq.checkOptIn({ source: 'RetireFlo survey' }, cfg).optedIn);
  assert.ok(seq.checkOptIn({ source: 'CSV import', tags: ['Opt-In'] }, cfg).optedIn);
  assert.ok(seq.checkOptIn({ source: 'gohighlevel', customData: { opt_in: 'yes' } }, cfg).optedIn);
});
test('list imports and plain CRM contacts are not', () => {
  assert.ok(!seq.checkOptIn({ source: 'CSV import' }, cfg).optedIn);
  assert.ok(!seq.checkOptIn({ source: 'gohighlevel', tags: ['medicare'] }, cfg).optedIn);
});
test('a DND tag beats an opt-in', () => {
  const r = seq.checkOptIn({ source: 'form', tags: ['DND'] }, cfg);
  assert.ok(!r.optedIn && r.blocked);
});
test('text consent only from the consent tag or field', () => {
  assert.strictEqual(seq.checkOptIn({ source: 'form' }, cfg).smsConsent, false);
  assert.strictEqual(seq.checkOptIn({ source: 'form', tags: ['sms-opt-in'] }, cfg).smsConsent, true);
});
test('one link per message: AI links removed, scheduling link added once', () => {
  const out = seq.applySingleLink('Hi Ann, book here: https://evil.example.com/x and see https://grove.com.', 'https://agent.example.com/go/abc');
  assert.strictEqual((out.match(/https?:\/\//g) || []).length, 1);
  assert.ok(out.endsWith('https://agent.example.com/go/abc'));
});
test('texts get STOP wording, emails an unsubscribe line', () => {
  assert.ok(/Reply STOP/.test(seq.ensureSmsOptOut('Hi')));
  assert.ok(/unsubscribe/.test(seq.ensureEmailOptOut('Hi')));
});
test('tracked link points at /go and forwards to the page with UTM tags', () => {
  const { link, destination } = seq.linkFor(cfg, { step: 2, channel: 'SMS', code: 'abc' });
  assert.strictEqual(link, 'https://agent.example.com/go/abc');
  const u = new URL(destination);
  assert.strictEqual(u.searchParams.get('utm_medium'), 'sms');
  assert.strictEqual(u.searchParams.get('utm_content'), 'day3');
});
test('send window: weekdays 9-7 Central only', () => {
  assert.ok(seq.inSendWindow(cfg, new Date('2026-10-26T15:00:00Z'))); // Mon 10 AM CDT
  assert.ok(!seq.inSendWindow(cfg, new Date('2026-10-27T01:30:00Z'))); // Mon 8:30 PM CDT
  assert.ok(!seq.inSendWindow(cfg, new Date('2026-10-25T16:00:00Z'))); // Sunday
});
test('texts need a phone AND consent, else email', () => {
  assert.strictEqual(seq.channelFor('SMS', { email: 'a@b.c', phone: '1', sms_consent: 0 }), 'Email');
  assert.strictEqual(seq.channelFor('SMS', { email: 'a@b.c', phone: '1', sms_consent: 1 }), 'SMS');
  assert.strictEqual(seq.channelFor('Email', { phone: '1', sms_consent: 0 }), null);
});
test('spend sentences are understood', () => {
  const now = new Date('2026-10-25T15:00:00Z');
  assert.deepStrictEqual(parseSpend('spent $250 on Facebook in November', now), { amount: 250, source: 'facebook', month: '2026-11' });
  assert.deepStrictEqual(parseSpend('I spent 1,200 on google ads this month', now), { amount: 1200, source: 'google', month: '2026-10' });
});

test('scheduler sends due steps in DRY_RUN, falls back to email without consent, then completes', async () => {
  const started = '2026-10-19 15:00:00'; // a Monday
  const id = db.insertLead({ brand: 'grove-financial', firstName: 'Sweep', email: 's@example.com', phone: '+12515550100', source: 'form', status: 'active', ghlContactId: 'c-sweep' });
  db.updateLeadSequence(id, { seqStatus: 'active', seqStep: 0, seqStartedAt: started, optInVia: 'source: form', smsConsent: false, interest: 'long-term care' });

  let r = await runFollowUpSweep({ brand: 'grove-financial', now: new Date('2026-10-20T15:30:00Z') }); // day 1, Tue 10:30
  const mine = (res) => res.processed.find((p) => p.leadId === id);
  assert.ok(mine(r) && mine(r).sent && mine(r).channel === 'Email');
  assert.strictEqual(db.getLead(id).seq_step, 1);

  r = await runFollowUpSweep({ brand: 'grove-financial', now: new Date('2026-10-20T16:30:00Z') }); // nothing new due
  assert.ok(!mine(r));

  r = await runFollowUpSweep({ brand: 'grove-financial', now: new Date('2026-10-22T15:30:00Z') }); // day 3: SMS step
  assert.strictEqual(mine(r).channel, 'Email', 'no text consent -> email');

  r = await runFollowUpSweep({ brand: 'grove-financial', now: new Date('2026-10-25T16:00:00Z') }); // Sunday: waits
  assert.strictEqual(r.ran, false);

  r = await runFollowUpSweep({ brand: 'grove-financial', now: new Date('2026-10-26T15:30:00Z') }); // day 7
  assert.ok(mine(r).sent);
  assert.strictEqual(db.getLead(id).seq_status, 'completed');
  const touches = db.db.prepare('SELECT * FROM touches WHERE lead_id = ? ORDER BY step').all(id);
  assert.deepStrictEqual(touches.map((t) => t.step), [1, 2, 3]);
  assert.ok(touches.every((t) => t.mode === 'dry_run'));
});

test('a lead with text consent gets the day 3 step as a text with STOP wording', async () => {
  const id = db.insertLead({ brand: 'grove-financial', firstName: 'Texter', email: 't@example.com', phone: '+12515550101', source: 'form', status: 'active', ghlContactId: 'c-text' });
  db.updateLeadSequence(id, { seqStatus: 'active', seqStep: 1, seqStartedAt: '2026-10-19 15:00:00', smsConsent: true });
  const r = await runFollowUpSweep({ brand: 'grove-financial', now: new Date('2026-10-22T15:30:00Z') });
  const p = r.processed.find((x) => x.leadId === id);
  assert.strictEqual(p.channel, 'SMS');
  const ev = db.latestEvent(id, 'followUp');
  const msg = JSON.parse(ev.detail).message;
  assert.ok(/Reply STOP/.test(msg));
  assert.strictEqual((msg.match(/https?:\/\//g) || []).length, 1);
});

// ---------------------------------------------------------------- part 2
const PORT = 3900 + Math.floor(Math.random() * 90);
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

test('webhook: opted-in form lead starts the sequence with one tracked link', async () => {
  await startServer();
  const r = await post('/webhook/lead', { contact_id: 'c-web1', first_name: 'Ann', email: 'ann@example.com', phone: '+12515550102', contact_source: 'form: LTC Seminar', message: 'Interested in long-term care', tags: 'send-to-sales-agent' });
  assert.ok(r.sequence && r.sequence.started, JSON.stringify(r));
  assert.strictEqual(r.sequence.channel, 'Email');
  assert.ok(r.sequence.link.startsWith('https://agent.example.com/go/'));
  const lead = db.findLeadByGhlContactId('c-web1');
  assert.strictEqual(lead.seq_status, 'active');
  assert.strictEqual(lead.interest, 'Interested in long-term care');
});

test('webhook: a contact with no opt-in is not contacted', async () => {
  const r = await post('/webhook/lead', { contact_id: 'c-web2', first_name: 'Bob', email: 'bob@example.com', contact_source: 'CSV import', tags: 'send-to-sales-agent' });
  assert.strictEqual(r.sendResult.reason, 'no opt-in on file');
  assert.strictEqual(db.findLeadByGhlContactId('c-web2').seq_status, 'not_opted_in');
  assert.strictEqual(db.db.prepare("SELECT COUNT(*) n FROM touches t JOIN leads l ON l.id = t.lead_id WHERE l.ghl_contact_id = 'c-web2'").get().n, 0);
});

test('tracking: open pixel and click are counted; link scanners are not', async () => {
  const lead = db.findLeadByGhlContactId('c-web1');
  const touch = db.db.prepare('SELECT * FROM touches WHERE lead_id = ?').get(lead.id);
  const gif = await fetch(`${base}/o/${touch.code}.gif`);
  assert.strictEqual(gif.headers.get('content-type'), 'image/gif');
  const scanner = await fetch(`${base}/go/${touch.code}`, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (compatible; Proofpoint URL Defense)' } });
  assert.strictEqual(scanner.status, 302);
  assert.strictEqual(db.getTouch(touch.code).click_count, 0);
  const click = await fetch(`${base}/go/${touch.code}`, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (iPhone)' } });
  assert.strictEqual(click.status, 302);
  assert.ok(click.headers.get('location').startsWith(cfg.landingPageUrl));
  assert.ok(/utm_campaign=gfg-booking-sequence/.test(click.headers.get('location')));
  const t = db.getTouch(touch.code);
  assert.strictEqual(t.open_count, 1);
  assert.strictEqual(t.click_count, 1);
  const unknown = await fetch(`${base}/go/nope`, { redirect: 'manual' });
  assert.strictEqual(unknown.status, 302);
});

test('booking stops the sequence and credits the clicked message', async () => {
  const r = await post('/webhook/status?status=booked', { contact_id: 'c-web1' });
  assert.strictEqual(r.status, 'booked');
  const lead = db.findLeadByGhlContactId('c-web1');
  assert.strictEqual(lead.seq_status, 'stopped_booked');
  assert.ok(lead.booked_at);
  assert.strictEqual(db.db.prepare('SELECT SUM(booked) n FROM touches WHERE lead_id = ?').get(lead.id).n, 1);
});

test('a reply stops the sequence', async () => {
  await post('/webhook/lead', { contact_id: 'c-web3', first_name: 'Cal', email: 'cal@example.com', contact_source: 'Referral', tags: 'send-to-sales-agent' });
  assert.strictEqual(db.findLeadByGhlContactId('c-web3').seq_status, 'active');
  await post('/webhook/reply', { contact_id: 'c-web3', customData: { reply_text: 'What times do you have next week?', reply_channel: 'Email' } });
  assert.strictEqual(db.findLeadByGhlContactId('c-web3').seq_status, 'stopped_replied');
});

test('an opt-out reply stops it as opted out', async () => {
  await post('/webhook/lead', { contact_id: 'c-web4', first_name: 'Dee', email: 'dee@example.com', contact_source: 'RetireFlo', tags: 'send-to-sales-agent' });
  await post('/webhook/reply', { contact_id: 'c-web4', customData: { reply_text: 'STOP', reply_channel: 'SMS' } });
  const lead = db.findLeadByGhlContactId('c-web4');
  assert.strictEqual(lead.seq_status, 'stopped_opted_out');
  assert.strictEqual(lead.status, 'opted_out');
});

test('booking report counts the funnel and cost per booked appointment', () => {
  db.setSpend({ brand: 'grove-financial', month: '2026-10', source: 'form', amount: 300 });
  const rep = buildBookingReport({ brain, instruction: 'booking report october 2026', now: new Date('2026-10-26T15:00:00Z') });
  const rows = Object.fromEntries(rep.sections.flatMap((s) => s.rows));
  assert.ok(rep.bookingReport && rep.monthlyReport);
  assert.strictEqual(rows['Booked appointments (sequence leads, this month)'], 1);
  assert.ok(/no opt-in/.test(Object.keys(rows).join('|')));
  assert.ok(/\$300/.test(rows['Spend entered']));
  assert.ok(/\$/.test(rows['Cost per booked appointment (all sources)']));
  assert.ok(/drafts - nothing was sent|booked/.test(rep.summary));
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
