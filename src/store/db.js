const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// DATA_DIR can point outside the app folder on a host, so redeploying the
// code never overwrites the lead database. Defaults to ./data locally.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'agent.db');

// Some zip/unzip tools drop empty directories, so don't assume `data/`
// survived extraction - create it if needed before opening the database.
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand TEXT NOT NULL,
    first_name TEXT,
    last_name TEXT,
    email TEXT,
    phone TEXT,
    source TEXT,
    state TEXT,
    status TEXT DEFAULT 'new',
    ghl_contact_id TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER,
    agent TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT,
    dry_run INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (lead_id) REFERENCES leads(id)
  );

  CREATE TABLE IF NOT EXISTS user_visits (
    username TEXT NOT NULL,
    brand TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    PRIMARY KEY (username, brand)
  );

  CREATE TABLE IF NOT EXISTS commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand TEXT NOT NULL,
    instruction TEXT NOT NULL,
    response TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// Lightweight migration: add follow-up scheduling columns to leads if this
// is an existing database from before the auto follow-up scheduler existed.
// SQLite has no "ADD COLUMN IF NOT EXISTS", so check pragma table_info first.
const leadColumns = db.prepare(`PRAGMA table_info(leads)`).all().map((c) => c.name);
if (!leadColumns.includes('follow_up_attempt')) {
  db.exec(`ALTER TABLE leads ADD COLUMN follow_up_attempt INTEGER DEFAULT 0`);
}
if (!leadColumns.includes('next_follow_up_at')) {
  db.exec(`ALTER TABLE leads ADD COLUMN next_follow_up_at TEXT`);
}
// ZIP code: picks the right county for the Medicare plan-count disclaimer.
if (!leadColumns.includes('postal_code')) {
  db.exec(`ALTER TABLE leads ADD COLUMN postal_code TEXT`);
}
// Test leads: marked from the command center so they drop out of the
// lead list, briefings, reports and follow-ups (the row is kept).
if (!leadColumns.includes('is_test')) {
  db.exec(`ALTER TABLE leads ADD COLUMN is_test INTEGER DEFAULT 0`);
}
// Phase 1 booking sequence (opt-in leads only). seq_status is null until the
// lead is checked for opt-in, then one of: active, not_opted_in, held,
// paused_error, completed, stopped_replied, stopped_booked,
// stopped_opted_out, stopped_won. seq_step = follow-up steps done so far.
for (const [col, type] of [
  ['interest', 'TEXT'], // what the lead said on the form - personalizes follow-ups
  ['opt_in_via', 'TEXT'],
  ['sms_consent', 'INTEGER DEFAULT 0'],
  ['seq_status', 'TEXT'],
  ['seq_step', 'INTEGER DEFAULT 0'],
  ['seq_started_at', 'TEXT'],
  ['booked_at', 'TEXT'],
  // Phase 2 AI caller. call_status: scheduled, placed, review_ready,
  // completed, no_answer, opted_out, wrong_number, cancelled, expired,
  // excluded_medicare.
  ['call_consent', 'INTEGER DEFAULT 0'],
  ['call_status', 'TEXT'],
  ['call_attempts', 'INTEGER DEFAULT 0'],
  ['call_due_at', 'TEXT'],
  ['call_last_at', 'TEXT'],
  ['call_tz', 'TEXT'],
  // Agency referrals: the agent who introduced this person (see /webhook/referral).
  ['referred_by', 'TEXT'],
]) {
  if (!leadColumns.includes(col)) db.exec(`ALTER TABLE leads ADD COLUMN ${col} ${type}`);
}

db.exec(`
  -- One row per sequence message drafted or sent, with its tracking code.
  CREATE TABLE IF NOT EXISTS touches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    lead_id INTEGER NOT NULL,
    brand TEXT NOT NULL,
    step INTEGER NOT NULL,
    channel TEXT NOT NULL,
    url TEXT NOT NULL,
    mode TEXT NOT NULL,
    open_count INTEGER DEFAULT 0,
    first_open_at TEXT,
    click_count INTEGER DEFAULT 0,
    first_click_at TEXT,
    booked INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  -- Ad / lead spend per client, month (YYYY-MM) and source, for cost per booked appointment.
  CREATE TABLE IF NOT EXISTS spend (
    brand TEXT NOT NULL,
    month TEXT NOT NULL,
    source TEXT NOT NULL,
    amount REAL NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (brand, month, source)
  );
`);

function insertLead(lead) {
  const stmt = db.prepare(`
    INSERT INTO leads (brand, first_name, last_name, email, phone, source, state, postal_code, status, ghl_contact_id)
    VALUES (@brand, @firstName, @lastName, @email, @phone, @source, @state, @postalCode, @status, @ghlContactId)
  `);
  const info = stmt.run({
    brand: lead.brand,
    firstName: lead.firstName || null,
    lastName: lead.lastName || null,
    email: lead.email || null,
    phone: lead.phone || null,
    source: lead.source || null,
    state: lead.state || null,
    postalCode: lead.postalCode || null,
    status: lead.status || 'new',
    ghlContactId: lead.ghlContactId || null,
  });
  // A contact already marked as a test stays a test when GHL re-sends it.
  if (lead.ghlContactId) {
    db.prepare(`
      UPDATE leads SET is_test = 1 WHERE id = ? AND EXISTS (
        SELECT 1 FROM leads WHERE ghl_contact_id = ? AND is_test = 1 AND id != ?)
    `).run(info.lastInsertRowid, lead.ghlContactId, info.lastInsertRowid);
  }
  return info.lastInsertRowid;
}

/**
 * Mark (or unmark) a lead as a test. Every copy of the same GHL contact in
 * the same brand is marked too, so a re-send doesn't bring it back.
 * Returns the number of rows changed (0 = no such lead in this brand).
 */
function setLeadTest(leadId, brand, isTest = true) {
  const lead = db.prepare(`SELECT * FROM leads WHERE id = ? AND brand = ?`).get(leadId, brand);
  if (!lead) return 0;
  const flag = isTest ? 1 : 0;
  if (lead.ghl_contact_id) {
    return db.prepare(`UPDATE leads SET is_test = ? WHERE brand = ? AND (id = ? OR ghl_contact_id = ?)`)
      .run(flag, brand, leadId, lead.ghl_contact_id).changes;
  }
  return db.prepare(`UPDATE leads SET is_test = ? WHERE id = ?`).run(flag, leadId).changes;
}

function updateLeadStatus(leadId, status) {
  db.prepare(`UPDATE leads SET status = ? WHERE id = ?`).run(status, leadId);
}

/** Remember which GoHighLevel contact a lead belongs to (follow-ups need it). */
function setLeadGhlContactId(leadId, ghlContactId) {
  db.prepare(`UPDATE leads SET ghl_contact_id = ? WHERE id = ?`).run(ghlContactId || null, leadId);
}

/**
 * When the same GHL contact is sent to the agent again, retire its older
 * lead rows so the scheduler runs ONE follow-up sequence per person, not
 * one per time the tag was applied.
 */
function supersedeOlderLeads(ghlContactId, keepLeadId) {
  if (!ghlContactId) return 0;
  return db
    .prepare(`UPDATE leads SET status = 'superseded' WHERE ghl_contact_id = ? AND id != ? AND status NOT IN ('superseded','opted_out','booked','won')`)
    .run(ghlContactId, keepLeadId).changes;
}

/** Fill in a lead's ZIP when a later webhook (e.g. a reply) carries it. */
function setLeadPostalCode(leadId, postalCode) {
  db.prepare(`UPDATE leads SET postal_code = ? WHERE id = ?`).run(postalCode || null, leadId);
}

function getLead(leadId) {
  return db.prepare(`SELECT * FROM leads WHERE id = ?`).get(leadId);
}

/**
 * Called by the auto follow-up scheduler after a real (non-blocked) send:
 * bumps the attempt counter and schedules the next due date. Pass
 * nextFollowUpAt as null when the lead has used up its last attempt, so
 * findDueLeads() naturally stops surfacing it (attempt >= maxAttempts).
 */
function recordFollowUpAttempt(leadId, attemptNumber, nextFollowUpAt) {
  db.prepare(`UPDATE leads SET follow_up_attempt = ?, next_follow_up_at = ? WHERE id = ?`).run(
    attemptNumber,
    nextFollowUpAt || null,
    leadId
  );
}

// Test leads are left out unless includeTest is set, so the scheduler,
// the command center and the agents never work them.
function listLeads({ brand, limit = 50, includeTest = false } = {}) {
  const notTest = includeTest ? '' : 'AND is_test = 0';
  if (brand) {
    return db
      .prepare(`SELECT * FROM leads WHERE brand = ? ${notTest} ORDER BY created_at DESC LIMIT ?`)
      .all(brand, limit);
  }
  return db.prepare(`SELECT * FROM leads WHERE 1 = 1 ${notTest} ORDER BY created_at DESC LIMIT ?`).all(limit);
}

function logEvent({ leadId, agent, action, detail, dryRun }) {
  db.prepare(`
    INSERT INTO events (lead_id, agent, action, detail, dry_run)
    VALUES (?, ?, ?, ?, ?)
  `).run(leadId || null, agent, action, typeof detail === 'string' ? detail : JSON.stringify(detail), dryRun ? 1 : 0);
}

function listEvents({ leadId, limit = 100 } = {}) {
  if (leadId) {
    return db
      .prepare(`SELECT * FROM events WHERE lead_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(leadId, limit);
  }
  return db.prepare(`SELECT * FROM events ORDER BY created_at DESC LIMIT ?`).all(limit);
}

function logCommand({ brand, instruction, response }) {
  db.prepare(`
    INSERT INTO commands (brand, instruction, response)
    VALUES (?, ?, ?)
  `).run(brand, instruction, typeof response === 'string' ? response : JSON.stringify(response));
}

function listCommands({ limit = 50 } = {}) {
  return db.prepare(`SELECT * FROM commands ORDER BY created_at DESC LIMIT ?`).all(limit);
}

// --- "Since your last visit" briefing support ------------------------------
// Times are stored the same way as CURRENT_TIMESTAMP: UTC "YYYY-MM-DD HH:MM:SS",
// so plain string comparison orders them correctly.
function toDbTime(date) {
  return new Date(date).toISOString().replace('T', ' ').slice(0, 19);
}

function getLastVisit(username, brand) {
  const row = db.prepare(`SELECT last_seen FROM user_visits WHERE username = ? AND brand = ?`).get(username || '', brand);
  return row ? row.last_seen : null;
}

function setLastVisit(username, brand, when = new Date()) {
  db.prepare(`
    INSERT INTO user_visits (username, brand, last_seen) VALUES (?, ?, ?)
    ON CONFLICT(username, brand) DO UPDATE SET last_seen = excluded.last_seen
  `).run(username || '', brand, toDbTime(when));
}

/** Leads for one client created after `since` (newest first). */
function leadsSince(brand, since) {
  return db
    .prepare(`SELECT * FROM leads WHERE brand = ? AND created_at > ? AND is_test = 0 ORDER BY created_at DESC`)
    .all(brand, since);
}

/**
 * Agent events for one client after `since`. Events carry no brand of their
 * own, so they are matched through their lead (lead-less events such as
 * content drafts show up through commandsSince instead).
 */
function eventsSince(brand, since) {
  return db
    .prepare(`
      SELECT e.*, l.first_name, l.last_name, l.status AS lead_status
      FROM events e JOIN leads l ON l.id = e.lead_id
      WHERE l.brand = ? AND e.created_at > ? AND l.is_test = 0
      ORDER BY e.created_at DESC
    `)
    .all(brand, since);
}

/** Commands typed in the command center for one client after `since`. */
function commandsSince(brand, since) {
  return db
    .prepare(`SELECT id, instruction, created_at FROM commands WHERE brand = ? AND created_at > ? ORDER BY created_at DESC`)
    .all(brand, since);
}

/** Leads that are waiting on a human right now, oldest first. */
function leadsNeedingHuman(brand, limit = 10) {
  return db
    .prepare(`SELECT * FROM leads WHERE brand = ? AND status = 'needs_human' AND is_test = 0 ORDER BY created_at ASC LIMIT ?`)
    .all(brand, limit);
}

/** Latest event of a given agent for a lead (used to show the "why"). */
/**
 * The current lead for a GoHighLevel contact: the newest copy that hasn't
 * been superseded by a later re-send. Used when a reply or a status change
 * comes in from GHL, which only knows the contact id.
 */
function findLeadByGhlContactId(ghlContactId) {
  if (!ghlContactId) return null;
  return db
    .prepare(`SELECT * FROM leads WHERE ghl_contact_id = ? AND status != 'superseded' ORDER BY id DESC LIMIT 1`)
    .get(ghlContactId) || null;
}

function latestEvent(leadId, agent) {
  return db
    .prepare(`SELECT * FROM events WHERE lead_id = ? AND agent = ? ORDER BY id DESC LIMIT 1`)
    .get(leadId, agent);
}

/** Pipeline numbers for the recommendations prompt (last `days` days). */
function pipelineStats(brand, days = 30) {
  const since = toDbTime(Date.now() - days * 86400000);
  const count = (sql, ...args) => db.prepare(sql).get(...args).n;
  const group = (sql, ...args) =>
    Object.fromEntries(db.prepare(sql).all(...args).map((r) => [r.k || 'unknown', r.n]));
  return {
    windowDays: days,
    totalLeads: count(`SELECT COUNT(*) n FROM leads WHERE brand = ? AND created_at > ? AND status != 'superseded' AND is_test = 0`, brand, since),
    leadsBySource: group(`SELECT source k, COUNT(*) n FROM leads WHERE brand = ? AND created_at > ? AND status != 'superseded' AND is_test = 0 GROUP BY source`, brand, since),
    leadsByStatus: group(`SELECT status k, COUNT(*) n FROM leads WHERE brand = ? AND created_at > ? AND status != 'superseded' AND is_test = 0 GROUP BY status`, brand, since),
    agentActions: group(`
      SELECT e.action k, COUNT(*) n FROM events e JOIN leads l ON l.id = e.lead_id
      WHERE l.brand = ? AND e.created_at > ? AND l.is_test = 0 GROUP BY e.action`, brand, since),
    waitingOnYouNow: count(`SELECT COUNT(*) n FROM leads WHERE brand = ? AND status = 'needs_human' AND is_test = 0`, brand),
    allTimeBooked: count(`SELECT COUNT(*) n FROM leads WHERE brand = ? AND status IN ('booked','won') AND is_test = 0`, brand),
  };
}

// --- Phase 1 booking sequence ---------------------------------------------

/** Set any of the sequence fields on a lead (only the keys given change). */
function updateLeadSequence(leadId, fields) {
  const map = { seqStatus: 'seq_status', seqStep: 'seq_step', seqStartedAt: 'seq_started_at', optInVia: 'opt_in_via', smsConsent: 'sms_consent', interest: 'interest', bookedAt: 'booked_at' };
  const sets = []; const vals = [];
  for (const [k, col] of Object.entries(map)) {
    if (k in fields) { sets.push(`${col} = ?`); vals.push(typeof fields[k] === 'boolean' ? Number(fields[k]) : fields[k]); }
  }
  if (!sets.length) return 0;
  return db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...vals, leadId).changes;
}

/** Leads with an active sequence for one client (test leads left out). */
function activeSequenceLeads(brand) {
  return db.prepare(`SELECT * FROM leads WHERE brand = ? AND seq_status = 'active' AND is_test = 0 ORDER BY id`).all(brand);
}

/** Set any of the AI caller fields on a lead (only the keys given change). */
function updateLeadCall(leadId, fields) {
  const map = { callConsent: 'call_consent', callStatus: 'call_status', callAttempts: 'call_attempts', callDueAt: 'call_due_at', callLastAt: 'call_last_at', callTz: 'call_tz' };
  const sets = []; const vals = [];
  for (const [k, col] of Object.entries(map)) {
    if (k in fields) { sets.push(`${col} = ?`); vals.push(typeof fields[k] === 'boolean' ? Number(fields[k]) : fields[k]); }
  }
  if (!sets.length) return 0;
  return db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...vals, leadId).changes;
}

/** Scheduled AI calls that are due by `nowDb` (UTC "YYYY-MM-DD HH:MM:SS"), oldest first. */
function dueCalls(brand, nowDb) {
  return db.prepare(`SELECT * FROM leads WHERE brand = ? AND call_status = 'scheduled' AND call_due_at <= ? AND is_test = 0 ORDER BY call_due_at`).all(brand, nowDb);
}

/** Leads called (or readied in review mode) for a client since a time - for the daily cap. */
function callsPlacedSince(brand, sinceDb) {
  return db.prepare(`SELECT COUNT(*) n FROM leads WHERE brand = ? AND call_last_at >= ? AND is_test = 0`).get(brand, sinceDb).n;
}

function insertTouch({ code, leadId, brand, step, channel, url, mode }) {
  db.prepare(`INSERT INTO touches (code, lead_id, brand, step, channel, url, mode) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(code, leadId, brand, step, channel, url, mode);
}

function getTouch(code) {
  return db.prepare(`SELECT * FROM touches WHERE code = ?`).get(code) || null;
}

/** Count an email open or a link click; returns the touch (null if the code is unknown). */
function recordTouchEvent(code, kind) {
  const t = getTouch(code);
  if (!t) return null;
  const now = toDbTime(new Date());
  if (kind === 'open') {
    db.prepare(`UPDATE touches SET open_count = open_count + 1, first_open_at = COALESCE(first_open_at, ?) WHERE id = ?`).run(now, t.id);
  } else if (kind === 'click') {
    // A click means the email was opened too, even when images were blocked.
    db.prepare(`UPDATE touches SET click_count = click_count + 1, first_click_at = COALESCE(first_click_at, ?), first_open_at = COALESCE(first_open_at, ?) WHERE id = ?`).run(now, now, t.id);
  }
  return getTouch(code);
}

/**
 * Give a booking to the message that earned it: the latest touch the lead
 * clicked, otherwise the latest touch they were sent. Returns that touch.
 */
function creditBooking(leadId) {
  // Every lead row for the same GHL contact counts (a contact re-sent to the
  // agent gets a new row, but earlier messages still earned the booking).
  const ids = `SELECT id FROM leads WHERE id = @leadId OR (ghl_contact_id IS NOT NULL AND ghl_contact_id = (SELECT ghl_contact_id FROM leads WHERE id = @leadId))`;
  const t = db.prepare(`SELECT * FROM touches WHERE lead_id IN (${ids}) AND click_count > 0 ORDER BY id DESC LIMIT 1`).get({ leadId })
    || db.prepare(`SELECT * FROM touches WHERE lead_id IN (${ids}) ORDER BY id DESC LIMIT 1`).get({ leadId });
  if (!t) return null;
  db.prepare(`UPDATE touches SET booked = 0 WHERE lead_id IN (${ids})`).run({ leadId });
  db.prepare(`UPDATE touches SET booked = 1 WHERE id = ?`).run(t.id);
  return t;
}

/** True when the agent actually sent this contact a message (live, not a draft). */
function agentReachedLead(leadId) {
  const ids = `SELECT id FROM leads WHERE id = @leadId OR (ghl_contact_id IS NOT NULL AND ghl_contact_id = (SELECT ghl_contact_id FROM leads WHERE id = @leadId))`;
  return !!db.prepare(`SELECT 1 FROM touches WHERE lead_id IN (${ids}) AND mode = 'live' LIMIT 1`).get({ leadId });
}

function setSpend({ brand, month, source, amount }) {
  db.prepare(`
    INSERT INTO spend (brand, month, source, amount, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(brand, month, source) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at
  `).run(brand, month, String(source).trim().toLowerCase(), Number(amount));
}

function spendFor(brand, month) {
  return db.prepare(`SELECT source, amount FROM spend WHERE brand = ? AND month = ? ORDER BY source`).all(brand, month);
}

module.exports = {
  updateLeadCall,
  dueCalls,
  callsPlacedSince,
  updateLeadSequence,
  activeSequenceLeads,
  insertTouch,
  getTouch,
  recordTouchEvent,
  creditBooking,
  agentReachedLead,
  setSpend,
  spendFor,
  setLeadTest,
  setLeadPostalCode,
  toDbTime,
  getLastVisit,
  setLastVisit,
  leadsSince,
  eventsSince,
  commandsSince,
  leadsNeedingHuman,
  latestEvent,
  findLeadByGhlContactId,
  pipelineStats,
  db,
  insertLead,
  updateLeadStatus,
  setLeadGhlContactId,
  supersedeOlderLeads,
  getLead,
  listLeads,
  recordFollowUpAttempt,
  logEvent,
  listEvents,
  logCommand,
  listCommands,
};
