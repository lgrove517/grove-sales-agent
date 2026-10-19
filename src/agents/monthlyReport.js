const db = require('../store/db');

/**
 * MONTHLY RESULTS REPORT (Growth and Premium): "monthly report",
 * "September results", "report for this month". Counted straight from the
 * database - no AI call, so every number is a real count, never a guess.
 *
 * Leads only show up here when the client's GoHighLevel workflow sends new
 * leads to the agent (/webhook/lead); on Growth they are logged, not worked.
 */
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** Which month to report: a named month, "this month", or by default last month. */
function pickReportMonth(instruction, now = new Date()) {
  const lower = String(instruction || '').toLowerCase();
  const yearMatch = lower.match(/\b(20\d\d)\b/);
  let year = now.getFullYear();
  let month = MONTHS.findIndex((m) => new RegExp(`\\b${m}\\b|\\b${m.slice(0, 3)}\\b`).test(lower));
  if (month === -1) {
    if (/this month|month to date|so far/.test(lower)) month = now.getMonth();
    else {
      month = now.getMonth() - 1;
      if (month < 0) { month = 11; year -= 1; }
    }
  } else if (!yearMatch && month > now.getMonth()) {
    year -= 1; // "November" said in March means last November
  }
  if (yearMatch) year = Number(yearMatch[1]);
  return { year, month };
}

const pad = (n) => String(n).padStart(2, '0');

function buildMonthlyReport({ brain, instruction, now = new Date() }) {
  const { year, month } = pickReportMonth(instruction, now);
  const start = `${year}-${pad(month + 1)}-01 00:00:00`;
  const endYear = month === 11 ? year + 1 : year;
  const end = `${endYear}-${pad(((month + 1) % 12) + 1)}-01 00:00:00`;
  const label = `${MONTHS[month][0].toUpperCase()}${MONTHS[month].slice(1)} ${year}`;
  const brand = brain.clientId;
  const partial = now >= new Date(`${start.replace(' ', 'T')}Z`) && now < new Date(`${end.replace(' ', 'T')}Z`);

  const q = (sql, ...a) => db.db.prepare(sql).all(...a);
  const n = (sql, ...a) => db.db.prepare(sql).get(...a).n;

  // Leads that came in this month (re-sends of the same contact count once).
  const leadsIn = n(`SELECT COUNT(*) n FROM leads WHERE brand = ? AND created_at >= ? AND created_at < ? AND status != 'superseded' AND is_test = 0`, brand, start, end);
  const bySource = q(`SELECT COALESCE(source,'unknown') k, COUNT(*) n FROM leads WHERE brand = ? AND created_at >= ? AND created_at < ? AND status != 'superseded' AND is_test = 0 GROUP BY k ORDER BY n DESC`, brand, start, end);

  // What the agents did for this client's leads this month.
  const actions = Object.fromEntries(q(`
    SELECT e.agent || ':' || e.action k, COUNT(*) n FROM events e JOIN leads l ON l.id = e.lead_id
    WHERE l.brand = ? AND e.created_at >= ? AND e.created_at < ? AND l.is_test = 0 GROUP BY k`, brand, start, end).map((r) => [r.k, r.n]));
  const sum = (pred) => Object.entries(actions).filter(([k]) => pred(k)).reduce((t, [, v]) => t + v, 0);

  const qualified = sum((k) => k === 'leadQualifier:qualified');
  const needsYou = sum((k) => k === 'leadQualifier:needs_human' || k === 'replyHandler:needs_human');
  const notAFit = sum((k) => k === 'leadQualifier:disqualified');
  const replies = sum((k) => k.startsWith('replyHandler:'));
  const wantsToBook = sum((k) => k === 'replyHandler:wants_to_book');
  const followUps = sum((k) => /^followUp:sent_attempt_/.test(k));
  const bookingLinks = sum((k) => k === 'appointmentSetter:send_booking_link');
  const booked = sum((k) => k === 'statusSync:booked');
  const won = sum((k) => k === 'statusSync:won');
  const optedOut = sum((k) => k === 'replyHandler:opted_out' || k === 'statusSync:opted_out');
  const held = sum((k) => /blocked/.test(k));

  // Marketing written in the command center this month.
  let postsPlanned = 0; let calendars = 0; let drafts = 0;
  for (const c of q(`SELECT response FROM commands WHERE brand = ? AND created_at >= ? AND created_at < ?`, brand, start, end)) {
    let r; try { r = JSON.parse(c.response); } catch { continue; }
    if (!r) continue;
    if (r.socialCalendar && Array.isArray(r.calendar)) { calendars += 1; postsPlanned += r.calendar.length; }
    if (Array.isArray(r.drafts)) drafts += r.drafts.length;
  }

  const sections = [
    { title: 'Leads', rows: [
      ['New leads', leadsIn],
      ...bySource.map((s) => [`  from ${s.k}`, s.n]),
    ] },
    { title: 'Lead conversations (Premium)', rows: [
      ['Good fit - first reply drafted', qualified],
      ['Replies from leads handled', replies],
      ['  wanted to book', wantsToBook],
      ['Follow-ups sent', followUps],
      ['Booking links sent', bookingLinks],
      ['Handed to you personally', needsYou],
      ['Not a fit', notAFit],
      ['Held for compliance review', held],
    ] },
    { title: 'Results', rows: [
      ['Appointments booked', booked],
      ['Won', won],
      ['Opted out', optedOut],
    ] },
    { title: 'Marketing', rows: [
      ['Social calendars built', calendars],
      ['Posts planned', postsPlanned],
      ['Content drafts written', drafts],
    ] },
  ].filter((s, i) => i === 0 || s.rows.some(([, v]) => v)); // hide sections with nothing in them

  const parts =[`${leadsIn} new lead${leadsIn === 1 ? '' : 's'}`];
  if (booked) parts.push(`${booked} appointment${booked === 1 ? '' : 's'} booked`);
  if (followUps) parts.push(`${followUps} follow-up${followUps === 1 ? '' : 's'} sent`);
  if (postsPlanned) parts.push(`${postsPlanned} social post${postsPlanned === 1 ? '' : 's'} planned`);
  const summary = `${label}${partial ? ' (so far)' : ''}: ${parts.join(', ')}.`;

  // Short, client-ready version Dr. Grove can paste into an email.
  const clientText = [
    `Hi - here is your ${label} results summary from Webtech Design${partial ? ' (month to date)' : ''}:`,
    ...sections.flatMap((s) => s.rows.filter(([k, v]) => v && !k.startsWith('  ')).map(([k, v]) => `- ${k}: ${v}`)),
    `Questions or ideas for next month? Just reply.`,
  ].join('\n');

  db.logEvent({ agent: 'monthlyReport', action: 'report', detail: { brand, month: label, leadsIn, booked }, dryRun: false });

  return { monthlyReport: true, month: label, partial, summary, sections, clientText };
}

module.exports = { buildMonthlyReport, pickReportMonth };
