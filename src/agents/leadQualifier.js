const { askClaude } = require('../integrations/anthropic');
const ghl = require('../integrations/ghl');
const { brainToSystemPrompt } = require('../config/loadBrain');
const { ensureMedicareDisclaimer, detectInvestmentTopic } = require('../config/complianceGuard');
const db = require('../store/db');

const ROLE_PROMPT = `
You are the LEAD QUALIFIER agent. A new lead just came in from a website form,
call, or GHL trigger. Your job:

1. Decide, from the lead's message/details, whether they look like a good fit
   per the IDEAL CUSTOMER description and offers above.
2. Check for any ESCALATE conditions - if one applies, say so explicitly and
   do NOT attempt to qualify further.
3. If no escalation is needed, write a short, warm first-touch reply (2-4
   sentences) that acknowledges what they asked about and moves them toward
   the single most relevant CTA.
   A lead with NO message is normal - most leads arrive with contact details
   only (a form with no comment box, or Dr. Grove sending an existing
   contact from his CRM). Never mark a lead needs_human just because there
   is no message. In that case write a general, warm first-touch reply that
   opens a conversation about their financial picture (per MARKETING
   APPROACH above) - no product pitch - and invites them to the most
   relevant next step.
4. Output STRICT JSON only, matching this shape:
{
  "verdict": "qualified" | "needs_human" | "disqualified",
  "reason": "one sentence",
  "reply": "the message to send the lead, or empty string if needs_human/disqualified",
  "suggestedTag": "a short GHL tag like 'hot-lead' or 'retirement-review'"
}
Do not include any text outside the JSON object.
`.trim();

async function qualifyLead({ brain, lead }) {
  const system = `${brainToSystemPrompt(brain)}\n\n${ROLE_PROMPT}`;
  const userMessage = [
    `New lead details:`,
    `Name: ${lead.firstName || ''} ${lead.lastName || ''}`.trim(),
    `Email: ${lead.email || 'n/a'}`,
    `Phone: ${lead.phone || 'n/a'}`,
    `State/location: ${lead.state || 'unknown'}`,
    `Source: ${lead.source || 'unknown'}`,
    `Message from lead: ${lead.message || '(none - contact details only, which is normal)'}`,
    lead.context ? `Other context: ${lead.context}` : '',
  ].filter(Boolean).join('\n');

  const result = await askClaude({
    system,
    messages: [{ role: 'user', content: userMessage }],
  });

  let parsed;
  if (result.dryRun) {
    parsed = {
      verdict: 'qualified',
      reason: 'DRY_RUN stub verdict (no ANTHROPIC_API_KEY set)',
      reply: `Hi ${lead.firstName || 'there'} - thanks for reaching out to ${brain.businessName}! [DRY_RUN reply]`,
      suggestedTag: 'dry-run',
    };
  } else {
    try {
      parsed = JSON.parse(extractJson(result.text));
    } catch (err) {
      parsed = {
        verdict: 'needs_human',
        reason: `Could not parse model output: ${err.message}`,
        reply: '',
        suggestedTag: 'parse-error',
      };
    }
  }

  // Investment-topic routing, enforced in code: if the LEAD raised a
  // 401(k)/rollover/pension/IRA/investment topic, this is a Grove Wealth
  // Management conversation for Dr. Grove - never an automated Grove
  // Financial Group reply, whatever the model decided.
  const leadTopic = detectInvestmentTopic(`${lead.message || ''} ${lead.context || ''}`);
  const replyTopic = detectInvestmentTopic(parsed.reply);
  if (leadTopic || replyTopic) {
    parsed = {
      ...parsed,
      verdict: 'needs_human',
      reason: leadTopic
        ? `Lead asked about ${leadTopic} - an investment topic for Grove Wealth Management. Route to Dr. Grove. (Agent's read: ${parsed.reason || 'n/a'})`
        : `Drafted reply drifted into ${replyTopic} - an investment topic for Grove Wealth Management. Held for Dr. Grove. (Agent's read: ${parsed.reason || 'n/a'})`,
      reply: '',
      draftForDrGrove: parsed.reply || '',
      suggestedTag: 'gwm-investment-inquiry',
    };
  }

  // Federal backstop: if the first-touch reply names a specific Medicare
  // plan type, make sure the required CMS disclaimer is attached.
  if (parsed.reply) {
    parsed.reply = ensureMedicareDisclaimer(parsed.reply).messageText;
  }

  db.logEvent({
    leadId: lead.id,
    agent: 'leadQualifier',
    action: parsed.verdict,
    detail: parsed,
    dryRun: result.dryRun,
  });

  return { ...parsed, dryRun: result.dryRun };
}

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : text;
}

module.exports = { qualifyLead };
