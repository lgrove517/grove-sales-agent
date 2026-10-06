const { askClaude } = require('../integrations/anthropic');
const { brainToSystemPrompt } = require('../config/loadBrain');
const db = require('../store/db');

// Turns the stored detail of an event back into an object.
function parseDetail(e) {
  if (!e || !e.detail) return {};
  try { return JSON.parse(e.detail); } catch { return {}; }
}

function fullName(l) {
  return [l.first_name, l.last_name].filter(Boolean).join(' ') || '(no name)';
}

/**
 * "Since your last visit" - a plain, data-only recap (no AI call, so it is
 * instant, free and never invents anything). `since` is a DB-format UTC time.
 */
function buildBriefing({ brain, since }) {
  const brand = brain.clientId;
  const leads = db.leadsSince(brand, since).filter((l) => l.status !== 'superseded');
  const events = db.eventsSince(brand, since);
  const commands = db.commandsSince(brand, since);

  const verdicts = { qualified: 0, needs_human: 0, disqualified: 0 };
  events
    // One verdict per person: skip older copies of a re-sent contact.
    .filter((e) => e.agent === 'leadQualifier' && e.action in verdicts && e.lead_status !== 'superseded')
    .forEach((e) => { verdicts[e.action] += 1; });

  const followUpsDrafted = events.filter((e) => /^sent_attempt_\d+$/.test(e.action)).length;
  const bookingLinksSent = events.filter((e) => e.action === 'send_booking_link').length;
  const complianceHolds = events.filter((e) => /^blocked_/.test(e.action)).length;
  const booked = leads.filter((l) => l.status === 'booked' || l.status === 'won').length;

  // Everyone waiting on Dr. Grove right now (not only new ones), with the
  // agent's reason so he can act without opening each contact.
  const needsYou = db.leadsNeedingHuman(brand, 10).map((l) => {
    const d = parseDetail(db.latestEvent(l.id, 'leadQualifier'));
    return {
      id: l.id,
      name: fullName(l),
      source: l.source || '',
      createdAt: l.created_at,
      reason: d.reason || '',
    };
  });

  const newLeads = leads.slice(0, 10).map((l) => ({
    id: l.id,
    name: fullName(l),
    source: l.source || '',
    status: l.status,
    createdAt: l.created_at,
  }));

  const counts = {
    newLeads: leads.length,
    goodFit: verdicts.qualified,
    needsYou: verdicts.needs_human,
    notAFit: verdicts.disqualified,
    followUpsDrafted,
    bookingLinksSent,
    complianceHolds,
    booked,
    commandsRun: commands.length,
  };

  const quiet = !leads.length && !events.length && !commands.length;
  const parts = [];
  if (counts.newLeads) parts.push(`${counts.newLeads} new lead${counts.newLeads === 1 ? '' : 's'}`);
  if (counts.goodFit) parts.push(`${counts.goodFit} good fit`);
  if (counts.followUpsDrafted) parts.push(`${counts.followUpsDrafted} follow-up${counts.followUpsDrafted === 1 ? '' : 's'} drafted`);
  if (counts.complianceHolds) parts.push(`${counts.complianceHolds} held for compliance`);
  let summary = quiet ? 'Quiet since your last visit - no new leads or agent activity.' : `Since your last visit: ${parts.join(', ') || 'agent activity only'}.`;
  if (needsYou.length) summary += ` ${needsYou.length} lead${needsYou.length === 1 ? ' is' : 's are'} waiting on you.`;

  return {
    briefing: true,
    client: brain.businessName,
    since,
    summary,
    counts,
    needsYou,
    newLeads,
    recentCommands: commands.slice(0, 5).map((c) => ({ instruction: c.instruction, createdAt: c.created_at })),
  };
}

const RECOMMEND_PROMPT = `
You are a practical growth advisor for the business described above. Using
ONLY the pipeline numbers provided (do not invent statistics, benchmarks or
percentages), recommend 3 to 5 specific actions the owner can take THIS WEEK
to get more leads or more booked appointments. Prefer actions that use what
the business already has (its offers, booking link, lead sources, the AI
Sales Agent's drafting) and fit its guardrails and compliance rules. Each
action must be concrete enough to start today (e.g. "Post 2 Facebook lead-form
ads aimed at newer real estate agents using the missed-calls angle"), not
generic advice. If the numbers are too small to judge, say so and focus on
getting the first leads in. These are suggestions for the owner only - never
imply anything has been sent.

Use TODAY'S DATE (given with the numbers) for any timing advice - never
guess the season or month. Do not state that any platform, ad format or
practice is "compliant" or meets a regulation; at most say the owner should
set it up under the right rules (e.g. Meta's Housing special ad category).
"waitingOnYouNow" counts the same leads as leadsByStatus.needs_human - do not
count them twice.

Output STRICT JSON only:
{
  "headline": "one sentence on where the pipeline stands",
  "recommendations": [
    { "title": "short action", "why": "one sentence tied to the numbers or offers", "howTheAgentCanHelp": "a command they could type here, e.g. draft 3 Facebook posts about ...", "effort": "low" | "medium" | "high" }
  ]
}
`.trim();

/** Simple fallback when Claude is not configured (dry-run) or replies badly. */
function ruleBasedRecommendations(stats, brain) {
  const recs = [];
  if (stats.totalLeads < 5) {
    recs.push({
      title: 'Get more leads coming in',
      why: `Only ${stats.totalLeads} lead(s) in the last ${stats.windowDays} days - volume is the first bottleneck.`,
      howTheAgentCanHelp: `draft 3 Facebook posts for ${brain.businessName} with a clear call to book a call`,
      effort: 'low',
    });
  }
  if (stats.waitingOnYouNow > 0) {
    recs.push({
      title: `Answer the ${stats.waitingOnYouNow} lead(s) waiting on you`,
      why: 'Leads marked "needs you" go cold quickly while they wait.',
      howTheAgentCanHelp: 'list leads',
      effort: 'low',
    });
  }
  if (!brain.bookingLink) {
    recs.push({
      title: 'Add a booking link to this client profile',
      why: 'Messages that include a booking link make it one tap to book.',
      howTheAgentCanHelp: '',
      effort: 'low',
    });
  }
  recs.push({
    title: 'Run the follow-up sweep',
    why: 'Most bookings come from follow-up, not the first message.',
    howTheAgentCanHelp: 'run follow-up sweep',
    effort: 'low',
  });
  return {
    headline: `${stats.totalLeads} lead(s) in the last ${stats.windowDays} days.`,
    recommendations: recs.slice(0, 5),
  };
}

/** Ideas to get more leads / appointments, grounded in the client's numbers. */
async function recommend({ brain, focus = '' }) {
  const stats = db.pipelineStats(brain.clientId, 30);
  const result = await askClaude({
    system: `${brainToSystemPrompt(brain)}\n\n${RECOMMEND_PROMPT}`,
    messages: [{
      role: 'user',
      content: `Today's date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Chicago' })}\n\nPipeline numbers (JSON):\n${JSON.stringify(stats, null, 2)}\n\nOwner's question: ${focus || 'What should I do to generate more leads and appointments?'}`,
    }],
    maxTokens: 1200,
  });

  let parsed = null;
  if (!result.dryRun) {
    try {
      const m = result.text.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(m ? m[0] : result.text);
      if (!Array.isArray(parsed.recommendations)) parsed = null;
    } catch { parsed = null; }
  }
  if (!parsed) parsed = ruleBasedRecommendations(stats, brain);

  return { ...parsed, stats, dryRun: result.dryRun };
}

module.exports = { buildBriefing, recommend };
