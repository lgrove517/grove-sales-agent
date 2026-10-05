const { askClaude } = require('../integrations/anthropic');
const ghl = require('../integrations/ghl');
const { brainToSystemPrompt } = require('../config/loadBrain');
const { checkSmsCompliance, ensureMedicareDisclaimer } = require('../config/complianceGuard');
const db = require('../store/db');

const ROLE_PROMPT = `
You are the APPOINTMENT SETTER agent. The lead has agreed (or strongly hinted)
they want to book time. Your job:
- Write a short message that gets them to the booking link, or asks for their
  preferred day/time window if no booking link is on file
- Confirm which specific offer the appointment is for
- If they've asked a question that needs a licensed human (see guardrails),
  say so instead of trying to answer it yourself

Output STRICT JSON only:
{
  "action": "send_booking_link" | "ask_for_availability" | "escalate",
  "reason": "one sentence",
  "message": "the message to send"
}
`.trim();

async function handleBookingIntent({ brain, lead, context }) {
  const system = `${brainToSystemPrompt(brain)}\n\n${ROLE_PROMPT}`;
  const userMessage = [
    `Lead: ${lead.firstName || ''} ${lead.lastName || ''}`.trim(),
    `Booking link on file: ${brain.bookingLink || '(none on file yet)'}`,
    `Context: ${context || '(no additional context)'}`,
  ].join('\n');

  const result = await askClaude({
    system,
    messages: [{ role: 'user', content: userMessage }],
  });

  let parsed;
  if (result.dryRun) {
    parsed = {
      action: 'send_booking_link',
      reason: 'DRY_RUN stub (no ANTHROPIC_API_KEY set)',
      message: `[DRY_RUN] Here's the link to book time with ${brain.businessName}: ${brain.bookingLink || '<booking link not set>'}`,
    };
  } else {
    try {
      parsed = JSON.parse(extractJson(result.text));
    } catch (err) {
      parsed = { action: 'escalate', reason: `parse error: ${err.message}`, message: '' };
    }
  }

  const medicare = ensureMedicareDisclaimer(parsed.message);
  parsed.message = medicare.messageText;

  const compliance = checkSmsCompliance('SMS', parsed.message, brain);
  if (compliance.blocked) {
    db.logEvent({
      leadId: lead.id,
      agent: 'appointmentSetter',
      action: 'blocked_sms_compliance',
      detail: { parsed, reason: compliance.reason },
      dryRun: result.dryRun,
    });
    return {
      ...parsed,
      action: 'escalate',
      reason: compliance.reason,
      dryRun: result.dryRun,
      sendResult: null,
      complianceBlocked: true,
    };
  }

  let sendResult = null;
  if (parsed.action !== 'escalate' && lead.ghlContactId) {
    sendResult = await ghl.sendMessage({
      contactId: lead.ghlContactId,
      type: 'SMS',
      message: parsed.message,
    });
  }

  db.logEvent({
    leadId: lead.id,
    agent: 'appointmentSetter',
    action: parsed.action,
    detail: { parsed, sendResult },
    dryRun: result.dryRun || (sendResult && sendResult.dryRun),
  });

  return { ...parsed, dryRun: result.dryRun, sendResult };
}

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : text;
}

module.exports = { handleBookingIntent };
