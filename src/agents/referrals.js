const db = require('../store/db');

/**
 * AGENCY REFERRALS: the loop that turns Medicare clients into advisory
 * conversations, and the scorecard that credits each agent.
 *
 *   1. A Medicare client raises retirement income, a CD or an annuity.
 *   2. The agent (with the client's OK) submits the agency referral form in
 *      GHL; a workflow posts it to /webhook/referral.
 *   3. The contact is recorded with the referring agent, tagged for you, and
 *      noted. No automated message goes out: you (or your staff) schedule a
 *      separate appointment personally.
 *   4. Booked and won come in through /webhook/status as usual.
 *
 * "Marcus wrote 22 Medicare cases in November" records an agent's cases, so
 * the scorecard can show each agent's referral rate.
 * "referral scorecard" / "referral scorecard this year" shows it per agent.
 */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const pad = (n) => String(n).padStart(2, '0');
const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '-');
const titleCase = (s) => String(s || '').trim().replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

db.db.exec(`
  CREATE TABLE IF NOT EXISTS agent_cases (
    brand TEXT NOT NULL,
    agent TEXT NOT NULL,
    month TEXT NOT NULL,
    cases INTEGER NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (brand, agent, month)
  );
`);

/** Month key "YYYY-MM": the named month (nearest one), "last month", or this month. */
function monthKey(text, now = new Date()) {
  const lower = String(text || '').toLowerCase();
  let year = now.getFullYear();
  let month = now.getMonth();
  const named = MONTHS.findIndex((m) => new RegExp(`\\b(${m}|${m.slice(0, 3)})\\b`).test(lower));
  const yearMatch = lower.match(/\b(20\d\d)\b/);
  if (named !== -1) {
    month = named;
    if (yearMatch) year = Number(yearMatch[1]);
    else {
      const diff = (year * 12 + month) - (now.getFullYear() * 12 + now.getMonth());
      if (diff > 6) year -= 1;
      else if (diff < -6) year += 1;
    }
  } else if (/last month/.test(lower)) {
    month -= 1;
    if (month < 0) { month = 11; year -= 1; }
  }
  return `${year}-${pad(month + 1)}`;
}

/** "Marcus Lee wrote 22 Medicare cases in November" -> { agent, cases, month } or null. */
function parseCases(instruction, now = new Date()) {
  const m = String(instruction || '').match(/^\s*(?:agent\s+)?([a-z][a-z .'-]*?)\s+(?:wrote|has written|enrolled|did|closed)\s+(\d[\d,]*)\s+(?:new\s+)?(?:medicare\s+)?(?:cases|enrollments|policies|apps|applications)\b(.*)$/i);
  if (!m) return null;
  const cases = Number(m[2].replace(/,/g, ''));
  if (!(cases >= 0)) return null;
  return { agent: titleCase(m[1]), cases, month: monthKey(m[3], now) };
}

function setCases({ brand, agent, month, cases }) {
  db.db.prepare(`
    INSERT INTO agent_cases (brand, agent, month, cases, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(brand, agent, month) DO UPDATE SET cases = excluded.cases, updated_at = CURRENT_TIMESTAMP`).run(brand, agent, month, cases);
}

/**
 * Record one referral. Finds the lead by GHL contact id or creates it, marks
 * who referred it, and returns { leadId, created }. Sends nothing.
 */
function recordReferral({ brain, contactId, firstName, lastName, email, phone, referredBy, interest }) {
  const agent = titleCase(referredBy) || 'Unknown agent';
  let lead = contactId ? db.findLeadByGhlContactId(contactId) : null;
  let created = false;
  if (!lead) {
    const leadId = db.insertLead({
      brand: brain.clientId, firstName, lastName, email, phone,
      source: `agency referral: ${agent}`, status: 'needs_human', ghlContactId: contactId || null,
    });
    lead = db.getLead(leadId);
    created = true;
  }
  // Hand it to the owner: no AI follow-ups, booking sequence held, until they schedule it personally.
  db.db.prepare(`UPDATE leads SET referred_by = ?, interest = COALESCE(?, interest),
      status = CASE WHEN status IN ('booked','won','opted_out') THEN status ELSE 'needs_human' END,
      seq_status = CASE WHEN seq_status IS NULL OR seq_status = 'active' THEN 'held' ELSE seq_status END
    WHERE id = ?`).run(agent, interest || null, lead.id);
  db.logEvent({ leadId: lead.id, agent: 'referrals', action: 'referral', detail: { referredBy: agent, interest: interest || null, contactId: contactId || null }, dryRun: false });
  return { leadId: lead.id, created, agent, lead: db.getLead(lead.id) };
}

function periodFor(instruction, now) {
  const lower = String(instruction || '').toLowerCase();
  const y = now.getFullYear();
  if (/\b(this year|year to date|ytd|all year|for the year)\b/.test(lower)) {
    return { start: `${y}-01-01 00:00:00`, end: `${y + 1}-01-01 00:00:00`, months: [`${y}-01`, `${y}-12`], label: `${y} so far` };
  }
  if (/\b(all time|ever|since the start)\b/.test(lower)) {
    return { start: '2000-01-01 00:00:00', end: '2100-01-01 00:00:00', months: ['2000-01', '2100-12'], label: 'All time' };
  }
  const key = monthKey(lower, now);
  const [yy, mm] = key.split('-').map(Number);
  const endKey = mm === 12 ? `${yy + 1}-01` : `${yy}-${pad(mm + 1)}`;
  return { start: `${key}-01 00:00:00`, end: `${endKey}-01 00:00:00`, months: [key, key], label: `${MONTHS[mm - 1][0].toUpperCase()}${MONTHS[mm - 1].slice(1)} ${yy}` };
}

function buildReferralScorecard({ brain, instruction, now = new Date() }) {
  const brand = brain.clientId;
  const p = periodFor(instruction, now);
  const leads = db.db.prepare(`
    SELECT l.referred_by agent, l.status, l.booked_at FROM leads l
    WHERE l.brand = ? AND l.referred_by IS NOT NULL AND l.is_test = 0
      AND l.id IN (SELECT e.lead_id FROM events e WHERE e.agent = 'referrals' AND e.action = 'referral' AND e.created_at >= ? AND e.created_at < ?)`)
    .all(brand, p.start, p.end);
  const cases = db.db.prepare(`SELECT agent, SUM(cases) n FROM agent_cases WHERE brand = ? AND month >= ? AND month <= ? GROUP BY agent`)
    .all(brand, p.months[0], p.months[1]);
  const byAgent = new Map();
  const row = (a) => {
    if (!byAgent.has(a)) byAgent.set(a, { agent: a, cases: 0, referrals: 0, booked: 0, won: 0 });
    return byAgent.get(a);
  };
  for (const c of cases) row(c.agent).cases = c.n;
  for (const l of leads) {
    const r = row(l.agent);
    r.referrals++;
    if (l.booked_at) r.booked++;
    if (l.status === 'won') r.won++;
  }
  const agents = [...byAgent.values()].sort((a, b) => b.referrals - a.referrals || b.cases - a.cases);
  const t = agents.reduce((s, a) => ({ cases: s.cases + a.cases, referrals: s.referrals + a.referrals, booked: s.booked + a.booked, won: s.won + a.won }), { cases: 0, referrals: 0, booked: 0, won: 0 });

  if (!agents.length) {
    return { message: `No agency referrals or Medicare cases recorded for ${p.label} yet. Referrals arrive from the agency referral form (see the README); record cases with: "Marcus wrote 22 Medicare cases in November".` };
  }
  const line = (a) => `${a.cases ? `${a.cases} cases · ` : ''}${a.referrals} referred${a.cases ? ` (${pct(a.referrals, a.cases)})` : ''} · ${a.booked} booked · ${a.won} became clients`;
  const sections = [
    { title: `By agent - ${p.label}`, rows: agents.map((a) => [a.agent, line(a)]) },
    { title: 'Agency total', rows: [
      ['Medicare cases recorded', t.cases || 'none entered - type "Marcus wrote 22 Medicare cases in November"'],
      ['Clients referred to you', `${t.referrals}${t.cases ? ` (${pct(t.referrals, t.cases)} of cases)` : ''}`],
      ['  appointments booked', `${t.booked} (${pct(t.booked, t.referrals)})`],
      ['  became advisory or annuity clients', `${t.won} (${pct(t.won, t.referrals)})`],
    ] },
  ];
  const summary = `${p.label}: ${t.referrals} agency referral${t.referrals === 1 ? '' : 's'} from ${agents.filter((a) => a.referrals).length} agent${agents.filter((a) => a.referrals).length === 1 ? '' : 's'}, ${t.booked} booked, ${t.won} became clients.`;
  const clientText = [`Agency referral scorecard - ${p.label}`, ...agents.map((a) => `- ${a.agent}: ${line(a)}`), `- Total: ${t.referrals} referred, ${t.booked} booked, ${t.won} became clients`].join('\n');
  db.logEvent({ agent: 'referrals', action: 'scorecard', detail: { brand, period: p.label, ...t }, dryRun: false });
  return { monthlyReport: true, referralScorecard: true, month: p.label, summary, sections, clientText, clientTextLabel: 'Copy-ready scorecard' };
}

module.exports = { recordReferral, parseCases, setCases, buildReferralScorecard, monthKey };
