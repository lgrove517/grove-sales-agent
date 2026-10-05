/**
 * The "24/7, always on" piece: without this, a follow-up only goes out when
 * someone types a command in the command center. This walks every lead that
 * is due for its next touch (per the brain's agents.followUp.cadenceDays)
 * and calls the same draftFollowUp() the command center uses - same
 * compliance guards, same DRY_RUN behavior, nothing special-cased.
 *
 * Off by default. Set AUTO_FOLLOWUP=true in .env to turn it on - see
 * README "Turning on the 24/7 follow-up scheduler" for why that's an
 * explicit opt-in rather than always-on.
 */
const { loadBrain } = require('../config/loadBrain');
const { draftFollowUp } = require('../agents/followUp');
const ghl = require('../integrations/ghl');
const db = require('../store/db');

const DAY_MS = 24 * 60 * 60 * 1000;

// Leads in any of these statuses are done, one way or another - the
// scheduler should never touch them again.
// needs_human: Dr. Grove handles these himself - no automated nurture.
// superseded: an older copy of a contact that was re-sent to the agent.
const TERMINAL_STATUSES = ['disqualified', 'needs_human', 'superseded', 'opted_out', 'booked', 'won'];

function shapeLead(row) {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    state: row.state,
    status: row.status,
    ghlContactId: row.ghl_contact_id,
  };
}

/**
 * Returns the lead rows (raw DB shape) that are due for their next
 * follow-up attempt right now, for one brand's cadence settings.
 */
function findDueLeads(brand, cadenceDays, maxAttempts) {
  const now = Date.now();
  const rows = db.listLeads({ brand, limit: 500 });

  return rows.filter((row) => {
    if (TERMINAL_STATUSES.includes(row.status)) return false;

    const attempt = row.follow_up_attempt || 0;
    if (attempt >= maxAttempts) return false;

    if (row.next_follow_up_at) {
      return new Date(row.next_follow_up_at).getTime() <= now;
    }

    // Never followed up yet: due once cadenceDays[0] has passed since
    // the lead was created.
    const firstDelay = cadenceDays[0] ?? 1;
    return new Date(row.created_at).getTime() + firstDelay * DAY_MS <= now;
  });
}

/**
 * Runs one pass: finds due leads for the given brand, drafts (and, once
 * real GHL credentials are configured, sends) a follow-up for each, and
 * advances each lead's attempt counter/next-due-date. Safe to call by hand
 * (e.g. from the command center: "run follow-up sweep") or on a timer.
 */
async function runFollowUpSweep({ brand } = {}) {
  const brain = loadBrain(brand);
  // Every GoHighLevel call in this sweep uses THIS client's account.
  return ghl.runWithBrain(brain, () => sweepForBrain(brain));
}

async function sweepForBrain(brain) {
  const followUpCfg = brain.agents?.followUp || {};

  if (!followUpCfg.enabled) {
    return { ran: false, reason: 'followUp agent disabled for this brain', brand: brain.clientId, processed: [] };
  }

  const cadenceDays = followUpCfg.cadenceDays?.length ? followUpCfg.cadenceDays : [1, 3, 7, 14];
  const maxAttempts = followUpCfg.maxAttempts || cadenceDays.length;

  const due = findDueLeads(brain.clientId, cadenceDays, maxAttempts);
  const processed = [];

  for (const row of due) {
    const attemptNumber = (row.follow_up_attempt || 0) + 1;
    const lead = shapeLead(row);
    const channel = lead.phone ? 'SMS' : 'Email';

    let outcome;
    try {
      outcome = await draftFollowUp({
        brain,
        lead,
        attemptNumber,
        channel,
        context: `Automatic scheduler sweep. Lead status: ${lead.status}. Source: ${row.source || 'unknown'}. Previous attempts: ${row.follow_up_attempt || 0}.`,
      });
    } catch (err) {
      db.logEvent({
        leadId: lead.id,
        agent: 'scheduler',
        action: 'sweep_error',
        detail: { error: err.message },
        dryRun: false,
      });
      processed.push({ leadId: lead.id, attemptNumber, error: err.message });
      continue;
    }

    // Only advance the counter on a real, unblocked send attempt. A
    // compliance-blocked draft is left exactly where it was so the same
    // attempt gets retried (by a human, via the command center) rather
    // than silently skipped and forgotten.
    if (outcome.shouldSend && !outcome.complianceBlocked) {
      const nextDelay = cadenceDays[attemptNumber]; // delay for the *next* stage
      const nextFollowUpAt = nextDelay ? new Date(Date.now() + nextDelay * DAY_MS).toISOString() : null;
      db.recordFollowUpAttempt(row.id, attemptNumber, nextFollowUpAt);
    }

    processed.push({ leadId: row.id, attemptNumber, outcome });
  }

  db.logEvent({
    agent: 'scheduler',
    action: 'sweep_completed',
    detail: { brand: brain.clientId, dueCount: due.length },
    dryRun: false,
  });

  return { ran: true, brand: brain.clientId, dueCount: due.length, processed };
}

let intervalHandle = null;

/**
 * Starts the recurring sweep. Interval defaults to hourly; override with
 * FOLLOWUP_SWEEP_INTERVAL_MINUTES in .env. Calling this twice is a no-op -
 * it returns the existing timer instead of stacking a second one.
 */
function startScheduler({ brand } = {}) {
  if (intervalHandle) return intervalHandle;

  const minutes = Number(process.env.FOLLOWUP_SWEEP_INTERVAL_MINUTES) || 60;
  const everyMs = minutes * 60 * 1000;

  intervalHandle = setInterval(() => {
    runFollowUpSweep({ brand }).catch((err) => {
      console.error('[scheduler] follow-up sweep failed:', err);
    });
  }, everyMs);

  // Don't let this timer keep the process alive on its own (mainly matters
  // for tests/scripts that import this module without running a server).
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();

  console.log(`[scheduler] Auto follow-up sweep is ON, running every ${minutes} minute(s).`);
  return intervalHandle;
}

function stopScheduler() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

module.exports = { runFollowUpSweep, findDueLeads, startScheduler, stopScheduler };
