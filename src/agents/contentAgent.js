const { askClaude } = require('../integrations/anthropic');
const { brainToSystemPrompt } = require('../config/loadBrain');
const db = require('../store/db');
const { detectInvestmentTopic } = require('../config/complianceGuard');

const ROLE_PROMPT = `
You are the CONTENT DRAFTER agent. You turn a one-line instruction from the
business owner into ready-to-post drafts (social posts, an email, or ad copy)
that match the brand voice above. Never fabricate statistics, client
testimonials, results, or numbers that were not given to you - if the
instruction implies you need a real number/proof point you don't have, write
the draft with a bracketed placeholder like [ADD REAL NUMBER] instead of
inventing one. The only statistics, dollar amounts and percentages you may use
are the APPROVED FACTS listed above; everything else (state or local costs,
averages, survey results) must be [ADD REAL NUMBER]. Biographical details
about Dr. Grove must come from the brain above - never add new ones.

Output STRICT JSON only:
{
  "format": "social_post" | "email" | "ad_copy" | "other",
  "drafts": ["draft 1", "draft 2", "..."],
  "notes": "anything the business owner should know before posting (e.g. a placeholder that needs filling in)"
}
`.trim();

async function draftContent({ brain, instruction }) {
  const system = `${brainToSystemPrompt(brain)}\n\n${ROLE_PROMPT}`;

  const result = await askClaude({
    system,
    messages: [{ role: 'user', content: instruction }],
    maxTokens: 1500,
  });

  let parsed;
  if (result.dryRun) {
    parsed = {
      format: 'other',
      drafts: [`[DRY_RUN] Would draft content for instruction: "${instruction}"`],
      notes: 'Set ANTHROPIC_API_KEY to get real drafts.',
    };
  } else {
    try {
      parsed = JSON.parse(extractJson(result.text));
    } catch (err) {
      parsed = { format: 'other', drafts: [], notes: `parse error: ${err.message}. Raw: ${result.text}` };
    }
  }

  parsed.figuresToVerify = findUnapprovedFigures(parsed.drafts || [], brain);
  // Investment topics are Grove Wealth Management material: flag any draft
  // that raises them so it is attributed to GWM and cleared with Gradient
  // before posting, never published as Grove Financial Group content.
  const gwmTopics = [...new Set((parsed.drafts || []).map((d) => detectInvestmentTopic(d)).filter(Boolean))];
  if (gwmTopics.length) {
    parsed.gwmReviewRequired = gwmTopics;
    parsed.notes = `${parsed.notes ? parsed.notes + ' ' : ''}GROVE WEALTH MANAGEMENT CONTENT: mentions ${gwmTopics.join(', ')}. Attribute to Grove Wealth Management and get Gradient approval before posting - do not post as Grove Financial Group.`;
  }

  db.logEvent({
    agent: 'contentDrafter',
    action: 'draft',
    detail: { instruction, parsed },
    dryRun: result.dryRun,
  });

  return { ...parsed, dryRun: result.dryRun };
}

/**
 * Safety net in code, not just the prompt: lists every dollar amount,
 * percentage or large number in the drafts that does not appear anywhere in
 * the brain (approved facts, phone, years of experience...). The command
 * center shows these as "check before posting" so an invented figure can't
 * slip through unnoticed.
 */
function findUnapprovedFigures(drafts, brain) {
  const known = JSON.stringify(brain).replace(/,(?=\d{3})/g, '');
  const pattern = /\$\s?\d[\d,]*(?:\.\d+)?\s?(?:k|K|million|billion)?|\b\d[\d,]*(?:\.\d+)?\s?%|\b\d{1,3}(?:,\d{3})+\b|\b\d+(?:\.\d+)?\s?(?:percent|out of \d+|in \d+)\b/g;
  const flagged = new Set();
  for (const draft of drafts) {
    for (const m of String(draft).match(pattern) || []) {
      const core = (m.match(/\d[\d,]*(?:\.\d+)?/) || [''])[0].replace(/,/g, '');
      if (!core || !known.includes(core)) flagged.add(m.trim());
    }
  }
  return [...flagged];
}

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : text;
}

module.exports = { draftContent, findUnapprovedFigures };
