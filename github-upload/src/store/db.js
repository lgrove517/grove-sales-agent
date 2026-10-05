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

function insertLead(lead) {
  const stmt = db.prepare(`
    INSERT INTO leads (brand, first_name, last_name, email, phone, source, state, status, ghl_contact_id)
    VALUES (@brand, @firstName, @lastName, @email, @phone, @source, @state, @status, @ghlContactId)
  `);
  const info = stmt.run({
    brand: lead.brand,
    firstName: lead.firstName || null,
    lastName: lead.lastName || null,
    email: lead.email || null,
    phone: lead.phone || null,
    source: lead.source || null,
    state: lead.state || null,
    status: lead.status || 'new',
    ghlContactId: lead.ghlContactId || null,
  });
  return info.lastInsertRowid;
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

function listLeads({ brand, limit = 50 } = {}) {
  if (brand) {
    return db
      .prepare(`SELECT * FROM leads WHERE brand = ? ORDER BY created_at DESC LIMIT ?`)
      .all(brand, limit);
  }
  return db.prepare(`SELECT * FROM leads ORDER BY created_at DESC LIMIT ?`).all(limit);
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

module.exports = {
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
