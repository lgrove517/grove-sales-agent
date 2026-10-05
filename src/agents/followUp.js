const { askClaude } = require('../integrations/anthropic');
const ghl = require('../integrations/ghl');
const { brainToSystemPrompt } = require('../config/loadBrain');
const { checkSmsCompliance, ensureMedicareDisclaimer, ensureCanSpamFooter } = require('../config/complianceGuard');
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
  const medicare = ensureMedicareDisclaimer(parsed.message);
  parsed.message = medicare.messageText;

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

module.exports = { draftFollowUp };
