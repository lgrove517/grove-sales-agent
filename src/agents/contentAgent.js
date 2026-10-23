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

If the instruction is a question or feedback rather than a request for new
drafts (for example "why isn't Arizona listed?"), still answer in the JSON
below: put your answer in "notes" and leave "drafts" empty, or include revised
drafts if that is what they are asking for. Each instruction arrives on its
own - you cannot see earlier drafts, so if they refer to one, say so and ask
them to include the details in one instruction.

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
    // Room for several full-length drafts. At 1500 a long LinkedIn post plus
    // its variations could be cut off mid-answer, which broke the JSON.
    maxTokens: 4000,
  });

  let parsed;
  if (result.dryRun) {
    parsed = {
      format: 'other',
      drafts: [`[DRY_RUN] Would draft content for instruction: "${instruction}"`],
      notes: 'Set ANTHROPIC_API_KEY to get real drafts.',
    };
  } else {
    parsed = parseDraftReply(result.text);
  }
  // Every draft goes out as clean, ready-to-paste text: real line breaks and
  // quote marks, never \n, \" or leftover JSON brackets.
  parsed.drafts = (parsed.drafts || []).map(cleanDraftText).filter(Boolean);
  parsed.notes = cleanDraftText(parsed.notes || '');

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

/**
 * Turns Claude's reply into { format, drafts, notes }. Normally the reply is
 * clean JSON. When it is not (cut off at the length limit, a stray character,
 * extra words around it), the old code showed the whole raw reply - with its
 * \n and \" codes - as one block. Now each draft is rescued and decoded on
 * its own, so the owner still gets posts they can copy and paste.
 */
function parseDraftReply(text) {
  const raw = String(text || '').trim();
  try {
    const obj = JSON.parse(extractJson(raw));
    return {
      format: obj.format || 'other',
      drafts: Array.isArray(obj.drafts) ? obj.drafts.map(String) : [],
      notes: obj.notes ? String(obj.notes) : '',
    };
  } catch (_) { /* fall through to the rescue below */ }

  const drafts = [];
  const draftsAt = raw.search(/"drafts"\s*:\s*\[/);
  if (draftsAt !== -1) {
    let i = raw.indexOf('[', draftsAt) + 1;
    while (i < raw.length) {
      while (i < raw.length && /[\s,]/.test(raw[i])) i++;
      if (raw[i] !== '"') break; // reached "]" or something unexpected
      const lit = readJsonString(raw, i);
      if (!lit) break; // last draft was cut off before its closing quote
      drafts.push(lit.value);
      i = lit.end;
    }
  }
  const fmt = raw.match(/"format"\s*:\s*"([^"]*)"/);
  const notesAt = raw.search(/"notes"\s*:\s*"/);
  const notesLit = notesAt !== -1 ? readJsonString(raw, raw.indexOf('"', raw.indexOf(':', notesAt))) : null;

  if (!drafts.length && !notesLit) {
    // Not JSON at all: the model answered a question in plain words.
    return { format: 'other', drafts: [], notes: raw };
  }
  return {
    format: fmt ? fmt[1] : 'other',
    drafts,
    notes: notesLit ? notesLit.value : 'Some of this answer was cut off. If a draft is missing, ask again for fewer drafts.',
  };
}

/** Reads one JSON string literal starting at the opening quote; null if it never closes. */
function readJsonString(s, start) {
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '"') {
      try { return { value: JSON.parse(s.slice(start, i + 1)), end: i + 1 }; } catch (_) { return null; }
    }
  }
  return null;
}

/** Final safety net: decode any \n, \" or \t codes still in the text and trim stray JSON punctuation. */
function cleanDraftText(text) {
  let t = String(text == null ? '' : text);
  if (/\\[nrt"]/.test(t)) {
    t = t.replace(/\\r\\n|\\n/g, '\n').replace(/\\r/g, '\n').replace(/\\t/g, ' ').replace(/\\"/g, '"');
  }
  t = t.replace(/^\s*\[\s*"/, ''); // a leading [" left over from a JSON list
  t = t.replace(/"\s*\]\s*,?\s*$/, ''); // a trailing "], left over from a JSON list
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { draftContent, findUnapprovedFigures, parseDraftReply, cleanDraftText };
