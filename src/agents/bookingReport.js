const db = require('../store/db');
const { pickReportMonth } = require('./monthlyReport');

/**
 * BOOKING REPORT (the "truth dashboard" for the Phase 1 booking sequence):
 * "booking report", "cost per appointment", "sequence results".
 * Every number is counted from the database - no AI call, no estimates.
 *
 *   opt-in leads -> sequence started -> messages sent -> opened -> clicked -> booked
 *   plus results by step (day 0/1/3/7) and, when ad spend has been entered,
 *   cost per lead and cost per booked appointment by source.
 *
 * Opens are approximate (some mail apps load images on their own, some
 * block them). Clicks skip known link scanners. Bookings are the number
 * that matters.
 */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n) => String(n).padStart(2, '0');
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '-');
const money = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

function buildBookingReport({ brain, instruction, now = new Date() }) {
  // A named month or "last month" picks that month; otherwise this month so far.
  const ask = String(instruction || '');
  const named = /\b(january|february|march|april|may|june|july|august|september|october|november|december|last month)\b/i.test(ask);
  const { year, month } = pickReportMonth(named ? ask : `${ask} this month`, now);
  const start = `${year}-${pad(month + 1)}-01 00:00:00`;
  const endYear = month === 11 ? year + 1 : year;
  const end = `${endYear}-${pad(((month + 1) % 12) + 1)}-01 00:00:00`;
  const monthKey = `${year}-${pad(month + 1)}`;
  const label = `${MONTHS[month]} ${year}`;
  const brand = brain.clientId;
  const one = (sql, ...a) => db.db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.db.prepare(sql).all(...a);
  const live = `'live'`;

  // Leads that came in this month.
  const leadWhere = `brand = ? AND created_at >= ? AND created_at < ? AND status != 'superseded' AND is_test = 0`;
  const leadsIn = one(`SELECT COUNT(*) n FROM leads WHERE ${leadWhere}`, brand, start, end).n;
  const optedIn = one(`SELECT COUNT(*) n FROM leads WHERE ${leadWhere} AND opt_in_via IS NOT NULL`, brand, start, end).n;
  const notOptedIn = one(`SELECT COUNT(*) n FROM leads WHERE ${leadWhere} AND seq_status = 'not_opted_in'`, brand, start, end).n;

  // The month's sequence cohort: leads whose sequence started this month.
  const cohort = all(`SELECT * FROM leads WHERE brand = ? AND seq_started_at >= ? AND seq_started_at < ? AND is_test = 0`, brand, start, end);
  const started = cohort.length;
  const cohortBooked = cohort.filter((l) => l.booked_at).length;
  const byStatus = (s) => cohort.filter((l) => l.seq_status === s).length;

  // Messages this month, by how they went out.
  const touchWhere = `t.brand = ? AND t.created_at >= ? AND t.created_at < ? AND l.is_test = 0`;
  const touches = all(`SELECT t.* FROM touches t JOIN leads l ON l.id = t.lead_id WHERE ${touchWhere}`, brand, start, end);
  const sent = touches.filter((t) => t.mode === 'live');
  const drafted = touches.filter((t) => t.mode === 'review' || t.mode === 'dry_run');
  const counted = sent.length ? sent : drafted; // in review mode, show the drafts' numbers
  const emails = counted.filter((t) => t.channel === 'Email');
  const texts = counted.filter((t) => t.channel === 'SMS');
  const opened = emails.filter((t) => t.first_open_at).length;
  const clicked = counted.filter((t) => t.click_count > 0);
  const leadsClicked = new Set(clicked.map((t) => t.lead_id)).size;

  // Bookings this month from people who were in the sequence.
  const bookedThisMonth = one(`SELECT COUNT(*) n FROM leads WHERE brand = ? AND booked_at >= ? AND booked_at < ? AND seq_started_at IS NOT NULL AND is_test = 0`, brand, start, end).n;

  // By step.
  const steps = all(`
    SELECT t.step, COUNT(*) sent, SUM(t.first_open_at IS NOT NULL AND t.channel = 'Email') opened,
           SUM(t.channel = 'Email') emails, SUM(t.click_count > 0) clicked, SUM(t.booked) booked
    FROM touches t JOIN leads l ON l.id = t.lead_id
    WHERE ${touchWhere} AND t.mode IN (${sent.length ? live : `'review','dry_run'`})
    GROUP BY t.step ORDER BY t.step`, brand, start, end);
  const stepDays = [0, ...((brain.bookingSequence && brain.bookingSequence.steps) || [{ day: 1 }, { day: 3 }, { day: 7 }]).map((s) => s.day)];

  // Cost, when spend has been entered for this month.
  const spend = db.spendFor(brand, monthKey);
  const totalSpend = spend.reduce((t, s) => t + s.amount, 0);
  const monthLeads = all(`SELECT source, opt_in_via, booked_at FROM leads WHERE ${leadWhere}`, brand, start, end);
  const costRows = spend.map((s) => {
    const mine = monthLeads.filter((l) => String(l.source || '').toLowerCase().includes(s.source));
    const booked = mine.filter((l) => l.booked_at).length;
    return [`  ${s.source}`, `${money(s.amount)} · ${mine.length} lead${mine.length === 1 ? '' : 's'} · ${booked} booked · ${mine.length ? money(s.amount / mine.length) : '-'}/lead · ${booked ? money(s.amount / booked) : '-'}/booked`];
  });
  const allBooked = monthLeads.filter((l) => l.booked_at).length;

  const reviewNote = !sent.length && drafted.length;
  const sections = [
    { title: 'Leads', rows: [
      ['New leads', leadsIn],
      ['  asked to hear from you (opted in)', optedIn],
      ['  not contacted - no opt-in on file', notOptedIn],
      ['Booking sequence started', started],
    ] },
    { title: reviewNote ? 'Messages (review mode - drafted, not sent)' : 'Messages sent', rows: [
      ['Emails', emails.length],
      ['  opened (approximate)', `${opened} (${pct(opened, emails.length)})`],
      ['Texts', texts.length],
      ['Messages with a link click', `${clicked.length} (${pct(clicked.length, counted.length)})`],
      ['People who clicked', leadsClicked],
    ] },
    { title: 'By step', rows: steps.map((s) => [`Day ${stepDays[s.step] ?? s.step}`, `${s.sent} sent · ${s.emails ? `${s.opened} opened · ` : ''}${s.clicked} clicked · ${s.booked} booked`]) },
    { title: 'Results', rows: [
      ['Booked appointments (sequence leads, this month)', bookedThisMonth],
      [`Of this month's ${started} started, booked so far`, `${cohortBooked} (${pct(cohortBooked, started)})`],
      ['  stopped - they replied', byStatus('stopped_replied')],
      ['  stopped - opted out', byStatus('stopped_opted_out')],
      ['  held for your review', byStatus('held') + byStatus('paused_error')],
      ['  still in the sequence', byStatus('active')],
      ['  finished, no booking yet', cohort.filter((l) => l.seq_status === 'completed' && !l.booked_at).length],
    ] },
    { title: 'Cost', rows: spend.length
      ? [['Spend entered', money(totalSpend)], ...costRows, ['Cost per booked appointment (all sources)', allBooked ? money(totalSpend / allBooked) : 'no bookings yet']]
      : [['No spend entered for this month', 'type: spent $250 on Facebook in ' + MONTHS[month]]] },
  ].filter((s) => s.rows.length);

  const parts = [`${optedIn} opted-in lead${optedIn === 1 ? '' : 's'}`, `${started} started`, `${bookedThisMonth} booked`];
  if (spend.length && allBooked) parts.push(`${money(totalSpend / allBooked)} per booked appointment`);
  const summary = `${label} booking sequence: ${parts.join(', ')}.${reviewNote ? ' Review mode is on, so these are drafts - nothing was sent.' : ''}`;

  const clientText = [
    `${label} booking results:`,
    `- Opted-in leads: ${optedIn}`,
    `- Booking sequence started: ${started}`,
    `- Emails ${reviewNote ? 'drafted' : 'sent'}: ${emails.length} (${pct(opened, emails.length)} opened)`,
    `- Texts ${reviewNote ? 'drafted' : 'sent'}: ${texts.length}`,
    `- Link clicks: ${clicked.length}`,
    `- Appointments booked: ${bookedThisMonth}`,
    spend.length ? `- Cost per booked appointment: ${allBooked ? money(totalSpend / allBooked) : 'no bookings yet'}` : null,
  ].filter(Boolean).join('\n');

  db.logEvent({ agent: 'bookingReport', action: 'report', detail: { brand, month: label, started, bookedThisMonth }, dryRun: false });
  return { monthlyReport: true, bookingReport: true, month: label, summary, sections, clientText, clientTextLabel: 'Copy-ready summary' };
}

/**
 * "spent $250 on Facebook in November" / "ad spend facebook 250 november"
 * -> { amount, source, month: "2026-11" }, or null when it can't tell.
 */
function parseSpend(instruction, now = new Date()) {
  const text = String(instruction || '');
  const amountMatch = text.match(/\$\s*([\d,]+(?:\.\d{1,2})?)|\b([\d,]+(?:\.\d{1,2})?)\s*(?:dollars|usd)\b|\b(?!20\d\d\b)([\d,]+(?:\.\d{1,2})?)\b/i);
  if (!amountMatch) return null;
  const amount = Number((amountMatch[1] || amountMatch[2] || amountMatch[3]).replace(/,/g, ''));
  const sourceMatch = text.match(/\b(?:on|for|from)\s+([a-z][\w .&'-]*?)(?:\s+(?:in|for|during|this|last)\b|[.,!]|$)/i);
  let source = sourceMatch ? sourceMatch[1].trim() : '';
  if (!source) {
    const bare = text.replace(/\$?\s*[\d,]+(?:\.\d+)?/g, ' ').replace(/\b(set|ad|ads|spend|spent|cost|i|we|my|our|in|on|for|this|last|month|dollars|usd|january|february|march|april|may|june|july|august|september|october|november|december|20\d\d)\b/gi, ' ').trim();
    source = bare.split(/\s+/)[0] || '';
  }
  source = source.replace(/\s+(ads?|advertising|leads?|campaigns?)$/i, '').trim();
  if (!source || !(amount >= 0)) return null;
  // Month: the one named (nearest one when no year is given), else last
  // month if they said so, else this month.
  let year = now.getFullYear();
  let month = now.getMonth();
  const names = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const named = text.toLowerCase().match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/);
  const yearMatch = text.match(/\b(20\d\d)\b/);
  if (named) {
    month = names.indexOf(named[1]);
    if (yearMatch) year = Number(yearMatch[1]);
    else {
      const diff = (year * 12 + month) - (now.getFullYear() * 12 + now.getMonth());
      if (diff > 6) year -= 1;
      else if (diff < -6) year += 1;
    }
  } else if (/last month/i.test(text)) {
    month -= 1;
    if (month < 0) { month = 11; year -= 1; }
  }
  return { amount, source: source.toLowerCase(), month: `${year}-${pad(month + 1)}` };
}

module.exports = { buildBookingReport, parseSpend };
