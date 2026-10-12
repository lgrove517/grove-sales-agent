const { askClaude } = require('../integrations/anthropic');
const { brainToSystemPrompt } = require('../config/loadBrain');
const { detectInvestmentTopic, financialGuardsOn, checkSeparation, ensureMedicareDisclaimer } = require('../config/complianceGuard');
const { findUnapprovedFigures } = require('./contentAgent');
const db = require('../store/db');

/**
 * SOCIAL CALENDAR agent: "build the December social calendar" -> a month of
 * posts in the client's voice, ready to bulk-upload to GoHighLevel's Social
 * Planner (the same basic-sample.csv columns GHL provides). The client's
 * phone, website and booking link come from their brain, so nobody has to
 * fill in "[insert phone number]". Posts are drafts: the client reviews the
 * list on the dashboard, then downloads the file and uploads it to GHL.
 *
 * Optional per-client settings in the brain:
 *   "socialCalendar": { "days": [1,3,5], "time": "09:00:00" }
 *   days = weekdays to post (0 Sun ... 6 Sat); default Mon/Wed/Fri at 9:00.
 */
const GHL_HEADERS = ['postAtSpecificTime (YYYY-MM-DD HH:mm:ss)', 'content', 'link (OGmetaUrl)', 'imageUrls', 'gifUrl', 'videoUrls'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Which month is wanted: a month name in the instruction (next occurrence, or the year given), else next month. */
function pickMonth(instruction, now = new Date()) {
  const lower = String(instruction || '').toLowerCase();
  let month = MONTHS.findIndex((m) => new RegExp(`\\b${m}\\b|\\b${m.slice(0, 3)}\\b`).test(lower));
  const yearMatch = lower.match(/\b(20\d\d)\b/);
  let year = now.getFullYear();
  if (month === -1) {
    month = (now.getMonth() + 1) % 12;
    if (month === 0) year += 1;
  } else if (!yearMatch && month < now.getMonth()) {
    year += 1; // "January" said in October means next January
  }
  if (yearMatch) year = Number(yearMatch[1]);
  return { year, month };
}

function postingDates(year, month, days) {
  const out = [];
  for (let d = 1; d <= 31; d++) {
    const dt = new Date(Date.UTC(year, month, d));
    if (dt.getUTCMonth() !== month) break;
    if (days.includes(dt.getUTCDay())) out.push({ date: dt.toISOString().slice(0, 10), weekday: DAY_NAMES[dt.getUTCDay()] });
  }
  return out;
}

const ROLE_PROMPT = `
You are the SOCIAL CALENDAR agent. Write one social media post for EACH date
listed, for the business above, in its voice. These go to Facebook, LinkedIn,
Instagram and Google Business Profile through a scheduling tool.

Mix the month like a good small-business page:
- helpful tips about the problem the business solves (about half)
- a question that invites comments (about one a week)
- a clear next step with the contact details given below (about one a week)
- a short, warm note for a well-known holiday or observance that falls on or
  just before a listed date (only real ones; skip if none)

Rules:
- 1 to 4 short sentences each, plain words, no hashtag walls (0 to 2 hashtags).
- Use ONLY the phone, website and booking link given below - never a placeholder.
- Never invent statistics, results, testimonials, news or article links.
- Follow every guardrail above. Nothing that needs a licensed professional's
  personal judgment, and nothing a compliance reviewer would flag.
- "linkWebsite": true only on posts that send people to the website.

Output STRICT JSON only:
{ "posts": [ { "date": "YYYY-MM-DD", "content": "...", "linkWebsite": false } ] }
`.trim();

async function buildSocialCalendar({ brain, instruction }) {
  const cfg = brain.socialCalendar || {};
  const days = Array.isArray(cfg.days) && cfg.days.length ? cfg.days : [1, 3, 5];
  const time = /^\d\d:\d\d:\d\d$/.test(cfg.time || '') ? cfg.time : '09:00:00';
  const { year, month } = pickMonth(instruction);
  const dates = postingDates(year, month, days);
  const monthLabel = `${MONTHS[month][0].toUpperCase()}${MONTHS[month].slice(1)} ${year}`;

  const contact = [
    brain.phone ? `Phone: ${brain.phone}` : 'Phone: (none on file - do not mention a phone number)',
    brain.website ? `Website: ${brain.website}` : 'Website: (none on file - do not mention a website)',
    brain.bookingLink ? `Booking link: ${brain.bookingLink}` : 'Booking link: (none on file)',
  ].join('\n');

  const result = await askClaude({
    system: `${brainToSystemPrompt(brain)}\n\n${ROLE_PROMPT}`,
    messages: [{ role: 'user', content: `Month: ${monthLabel}\n${contact}\nExtra direction from the owner: ${instruction}\n\nDates:\n${dates.map((d) => `${d.date} (${d.weekday})`).join('\n')}` }],
    maxTokens: 6000,
  });

  let posts;
  if (result.dryRun) {
    posts = dates.map((d) => ({ date: d.date, content: `[DRY_RUN] ${brain.businessName} post for ${d.weekday} ${d.date}.`, linkWebsite: false }));
  } else {
    try {
      posts = JSON.parse((result.text.match(/\{[\s\S]*\}/) || [result.text])[0]).posts || [];
    } catch (err) {
      return { error: `The calendar came back in an unreadable form (${err.message}). Please try again.`, dryRun: false };
    }
  }

  // Keep only the scheduled dates, in order, and check every post in code.
  const byDate = new Map(posts.map((p) => [p.date, p]));
  const calendar = dates.map((d) => {
    const p = byDate.get(d.date);
    let content = String((p && p.content) || '').trim();
    const flags = [];
    if (!content) flags.push('No post was written for this date - write one or delete the row.');
    const sep = checkSeparation(content, brain);
    if (sep.blocked) flags.push(sep.reason);
    const topic = financialGuardsOn(brain) ? detectInvestmentTopic(content) : null;
    if (topic) flags.push(`Mentions ${topic}: investment content needs Gradient approval before it is posted.`);
    const figures = findUnapprovedFigures([content], brain);
    if (figures.length) flags.push(`Check these figures before posting: ${figures.join(', ')}.`);
    if (/\[[^\]]*\]/.test(content)) flags.push('Has a [placeholder] to fill in.');
    content = ensureMedicareDisclaimer(content, { brain }).messageText;
    return {
      date: d.date,
      weekday: d.weekday,
      time,
      content,
      link: p && p.linkWebsite && brain.website ? brain.website : '',
      flags,
    };
  });

  const csv = toCsv([GHL_HEADERS, ...calendar.map((c) => [`${c.date} ${c.time}`, c.content, c.link, '', '', ''])]);
  const flagged = calendar.filter((c) => c.flags.length).length;
  const fileName = `${brain.clientId}-${year}-${String(month + 1).padStart(2, '0')}-social.csv`;

  db.logEvent({ agent: 'socialCalendar', action: 'calendar', detail: { month: monthLabel, posts: calendar.length, flagged }, dryRun: result.dryRun });

  return {
    socialCalendar: true,
    month: monthLabel,
    calendar,
    csv,
    fileName,
    notes: `${calendar.length} posts for ${monthLabel} (${days.map((d) => DAY_NAMES[d].slice(0, 3)).join('/')} at ${time.slice(0, 5)}).` +
      (flagged ? ` ${flagged} need a look before you upload - see the notes under them.` : ' Review the list, then download the file and upload it in GHL: Marketing > Social Planner > Bulk upload (CSV).'),
    dryRun: result.dryRun,
  };
}

function toCsv(rows) {
  return rows.map((r) => r.map((v) => {
    const s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n') + '\r\n';
}

module.exports = { buildSocialCalendar, pickMonth, postingDates, toCsv, GHL_HEADERS };
