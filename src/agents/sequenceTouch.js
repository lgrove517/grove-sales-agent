/**
 * Finishes and sends ONE booking-sequence message (the day 0 first touch or
 * a day 1/3/7 follow-up), the same way every time:
 *   1. the AI's text, with any links taken out
 *   2. the single scheduling link (tracked) on its own line
 *   3. email: approved sign-off, unsubscribe line, CAN-SPAM address
 *      text:  "Reply STOP to opt out."
 *   4. the advisory/investment and separation checks - held if they fire
 *   5. sent through GoHighLevel (a note in review mode) and recorded as a
 *      "touch" so opens, clicks and bookings can be counted
 */
const ghl = require('../integrations/ghl');
const db = require('../store/db');
const { checkAdvisoryAutoSend, checkSeparation, ensureCanSpamFooter } = require('../config/complianceGuard');
const { ensureSignOff } = require('../config/signOff');
const seq = require('../config/bookingSequence');

function finishText({ brain, cfg, channel, text, link }) {
  let out = seq.applySingleLink(text, link, cfg.linkLeadIn);
  if (channel === 'SMS') return seq.ensureSmsOptOut(out);
  out = ensureSignOff('Email', out, brain);
  out = seq.ensureEmailOptOut(out);
  return ensureCanSpamFooter('Email', out, brain).messageText;
}

/**
 * Returns { sent, held, reason, mode, code, link, message, sendResult }.
 * `step` is 0 for the first touch, then 1, 2, 3 for the follow-up steps.
 */
async function sendSequenceTouch({ brain, cfg, lead, step, channel, text, subject }) {
  const code = seq.newCode();
  const { link, destination, tracked } = seq.linkFor(cfg, { step, channel, code });
  const message = finishText({ brain, cfg, channel, text, link });

  const advisory = checkAdvisoryAutoSend(channel, message, brain);
  const check = advisory.blocked ? advisory : checkSeparation(message, brain);
  if (check.blocked) {
    return { sent: false, held: true, reason: check.reason, message, code, link };
  }

  const sendResult = await ghl.sendMessage({
    contactId: lead.ghlContactId || lead.ghl_contact_id,
    type: channel,
    message,
    subject: channel === 'Email' ? subject || `A time to talk - ${brain.businessName}` : undefined,
    html: channel === 'Email' ? seq.emailHtml(message, { link, code: tracked ? code : null }) : undefined,
  });
  const mode = seq.modeFrom(sendResult);
  db.insertTouch({ code, leadId: lead.id, brand: brain.clientId, step, channel, url: destination, mode });
  return { sent: true, held: false, mode, code, link, message, sendResult };
}

module.exports = { sendSequenceTouch, finishText };
