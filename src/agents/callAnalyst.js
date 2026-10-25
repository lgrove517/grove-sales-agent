/**
 * CALL ANALYST: reads what came back from an AI call (GHL's call summary and
 * transcript) and turns it into what Dr. Grove needs: how it went, the
 * person's tone and intent, and the next step. Opt-outs and investment or
 * Medicare topics are decided in code, never left to the model.
 */
const { askClaude } = require('../integrations/anthropic');
const { brainToSystemPrompt } = require('../config/loadBrain');
const { detectInvestmentTopic, financialGuardsOn, MEDICARE_INTEREST_PATTERN } = require('../config/complianceGuard');

const ROLE_PROMPT = `
You are the CALL ANALYST. An AI assistant just called a lead who asked for
information. Read the call summary and/or transcript and report, for the
business owner, what happened. Be factual - only what the call shows.

Output STRICT JSON only:
{
  "outcome": "conversation" | "no_answer" | "voicemail" | "wrong_number" | "opted_out",
  "intent": "booked_on_call" | "wants_to_book" | "interested_later" | "needs_info" | "not_interested" | "unclear",
  "tone": "warm" | "neutral" | "guarded" | "annoyed" | "unknown",
  "timeline": "when they want to act, in their words, or empty",
  "notes": "2-3 sentences: what they want, any concerns, anything Leon should know before talking to them",
  "nextStep": "one sentence: the best next step for Leon"
}
`.trim();

// Said by the PERSON on the call: stop all contact.
const OPT_OUT = /\b(stop calling|don'?t call|do not call|take me off|remove me|remove my (number|name)|not interested,? (stop|don'?t)|put me on (your|the) do not call|unsubscribe|stop contacting)\b/i;
const NO_ANSWER = /^(no[-_ ]?answer|busy|failed|unanswered|not[-_ ]answered|canceled|cancelled)$/i;
const VOICEMAIL = /voice ?mail|machine/i;

async function analyzeCall({ brain, lead, callStatus, summary, transcript }) {
  const text = `${summary || ''}\n${transcript || ''}`.trim();
  const status = String(callStatus || '').trim();

  // Nothing to read: decide from the call status alone.
  if (!text) {
    const outcome = VOICEMAIL.test(status) ? 'voicemail' : NO_ANSWER.test(status) || !status ? 'no_answer' : 'conversation';
    return { outcome, intent: 'unclear', tone: 'unknown', timeline: '', notes: status ? `Call status from GHL: ${status}.` : 'No call details came back from GHL.', nextStep: '', dryRun: false };
  }

  const result = await askClaude({
    system: `${brainToSystemPrompt(brain)}\n\n${ROLE_PROMPT}`,
    messages: [{ role: 'user', content: [
      `Lead: ${lead.firstName || ''} ${lead.lastName || ''}`.trim(),
      `What they originally asked about: ${lead.interest || '(not given)'}`,
      status ? `Call status from GHL: ${status}` : '',
      summary ? `Call summary:\n${summary}` : '',
      transcript ? `Transcript:\n${String(transcript).slice(0, 12000)}` : '',
    ].filter(Boolean).join('\n\n') }],
    maxTokens: 600,
  });

  let parsed;
  if (result.dryRun) {
    parsed = { outcome: VOICEMAIL.test(status) ? 'voicemail' : NO_ANSWER.test(status) ? 'no_answer' : 'conversation', intent: 'unclear', tone: 'unknown', timeline: '', notes: '[DRY_RUN] Call not analyzed (no ANTHROPIC_API_KEY).', nextStep: '' };
  } else {
    try {
      parsed = JSON.parse((result.text.match(/\{[\s\S]*\}/) || [result.text])[0]);
    } catch {
      parsed = { outcome: 'conversation', intent: 'unclear', tone: 'unknown', timeline: '', notes: String(result.text || '').slice(0, 500), nextStep: 'Read the call transcript in GHL.' };
    }
  }

  // Code-level overrides.
  const flags = [];
  if (OPT_OUT.test(transcript || summary || '')) {
    parsed.outcome = 'opted_out';
    flags.push('Asked not to be contacted.');
  }
  const topic = financialGuardsOn(brain) ? detectInvestmentTopic(text) : null;
  if (topic) flags.push(`Mentioned ${topic} - a Grove Wealth Management topic for Leon personally.`);
  if (MEDICARE_INTEREST_PATTERN.test(text)) flags.push('Mentioned Medicare - Leon handles Medicare personally.');

  return { ...parsed, investmentTopic: topic, flags, dryRun: result.dryRun };
}

module.exports = { analyzeCall, OPT_OUT };
