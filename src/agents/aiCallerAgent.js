/**
 * PHASE 2 AI CALLER - scheduling, placing and reading back calls.
 * Rules live in src/config/aiCaller.js; the call itself is GoHighLevel's
 * Voice AI agent, started by a tag (see README "Phase 2: AI caller").
 */
const ghl = require('../integrations/ghl');
const db = require('../store/db');
const caller = require('../config/aiCaller');
const { analyzeCall } = require('./callAnalyst');

const HOUR = 60 * 60 * 1000;
const DONE_SEQ = ['stopped_replied', 'stopped_booked', 'stopped_opted_out', 'stopped_won'];
const DONE_STATUS = ['opted_out', 'booked', 'won', 'disqualified', 'superseded'];

const needsYouTag = (brain) => (brain.agentTags && (brain.agentTags.needs_you || brain.agentTags.needs_human)) || 'sales-agent-needs-you';

async function note(contactId, body) {
  if (contactId) await ghl.addNote({ contactId, body }).catch((e) => console.error('Could not add call note:', e.message));
}
async function tag(contactId, tags) {
  if (contactId) await ghl.addTags({ contactId, tags: tags.filter(Boolean) }).catch((e) => console.error('Could not tag call:', e.message));
}

const fmt = (d, tz) => d.toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

/**
 * Called when an opted-in lead arrives. Schedules the first call for the
 * next allowed time in the lead's time zone, or records why there is none.
 * Returns { scheduled, reason?, dueAt? }.
 */
async function scheduleFirstCall({ brain, leadId, ghlContactId, phone, state, interest, source, tags = [], customData = {}, now = new Date() }) {
  const cfg = caller.callerConfig(brain);
  if (!cfg) return { scheduled: false, reason: 'AI caller off or not yet approved' };
  const consent = caller.hasCallConsent({ tags, customData }, cfg);
  db.updateLeadCall(leadId, { callConsent: consent });
  if (!consent) return { scheduled: false, reason: 'no call consent on file' };
  if (!phone) return { scheduled: false, reason: 'no phone number' };
  if (cfg.excludeMedicare && caller.isMedicareLead({ interest, source, tags })) {
    db.updateLeadCall(leadId, { callStatus: 'excluded_medicare' });
    await note(ghlContactId, 'SALES AGENT: no AI call - this is a Medicare lead. Medicare calls are recorded and need the CMS disclaimer in the first minute, so please call personally.');
    return { scheduled: false, reason: 'Medicare lead - call personally' };
  }
  const win = caller.windowFor(cfg, state);
  const dueAt = caller.nextCallTime(win, new Date(now.getTime() + cfg.firstCallDelayMinutes * 60 * 1000));
  db.updateLeadCall(leadId, { callStatus: 'scheduled', callDueAt: db.toDbTime(dueAt), callTz: win.timezone, callAttempts: 0 });
  db.logEvent({ leadId, agent: 'aiCaller', action: 'scheduled', detail: { dueAt: dueAt.toISOString(), timezone: win.timezone }, dryRun: false });
  await note(ghlContactId, `SALES AGENT: AI call scheduled for ${fmt(dueAt, win.timezone)} (their time zone).`);
  return { scheduled: true, dueAt, timezone: win.timezone };
}

/** Stop a scheduled call (booked, replied, opted out...). */
function cancelCall(lead, reason) {
  if (lead && lead.call_status === 'scheduled') {
    db.updateLeadCall(lead.id, { callStatus: 'cancelled' });
    db.logEvent({ leadId: lead.id, agent: 'aiCaller', action: 'cancelled', detail: { reason }, dryRun: false });
  }
}

/**
 * Sweep: place every due call that is still allowed - re-checked right
 * before each call: still a live lead, inside their window, under the cap.
 */
async function callSweep(brain, now = new Date()) {
  const cfg = caller.callerConfig(brain);
  if (!cfg) return { ran: false, reason: 'AI caller off or not yet approved', processed: [] };
  const processed = [];
  let placedToday = db.callsPlacedSince(brain.clientId, db.toDbTime(now.getTime() - 24 * HOUR));

  for (const stale of db.dueCalls(brain.clientId, db.toDbTime(now))) {
    const lead = db.getLead(stale.id);
    if (!lead || lead.call_status !== 'scheduled') continue;
    const contactId = lead.ghl_contact_id;

    if (DONE_STATUS.includes(lead.status) || DONE_SEQ.includes(lead.seq_status)) {
      cancelCall(lead, `lead is ${lead.seq_status || lead.status}`);
      processed.push({ leadId: lead.id, cancelled: lead.seq_status || lead.status });
      continue;
    }
    const ageDays = (now.getTime() - new Date(`${lead.created_at.replace(' ', 'T')}Z`).getTime()) / (24 * HOUR);
    if (ageDays > cfg.maxLeadAgeDays) {
      db.updateLeadCall(lead.id, { callStatus: 'expired' });
      await note(contactId, `SALES AGENT: AI call not placed - the lead is more than ${cfg.maxLeadAgeDays} days old. Call personally if still a fit.`);
      processed.push({ leadId: lead.id, expired: true });
      continue;
    }
    const win = caller.windowFor(cfg, lead.state);
    if (!caller.inWindow(win, now)) {
      const next = caller.nextCallTime(win, now);
      db.updateLeadCall(lead.id, { callDueAt: db.toDbTime(next) });
      processed.push({ leadId: lead.id, rescheduled: next.toISOString() });
      continue;
    }
    if (placedToday >= cfg.dailyCap) {
      processed.push({ leadId: lead.id, waiting: 'daily cap reached' });
      continue; // stays scheduled; the next sweep tries again
    }

    // Dials when messages are live, or when only the caller is switched on
    // (AI_CALLER_LIVE=true) so calls can be tested while emails stay drafts.
    const live = ghl.isConfigured() && (ghl.sendMode() === 'live' || String(process.env.AI_CALLER_LIVE || '').toLowerCase() === 'true');
    const attempts = (lead.call_attempts || 0) + 1;
    if (live) {
      await ghl.addTags({ contactId, tags: [cfg.triggerTag] });
      db.updateLeadCall(lead.id, { callStatus: 'placed', callAttempts: attempts, callLastAt: db.toDbTime(now) });
      db.logEvent({ leadId: lead.id, agent: 'aiCaller', action: 'placed', detail: { attempt: attempts }, dryRun: false });
    } else {
      // Review mode (or no GHL keys): nothing dials - Dr. Grove sees when it would have.
      await note(contactId, `SALES AGENT - AI CALL READY (review mode, not dialed): attempt ${attempts} would be placed now, ${fmt(now, win.timezone)} their time. Set AI_CALLER_LIVE=true (calls only) or GHL_SEND_MODE=live to let the AI caller dial.`);
      db.updateLeadCall(lead.id, { callStatus: 'review_ready', callAttempts: attempts, callLastAt: db.toDbTime(now) });
      db.logEvent({ leadId: lead.id, agent: 'aiCaller', action: 'review_ready', detail: { attempt: attempts }, dryRun: !ghl.isConfigured() });
    }
    placedToday += 1;
    processed.push({ leadId: lead.id, placed: live, reviewMode: !live, attempt: attempts });
  }
  return { ran: true, processed };
}

const INTENT_TAG = {
  booked_on_call: 'sales-agent-call-booked',
  wants_to_book: 'sales-agent-call-wants-to-book',
  interested_later: 'sales-agent-call-interested-later',
  needs_info: 'sales-agent-call-needs-info',
  not_interested: 'sales-agent-call-not-interested',
  unclear: 'sales-agent-call-completed',
};

/**
 * A call result from GHL (/webhook/call): read it, then tag, note and update
 * the lead. Returns what was decided.
 */
async function handleCallResult({ brain, lead, callStatus, summary, transcript, recordingUrl, now = new Date() }) {
  const cfg = caller.callerConfig(brain, { ignoreApproval: true }) || caller.DEFAULTS;
  const contactId = lead.ghl_contact_id;
  if (contactId) await ghl.removeTags({ contactId, tags: [cfg.triggerTag] }).catch(() => {});

  const a = await analyzeCall({ brain, lead: { firstName: lead.first_name, lastName: lead.last_name, interest: lead.interest }, callStatus, summary, transcript });
  const tags = [];
  let retryAt = null;

  if (a.outcome === 'opted_out') {
    db.updateLeadStatus(lead.id, 'opted_out');
    db.updateLeadCall(lead.id, { callStatus: 'opted_out' });
    if (lead.seq_status === 'active') db.updateLeadSequence(lead.id, { seqStatus: 'stopped_opted_out' });
    tags.push('sales-agent-opted-out', 'sales-agent-call-opted-out');
  } else if (a.outcome === 'no_answer' || a.outcome === 'voicemail') {
    const attempts = lead.call_attempts || 1;
    if (attempts < cfg.maxAttempts && !DONE_SEQ.includes(lead.seq_status) && !DONE_STATUS.includes(lead.status)) {
      const win = caller.windowFor(cfg, lead.state);
      retryAt = caller.nextCallTime(win, new Date(now.getTime() + cfg.retryAfterHours * HOUR));
      db.updateLeadCall(lead.id, { callStatus: 'scheduled', callDueAt: db.toDbTime(retryAt) });
    } else {
      db.updateLeadCall(lead.id, { callStatus: 'no_answer' });
    }
    tags.push('sales-agent-call-no-answer');
  } else if (a.outcome === 'wrong_number') {
    db.updateLeadCall(lead.id, { callStatus: 'wrong_number' });
    tags.push('sales-agent-call-wrong-number', needsYouTag(brain));
  } else {
    db.updateLeadCall(lead.id, { callStatus: 'completed' });
    tags.push(INTENT_TAG[a.intent] || INTENT_TAG.unclear);
    if (a.intent === 'not_interested') {
      db.updateLeadStatus(lead.id, 'disqualified');
      if (lead.seq_status === 'active') db.updateLeadSequence(lead.id, { seqStatus: 'stopped_not_interested' });
    }
    if (a.intent === 'wants_to_book' || a.intent === 'needs_info') tags.push(needsYouTag(brain));
  }
  if (a.investmentTopic) tags.push('gwm-investment-inquiry', needsYouTag(brain));

  db.logEvent({ leadId: lead.id, agent: 'aiCaller', action: `result_${a.outcome}`, detail: { intent: a.intent, tone: a.tone, notes: a.notes, nextStep: a.nextStep, flags: a.flags, retryAt: retryAt && retryAt.toISOString() }, dryRun: a.dryRun });
  await tag(contactId, [...new Set(tags)]);
  await note(contactId, [
    `SALES AGENT - AI CALL RESULT: ${a.outcome.replace(/_/g, ' ')}${a.outcome === 'conversation' ? ` - ${String(a.intent).replace(/_/g, ' ')}` : ''}`,
    a.tone && a.tone !== 'unknown' ? `Tone: ${a.tone}` : '',
    a.timeline ? `Timeline: ${a.timeline}` : '',
    a.notes ? `Notes: ${a.notes}` : '',
    a.nextStep ? `Next step: ${a.nextStep}` : '',
    ...(a.flags || []).map((f) => `! ${f}`),
    retryAt ? `Will try once more: ${fmt(retryAt, caller.windowFor(cfg, lead.state).timezone)}.` : '',
    a.outcome === 'opted_out' ? 'All automated calls, texts and emails stopped. Please also mark the contact DND in GHL.' : '',
    recordingUrl ? `Recording: ${recordingUrl}` : '',
  ].filter(Boolean).join('\n'));

  return { ...a, tags: [...new Set(tags)], retryAt };
}

module.exports = { scheduleFirstCall, cancelCall, callSweep, handleCallResult };
