const { askClaude } = require('../integrations/anthropic');
const { draftContent } = require('./contentAgent');
const { draftFollowUp } = require('./followUp');
const { handleBookingIntent } = require('./appointmentSetter');
const { runFollowUpSweep } = require('../scheduler/followUpScheduler');
const db = require('../store/db');

const ROUTER_PROMPT = `
You are the COMMAND CENTER router for a multi-agent sales system. The
business owner just typed one line of instruction. Classify it into exactly
one of these intents and extract any parameters mentioned:

- "draft_content": they want social posts, an email, or ad copy written
- "follow_up_lead": they want a follow-up message sent/drafted to a specific
  named lead
- "list_leads": they want to see recent leads or their status
- "list_activity": they want a log/recap of what the agents have done
- "run_followup_sweep": they want to manually trigger the 24/7 auto
  follow-up scheduler right now instead of waiting for its next run
- "unknown": doesn't clearly match any of the above

Output STRICT JSON only:
{
  "intent": "draft_content" | "follow_up_lead" | "list_leads" | "list_activity" | "run_followup_sweep" | "unknown",
  "leadName": "name mentioned, if any, else empty string",
  "cleanedInstruction": "the instruction, lightly cleaned up, to hand to the specialist agent"
}
`.trim();

/** Cheap keyword fallback used when there's no ANTHROPIC_API_KEY, so the
 * command center still does something sensible without a live LLM call. */
function ruleBasedRoute(instruction) {
  const lower = instruction.toLowerCase();
  if (/(follow.?up sweep|run (the )?sweep|check (for )?(overdue|due) (leads|follow.?ups)|run scheduler)/.test(lower)) {
    return { intent: 'run_followup_sweep', leadName: '', cleanedInstruction: instruction };
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

async function runCommand({ brain, instruction }) {
  const routed = await classifyIntent(instruction);
  let response;

  switch (routed.intent) {
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
          lead: { id: lead.id, firstName: lead.first_name, ghlContactId: lead.ghl_contact_id },
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
    default: {
      response = {
        message:
          "I didn't recognize that as a command yet. Try things like " +
          '"draft 3 LinkedIn posts about our retirement plan review", ' +
          '"follow up with Marcus", "list leads", or "run follow-up sweep".',
      };
    }
  }

  db.logCommand({ brand: brain.clientId, instruction, response });
  return { intent: routed.intent, dryRun: routed.dryRun, response };
}

module.exports = { runCommand, classifyIntent };
