const { askClaude } = require('../integrations/anthropic');
const { brainToSystemPrompt } = require('../config/loadBrain');
const { ensureMedicareDisclaimer, detectInvestmentTopic, financialGuardsOn, detectDonorHandoff } = require('../config/complianceGuard');
const db = require('../store/db');

/**
 * REPLY HANDLER: a lead answered one of our messages. Decide what they want
 * and draft the next message. Like every other agent, it only drafts - the
 * route that calls it decides whether anything is sent (review mode saves it
 * as a note on the contact instead).
 */
const ROLE_PROMPT = `
You are the REPLY HANDLER agent. A lead has just replied to a message from us.
Read their reply and decide which ONE of these it is:

- "wants_to_book": they want to meet, talk, or schedule. Draft a short reply
  that thanks them and gives the booking link (or asks for a good day/time if
  no booking link is on file).
- "question": they asked something you can answer within the guardrails above.
  Answer briefly and plainly, then invite them to the next step. If the honest
  answer needs a licensed professional's judgment about THEIR situation, say
  that is exactly what a conversation with the business owner (see OFFERS above) is for.
- "not_now": they are interested but not ready (busy, later, after the
  holidays). Draft a gracious reply that leaves the door open - no pressure.
- "not_interested": they politely declined. Draft a one or two sentence thank
  you that closes the loop. No persuasion.
- "needs_human": anything else - a complaint, something personal or
  sensitive, a request for a specific recommendation, or anything you are not
  sure how to handle. Draft nothing.

Keep replies short: SMS-length for SMS, a few sentences for email.

Output STRICT JSON only:
{
  "intent": "wants_to_book" | "question" | "not_now" | "not_interested" | "needs_human",
  "reason": "one sentence",
  "reply": "the message to send, or empty string for needs_human"
}
Do not include any text outside the JSON object.
`.trim();

// Opt-outs are decided in code, never by the model: a lead who says stop
// is never sent another word by this system.
const OPT_OUT_PATTERNS = [
  /^\s*(stop|stopall|unsubscribe|cancel|end|quit|optout|opt out|opt-out)\s*[.!]*\s*$/i,
  /\b(unsubscribe|opt[\s-]?out)\b/i,
  /\b(remove|take) me (off|from)\b/i,
  /\b(stop|quit|don'?t) (texting|emailing|messaging|contacting|calling) me\b/i,
  /\bdo not (text|email|contact|call|message) me\b/i,
];

function isOptOut(text) {
  return OPT_OUT_PATTERNS.some((re) => re.test(text || ''));
}

async function handleReply({ brain, lead, replyText, channel, context }) {
  const text = (replyText || '').trim();

  if (isOptOut(text)) {
    const result = { intent: 'opted_out', reason: 'Lead asked to stop receiving messages.', reply: '', dryRun: false };
    db.logEvent({ leadId: lead.id, agent: 'replyHandler', action: 'opted_out', detail: { replyText: text, channel }, dryRun: false });
    return result;
  }

  const system = `${brainToSystemPrompt(brain)}\n\n${ROLE_PROMPT}`;
  const userMessage = [
    `Lead: ${lead.firstName || ''} ${lead.lastName || ''}`.trim() || 'Lead: (no name on file)',
    `Channel they replied on: ${channel}`,
    `Booking link on file: ${brain.bookingLink || '(none on file yet)'}`,
    `Our last message to them: ${context || '(not on file)'}`,
    `Their reply: ${text || '(empty)'}`,
  ].join('\n');

  const result = await askClaude({ system, messages: [{ role: 'user', content: userMessage }] });

  let parsed;
  if (result.dryRun) {
    parsed = { intent: 'question', reason: 'DRY_RUN stub (no ANTHROPIC_API_KEY set)', reply: `[DRY_RUN] Reply to ${lead.firstName || 'lead'}.` };
  } else {
    try {
      parsed = JSON.parse(extractJson(result.text));
    } catch (err) {
      parsed = { intent: 'needs_human', reason: `Could not parse model output: ${err.message}`, reply: '' };
    }
  }
  if (!text) parsed = { intent: 'needs_human', reason: 'The reply came through empty (a picture, voice note or attachment?) - please look at the conversation.', reply: '' };

  // Same investment-topic routing as new leads, enforced in code: if the
  // lead's reply (or the draft) gets into 401(k)s, rollovers, pensions,
  // IRAs and the like, it is a Grove Wealth Management conversation for
  // Dr. Grove personally.
  const guarded = financialGuardsOn(brain);
  const leadTopic = guarded ? detectInvestmentTopic(text) : null;
  const replyTopic = guarded ? detectInvestmentTopic(parsed.reply) : null;
  if (leadTopic || replyTopic) {
    parsed = {
      intent: 'needs_human',
      reason: leadTopic
        ? `Lead's reply mentions ${leadTopic} - an investment topic for Grove Wealth Management. Route to Dr. Grove. (Agent's read: ${parsed.reason || 'n/a'})`
        : `Drafted reply drifted into ${replyTopic} - held for Dr. Grove. (Agent's read: ${parsed.reason || 'n/a'})`,
      reply: '',
      draftForDrGrove: parsed.reply || '',
      investmentTopic: true,
    };
  }

  // Donor handoff rules (brains with donorRules): large gifts, planned
  // gifts and sensitive topics go to Dr. Grove personally, in code.
  const handoff = detectDonorHandoff(text, brain);
  if (handoff) {
    parsed = {
      intent: 'needs_human',
      reason: `${handoff.reason} (Agent's read: ${parsed.reason || 'n/a'})`,
      reply: '',
      draftForDrGrove: parsed.reply || parsed.draftForDrGrove || '',
      handoffTagKey: handoff.tagKey,
    };
  }

  if (parsed.intent === 'needs_human') parsed.reply = '';
  if (parsed.reply) parsed.reply = ensureMedicareDisclaimer(parsed.reply).messageText;

  db.logEvent({ leadId: lead.id, agent: 'replyHandler', action: parsed.intent, detail: { replyText: text, channel, ...parsed }, dryRun: result.dryRun });
  return { ...parsed, dryRun: result.dryRun };
}

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : text;
}

module.exports = { handleReply, isOptOut };
