const { askClaude } = require('../integrations/anthropic');
const ghl = require('../integrations/ghl');
const { brainToSystemPrompt } = require('../config/loadBrain');
const { checkSmsCompliance, ensureMedicareDisclaimer, checkMedicareQuoteLink, ensureCanSpamFooter } = require('../config/complianceGuard');
const db = require('../store/db');

const ROLE_PROMPT = `
You are the FOLLOW-UP agent. This lead has gone quiet after an earlier touch.
Your job is to write ONE short nurture message (SMS-length if channel is SMS,
otherwise a short email) that:
- Never sounds like a bot or a generic drip sequence
- References the specific offer they showed interest in, if known
- Offers one small next step, not pressure
- Respects the attempt number: later attempts should be lower-key, not more
  aggressive (e.g. attempt 1 = helpful nudge, attempt 4 = gracious "door's
  open" close)

Output STRICT JSON only:
{
  "shouldSend": true | false,
  "reason": "one sentence - explain if you decided NOT to send (e.g. escalation trigger hit)",
  "channel": "SMS" | "Email",
  "subject": "only if channel is Email, else empty string",
  "message": "the message body"
}
`.trim();

async function draftFollowUp({ brain, lead, attemptNumber, channel = 'SMS', context }) {
  const system = `${brainToSystemPrompt(brain)}\n\n${ROLE_PROMPT}`;
  const userMessage = [
    `Lead: ${lead.firstName || ''} ${lead.lastName || ''}`.trim(),
    `This is follow-up attempt #${attemptNumber} of ${brain.agents?.followUp?.maxAttempts || 4}.`,
    `Preferred channel: ${channel}`,
    `Context / prior conversation: ${context || '(no prior notes on file)'}`,
  ].join('\n');

  const result = await askClaude({
    system,
    messages: [{ role: 'user', content: userMessage }],
  });

  let parsed;
  if (result.dryRun) {
    parsed = {
      shouldSend: true,
      reason: 'DRY_RUN stub (no ANTHROPIC_API_KEY set)',
      channel,
      subject: channel === 'Email' ? `Following up - ${brain.businessName}` : '',
      message: `[DRY_RUN] Follow-up #${attemptNumber} to ${lead.firstName || 'lead'}.`,
    };
  } else {
    try {
      parsed = JSON.parse(extractJson(result.text));
    } catch (err) {
      parsed = { shouldSend: false, reason: `parse error: ${err.message}`, channel, subject: '', message: '' };
    }
  }

  // Federal backstop: if this message names a specific Medicare plan type,
  // make sure the required CMS disclaimer is on it, whether or not the
  // model remembered to include it.
  const medicare = ensureMedicareDisclaimer(parsed.message, { brain, lead });
  parsed.message = medicare.messageText;
  if (medicare.needsArea) {
    parsed.shouldSend = false;
    parsed.reason = medicare.reason;
  }
  const qlink = checkMedicareQuoteLink(parsed.message, { brain, leadText: context });
  if (qlink.hold) {
    parsed.shouldSend = false;
    parsed.reason = qlink.reason;
  }

  // CAN-SPAM requires a physical mailing address on commercial email -
  // no-op for SMS or if the brain has no mailingAddress on file.
  const canSpam = ensureCanSpamFooter(parsed.channel, parsed.message, brain);
  parsed.message = canSpam.messageText;

  // Code-level backstop: even if the model ignores the prompt-level SMS
  // restriction, never actually let advisory/securities content go out
  // over SMS - GoHighLevel is not a Gradient-approved vendor for that.
  const compliance = checkSmsCompliance(parsed.channel, parsed.message, brain);
  if (compliance.blocked) {
    db.logEvent({
      leadId: lead.id,
      agent: 'followUp',
      action: 'blocked_sms_compliance',
      detail: { parsed, reason: compliance.reason },
      dryRun: result.dryRun,
    });
    return {
      ...parsed,
      shouldSend: false,
      reason: compliance.reason,
      dryRun: result.dryRun,
      sendResult: null,
      complianceBlocked: true,
    };
  }

  // Only send on a channel this lead actually has. (Callers that don't pass
  // phone/email at all are left alone.)
  if (parsed.shouldSend && ('phone' in lead || 'email' in lead)) {
    if (!lead.phone && !lead.email) {
      parsed.shouldSend = false;
      parsed.reason = 'no phone or email on file';
    } else if (parsed.channel === 'SMS' && !lead.phone) {
      parsed.channel = 'Email';
      parsed.subject = parsed.subject || `Following up - ${brain.businessName}`;
    } else if (parsed.channel === 'Email' && !lead.email) {
      parsed.channel = 'SMS';
    }
  }

  let sendResult = null;
  if (parsed.shouldSend && lead.ghlContactId) {
    sendResult = await ghl.sendMessage({
      contactId: lead.ghlContactId,
      type: parsed.channel,
      message: parsed.message,
      subject: parsed.subject,
    });
  }

  db.logEvent({
    leadId: lead.id,
    agent: 'followUp',
    action: parsed.shouldSend ? `sent_attempt_${attemptNumber}` : 'skipped',
    detail: { parsed, sendResult },
    dryRun: result.dryRun || (sendResult && sendResult.dryRun),
  });

  return { ...parsed, dryRun: result.dryRun, sendResult };
}

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : text;
}

// --- Phase 1 booking sequence: day 1 / 3 / 7 follow-ups ----------------------
const { sendSequenceTouch } = require('./sequenceTouch');

const SEQUENCE_PROMPT = `
You are the FOLLOW-UP agent writing one step of a short booking sequence.
This person ASKED to hear from the business (form, referral or survey) and
has not booked a time yet. The only goal is to get them to pick a time on
the scheduling page.

Rules:
- Personal: use their first name and what they asked about, if known.
- Short. Email: 2-4 sentences plus a one-line subject. Text: 1-2 sentences.
- Do NOT include any link, URL or web address. The scheduling link is added
  on its own line automatically, right after your message - end with a
  sentence that leads into it (for example "Pick whatever time suits you.").
- Do NOT add a sign-off, signature, opt-out or unsubscribe line; those are
  added automatically too.
- Each step is lower-key than the last. The final step is a gracious
  "the door's open whenever you're ready" note - never pushy, no urgency.

Output STRICT JSON only:
{ "shouldSend": true | false, "reason": "one sentence if not sending", "subject": "email subject, or empty for a text", "message": "the message body" }
`.trim();

const STEP_GUIDANCE = [
  'Step 1 of 3: a friendly, helpful nudge. Mention what they asked about and that a short conversation is free and no-obligation.',
  'Step 2 of 3: very brief and light. A quick check-in, one easy reason to talk.',
  'Step 3 of 3 (last): gracious close. No pressure; the door stays open and they can pick a time whenever they are ready.',
];

/**
 * Drafts and sends one follow-up step of the booking sequence. Returns
 * { sent, held, reason, mode, message, channel }; the caller advances or
 * holds the lead's sequence from that.
 */
async function draftSequenceFollowUp({ brain, cfg, lead, stepIndex, channel }) {
  const guidance = STEP_GUIDANCE[Math.min(stepIndex, STEP_GUIDANCE.length - 1)];
  const userMessage = [
    `Lead first name: ${lead.firstName || '(unknown - use a friendly greeting without a name)'}`,
    `Channel: ${channel === 'SMS' ? 'Text message (SMS)' : 'Email'}`,
    `Day ${cfg.steps[stepIndex].day} after they asked to hear from us.`,
    `How they reached us: ${lead.source || 'a form'}`,
    `What they asked about: ${lead.interest || '(nothing specific - keep it general per the marketing approach)'}`,
    guidance,
  ].join('\n');

  const result = await askClaude({
    system: `${brainToSystemPrompt(brain)}\n\n${SEQUENCE_PROMPT}`,
    messages: [{ role: 'user', content: userMessage }],
  });

  let parsed;
  if (result.dryRun) {
    parsed = { shouldSend: true, reason: 'DRY_RUN', subject: `Following up - ${brain.businessName}`, message: `[DRY_RUN] Sequence step ${stepIndex + 1} for ${lead.firstName || 'lead'}.` };
  } else {
    try {
      parsed = JSON.parse(extractJson(result.text));
    } catch (err) {
      parsed = { shouldSend: false, reason: `Could not read the drafted message (${err.message}).`, subject: '', message: '' };
    }
  }

  let reason = parsed.reason;
  let message = String(parsed.message || '').trim();
  let shouldSend = parsed.shouldSend !== false && Boolean(message);
  if (!message) reason = reason || 'No message was drafted.';

  if (shouldSend) {
    const medicare = ensureMedicareDisclaimer(message, { brain, lead });
    message = medicare.messageText;
    if (medicare.needsArea) { shouldSend = false; reason = medicare.reason; }
  }
  if (shouldSend) {
    const qlink = checkMedicareQuoteLink(message, { brain, leadText: lead.interest || '' });
    if (qlink.hold) { shouldSend = false; reason = qlink.reason; }
  }

  let touch = { sent: false, held: true, reason, message };
  if (shouldSend) {
    touch = await sendSequenceTouch({ brain, cfg, lead, step: stepIndex + 1, channel, text: message, subject: parsed.subject });
  }

  db.logEvent({
    leadId: lead.id,
    agent: 'followUp',
    action: touch.sent ? `sequence_step_${stepIndex + 1}` : 'sequence_held',
    detail: { channel, day: cfg.steps[stepIndex].day, reason: touch.reason, message: touch.message, mode: touch.mode, link: touch.link },
    dryRun: result.dryRun || touch.mode === 'dry_run',
  });

  return { ...touch, channel, dryRun: result.dryRun };
}

module.exports = { draftFollowUp, draftSequenceFollowUp };
