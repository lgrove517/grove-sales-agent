const { askClaude } = require('../integrations/anthropic');
const { draftContent } = require('./contentAgent');
const { draftFollowUp } = require('./followUp');
const { handleBookingIntent } = require('./appointmentSetter');
const { runFollowUpSweep } = require('../scheduler/followUpScheduler');
const { buildBriefing, recommend } = require('./briefing');
const { buildSocialCalendar } = require('./socialCalendar');
const { buildMonthlyReport } = require('./monthlyReport');
const { buildBookingReport, parseSpend } = require('./bookingReport');
const { buildIncomePlan } = require('./incomePlan');
const { renderScript, callerConfig } = require('../config/aiCaller');
const { hasFeature, lockedMessage } = require('../config/packages');
const { brainToSystemPrompt } = require('../config/loadBrain');
const db = require('../store/db');

// Which package feature each command needs (see src/config/packages.js).
// list_leads and list_activity are open to every package.
const INTENT_FEATURE = {
  social_calendar: 'socialCalendar',
  draft_content: 'content',
  follow_up_lead: 'aiFollowUp',
  run_followup_sweep: 'aiFollowUp',
  briefing: 'briefing',
  recommendations: 'recommendations',
  monthly_report: 'monthlyReport',
  booking_report: 'monthlyReport',
  set_spend: 'monthlyReport',
};

const ROUTER_PROMPT = `
You are the COMMAND CENTER router for a multi-agent sales system. The
business owner just typed one line of instruction. Classify it into exactly
one of these intents and extract any parameters mentioned:

- "social_calendar": they want a whole month (or calendar) of social posts
  planned and scheduled, e.g. "build the December social calendar", "a month
  of posts for January", "content calendar"
- "draft_content": they want a few social posts, an email, or ad copy written
- "follow_up_lead": they want a follow-up message sent/drafted to a specific
  named lead
- "list_leads": they want to see recent leads or their status
- "list_activity": they want a log/recap of what the agents have done
- "run_followup_sweep": they want to manually trigger the 24/7 auto
  follow-up scheduler right now instead of waiting for its next run
- "briefing": they want a recap of what happened since their last visit /
  last session / while they were away ("what did I miss?")
- "recommendations": they want advice or ideas on how to get more leads,
  more booked appointments, or grow the pipeline
- "monthly_report": they want the monthly results report / numbers for a
  month, e.g. "monthly report", "September results", "report for this month"
- "booking_report": they want the booking-sequence numbers: opens, clicks,
  booked appointments, cost per booked appointment, e.g. "booking report",
  "cost per appointment", "how is the booking sequence doing?"
- "income_plan": they give an income goal and want to know how many leads,
  appointments and sales it takes, e.g. "income plan $120,000", "how many
  leads do I need to make $10,000 a month?", "I want to earn 150k next year",
  "income plan $2M annuity premium at 6%", "$1M in AUM next quarter",
  "$25,000 from Medicare"
- "set_spend": they are telling you how much they spent on ads or leads
  from a source, e.g. "spent $250 on Facebook in November"
- "call_script": they want to see or review the AI phone call script,
  e.g. "show call script", "review the AI caller script"
- "ask": a question or comment for the assistant itself rather than a task,
  e.g. "why isn't Arizona listed?", "which states am I licensed in?", "what
  does the agent do when someone asks about a 401(k)?", "is this compliant?"
- "unknown": doesn't clearly match any of the above

Output STRICT JSON only:
{
  "intent": "social_calendar" | "draft_content" | "follow_up_lead" | "list_leads" | "list_activity" | "run_followup_sweep" | "briefing" | "recommendations" | "monthly_report" | "booking_report" | "income_plan" | "set_spend" | "call_script" | "ask" | "unknown",
  "leadName": "name mentioned, if any, else empty string",
  "cleanedInstruction": "the instruction, lightly cleaned up, to hand to the specialist agent"
}
`.trim();

/** Cheap keyword fallback used when there's no ANTHROPIC_API_KEY, so the
 * command center still does something sensible without a live LLM call. */
function ruleBasedRoute(instruction) {
  const lower = instruction.toLowerCase();
  if (/(income (plan|goal|target)|how many (leads|appointments|sales) (do|would|will) (i|we)|leads? (do|would) (i|we) need|\b(make|earn|reach|generate|gather|write|bring in)\b[^.?!]*\$?\d[\d,.]*\s*[km]?\b[^.?!]*\b(a|per|this|next) (year|month|quarter)\b)/.test(lower)) {
    return { intent: 'income_plan', leadName: '', cleanedInstruction: instruction };
  }
  if (/\b(spent|ad spend|ad budget|spend)\b/.test(lower) && /\d/.test(lower) && !/\breport\b/.test(lower)) {
    return { intent: 'set_spend', leadName: '', cleanedInstruction: instruction };
  }
  if (/\b(call|caller|calling|phone) script\b/.test(lower)) {
    return { intent: 'call_script', leadName: '', cleanedInstruction: instruction };
  }
  if (/(booking (report|results|numbers|sequence)|cost per (booked )?(appointment|booking)|sequence (report|results)|truth dashboard)/.test(lower)) {
    return { intent: 'booking_report', leadName: '', cleanedInstruction: instruction };
  }
  if (/(monthly (results|report|summary)|results (report|summary)|^(show |get |run )?(the |my )?report for\b|\b(results|numbers) for (this|last) month|\b(january|february|march|april|may|june|july|august|september|october|november|december) (results|report|numbers)\b)/.test(lower)) {
    return { intent: 'monthly_report', leadName: '', cleanedInstruction: instruction };
  }
  if (/(since (my|the) last|last (visit|session|login|time)|what did i miss|while i was (away|gone|out)|catch me up|\bbriefing\b)/.test(lower)) {
    return { intent: 'briefing', leadName: '', cleanedInstruction: instruction };
  }
  if (!/^(please )?(draft|write|create|make)\b/.test(lower) && /(recommend|advice|ideas? (to|for) (get|generat|grow|book)|how (can|do|should) (i|we) (get|generate|grow|book)|more (leads|appointments|bookings))/.test(lower)) {
    return { intent: 'recommendations', leadName: '', cleanedInstruction: instruction };
  }
  if (/(follow.?up sweep|run (the )?sweep|check (for )?(overdue|due) (leads|follow.?ups)|run scheduler)/.test(lower)) {
    return { intent: 'run_followup_sweep', leadName: '', cleanedInstruction: instruction };
  }
  if (/(social|content|posting|post) (media )?(calendar|schedule|plan)|month(ly)? (of|worth of) (social )?posts|monthly (social|posts)|bulk upload/.test(lower)) {
    return { intent: 'social_calendar', leadName: '', cleanedInstruction: instruction };
  }
  if (/(post|email|ad copy|write|draft|caption)/.test(lower)) {
    return { intent: 'draft_content', leadName: '', cleanedInstruction: instruction };
  }
  if (/(follow up|follow-up|check in|nudge)/.test(lower)) {
    const match = instruction.match(/with ([A-Z][a-z]+)/);
    return {
      intent: 'follow_up_lead',
      leadName: match ? match[1] : '',
      cleanedInstruction: instruction,
    };
  }
  if (/(list leads|show leads|who('| i)s in the pipeline|recent leads)/.test(lower)) {
    return { intent: 'list_leads', leadName: '', cleanedInstruction: instruction };
  }
  if (/(what happened|activity|recap|log)/.test(lower)) {
    return { intent: 'list_activity', leadName: '', cleanedInstruction: instruction };
  }
  return { intent: 'unknown', leadName: '', cleanedInstruction: instruction };
}

async function classifyIntent(instruction) {
  const result = await askClaude({
    system: ROUTER_PROMPT,
    messages: [{ role: 'user', content: instruction }],
    maxTokens: 300,
  });

  if (result.dryRun) {
    return { ...ruleBasedRoute(instruction), dryRun: true };
  }

  try {
    const match = result.text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : result.text);
    return { ...parsed, dryRun: false };
  } catch {
    return { ...ruleBasedRoute(instruction), dryRun: false };
  }
}

async function runCommand({ brain, instruction, since }) {
  const routed = await classifyIntent(instruction);
  let response;

  // Package check before any AI call: a locked command does nothing.
  const feature = INTENT_FEATURE[routed.intent];
  if (feature && !hasFeature(brain, feature)) {
    response = { locked: true, message: lockedMessage(brain, feature) };
    db.logCommand({ brand: brain.clientId, instruction, response });
    return { intent: routed.intent, dryRun: routed.dryRun, response };
  }

  switch (routed.intent) {
    case 'call_script': {
      const cfg = callerConfig(brain, { ignoreApproval: true });
      if (!cfg || !brain.aiCaller.script) {
        response = { message: `The AI caller is not set up for ${brain.businessName}.` };
      } else {
        response = {
          format: 'other',
          drafts: [renderScript(brain, { firstName: '{first name}', interest: '{what they asked about}' })],
          notes: cfg.approved
            ? `Approved and live (${cfg.approvalFlag}=true). Paste any changes into the GHL Voice AI agent too.`
            : `Not live yet. Review this script, paste it into the GHL Voice AI agent, then set ${cfg.approvalFlag}=true on Railway. Calls: ${cfg.callWindow.startHour}:00-${cfg.callWindow.endHour}:00 their time, up to ${cfg.dailyCap} per day, ${cfg.maxAttempts} tries per lead, consented form leads only, no Medicare leads.`,
        };
      }
      break;
    }
    case 'booking_report': {
      response = buildBookingReport({ brain, instruction });
      break;
    }
    case 'income_plan': {
      // Use the raw line: the numbers the owner typed matter more than the router's rewording.
      response = buildIncomePlan({ brain, instruction });
      break;
    }
    case 'set_spend': {
      const parsed = parseSpend(instruction);
      if (!parsed) {
        response = { message: 'I could not read that. Try: "spent $250 on Facebook in November".' };
      } else {
        db.setSpend({ brand: brain.clientId, ...parsed });
        const total = db.spendFor(brain.clientId, parsed.month);
        response = { message: `Saved: $${parsed.amount.toLocaleString('en-US')} on ${parsed.source} for ${parsed.month}. Spend on file for that month: ${total.map((s) => `${s.source} $${s.amount.toLocaleString('en-US')}`).join(', ')}. Lead sources containing "${parsed.source}" count toward it in the booking report.` };
      }
      break;
    }
    case 'monthly_report': {
      response = buildMonthlyReport({ brain, instruction: routed.cleanedInstruction || instruction });
      break;
    }
    case 'social_calendar': {
      response = await buildSocialCalendar({ brain, instruction: routed.cleanedInstruction || instruction });
      break;
    }
    case 'draft_content': {
      response = await draftContent({ brain, instruction: routed.cleanedInstruction });
      break;
    }
    case 'follow_up_lead': {
      const leads = db.listLeads({ brand: brain.clientId, limit: 200 });
      const lead = routed.leadName
        ? leads.find(
            (l) =>
              (l.first_name || '').toLowerCase() === routed.leadName.toLowerCase()
          )
        : null;
      if (!lead) {
        response = {
          error: `Could not find a lead named "${routed.leadName || '(none given)'}" for ${brain.businessName}. Try "list leads" first.`,
        };
      } else {
        response = await draftFollowUp({
          brain,
          lead: { id: lead.id, firstName: lead.first_name, ghlContactId: lead.ghl_contact_id, postalCode: lead.postal_code },
          attemptNumber: 1,
          channel: lead.phone ? 'SMS' : 'Email',
          context: routed.cleanedInstruction,
        });
      }
      break;
    }
    case 'list_leads': {
      response = { leads: db.listLeads({ brand: brain.clientId, limit: 20 }) };
      break;
    }
    case 'list_activity': {
      // Attach each event's lead name and parse its detail, so the command
      // center can show readable cards instead of raw JSON.
      response = {
        events: db.listEvents({ limit: 20 }).map((e) => {
          const lead = e.lead_id ? db.getLead(e.lead_id) : null;
          let detail = e.detail;
          try { detail = JSON.parse(e.detail); } catch {}
          return {
            ...e,
            detail,
            leadName: lead ? `${lead.first_name || ''} ${lead.last_name || ''}`.trim() : null,
          };
        }),
      };
      break;
    }
    case 'run_followup_sweep': {
      response = await runFollowUpSweep({ brand: brain.clientId });
      break;
    }
    case 'briefing': {
      // `since` comes from the signed-in session (the visit before this one);
      // fall back to the last 7 days.
      response = buildBriefing({ brain, since: since || db.toDbTime(Date.now() - 7 * 86400000) });
      break;
    }
    case 'recommendations': {
      response = await recommend({ brain, focus: routed.cleanedInstruction });
      break;
    }
    case 'ask':
    case 'unknown': {
      // "Ask anything": a plain answer from the business's own rules. It
      // never sends anything or changes a lead - it only answers the owner.
      response = await answerQuestion({ brain, question: instruction });
      if (response) break;
    }
    // falls through when no AI is configured
    default: {
      response = {
        message:
          "I didn't recognize that as a command yet. Try things like " +
          '"what happened since my last visit?", "how can I get more appointments?", ' +
          '"income plan $120,000", "draft 3 LinkedIn posts", "build the December social calendar", "monthly report", "follow up with Marcus", "list leads", or "run follow-up sweep".',
      };
    }
  }

  // The calendar's CSV can be rebuilt from its rows, so don't store it twice.
  const logged = response && response.csv ? { ...response, csv: undefined } : response;
  db.logCommand({ brand: brain.clientId, instruction, response: logged });
  return { intent: routed.intent, dryRun: routed.dryRun, response };
}

const ASK_PROMPT = `
You are answering a question from the business owner in the command center
(not from a lead). Answer plainly and briefly from the business rules above:
licensed states, offers, compliance rules, what the agents will and won't do.
If the answer depends on something not in the rules, say so. You cannot see
earlier commands or drafts: if the question refers to one, say what you can
and suggest they resend the full request (for example, the draft instruction
with the states they want). Do not draft new marketing here unless asked.
Plain text only, no JSON.
`.trim();

async function answerQuestion({ brain, question }) {
  const result = await askClaude({
    system: `${brainToSystemPrompt(brain)}\n\n${ASK_PROMPT}`,
    messages: [{ role: 'user', content: question }],
    maxTokens: 700,
  });
  if (result.dryRun || !result.text) return null;
  return { message: String(result.text).trim() };
}

module.exports = { runCommand, classifyIntent };
