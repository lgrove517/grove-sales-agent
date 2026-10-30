/**
 * DEMO DATA for sales demos (brains with "demo": true, e.g. demo-realty).
 *
 * seedDemo(brand)  - loads a set of made-up leads in every stage (new, good
 *                    fit, needs you, not a fit, follow-up sent, booked, opted
 *                    out), so the dashboard looks lived-in from the first click.
 * resetDemo(brand) - deletes everything this demo client has (leads, events,
 *                    commands, touches, visits, package override) and seeds
 *                    again, so every presentation starts clean.
 *
 * Both refuse to run on any brain that isn't marked "demo": true, so they can
 * never touch Grove Financial Group, VCF or a paying client.
 * All names, emails (@example.com) and phones (555-01xx) are fictional.
 */
const db = require('../store/db');
const { loadBrain } = require('../config/loadBrain');

function demoBrain(brand) {
  const brain = loadBrain(brand);
  if (!brain.demo) throw new Error(`"${brand}" is not a demo client - demo tools only work on brains marked "demo": true.`);
  return brain;
}

const ago = (hours) => db.toDbTime(Date.now() - hours * 3600000);

// Real-estate sample leads. hoursAgo controls where each shows up: the
// newest ones land in "Since your last visit".
const REALTY_LEADS = [
  {
    first: 'Tasha', last: 'Morgan', source: 'facebook_lead_form', hoursAgo: 1.5, status: 'active',
    verdict: 'qualified',
    reason: 'Pre-approved buyer, 60-day timeline, named Daphne and a price range in the service area.',
    reply: "Hi Tasha, thanks for reaching out! Congrats on the pre-approval. Daphne has some great options in your range right now. Would a quick 20-minute call this week work to go over what you're looking for? Then I'll set up a search so you see new listings first.",
  },
  {
    first: 'Marcus', last: 'Webb', source: 'website_form', hoursAgo: 2, status: 'needs_human',
    verdict: 'needs_human',
    reason: 'Wants to make an offer on 214 Bayou Lane and asked about negotiating the price - offers and negotiation go to an agent.',
  },
  {
    first: 'Denise', last: 'Carter', source: 'zillow', hoursAgo: 3, status: 'needs_human',
    verdict: 'needs_human',
    reason: "Asked which neighborhoods are 'safest for families' - a Fair Housing-sensitive question. No reply drafted; an agent should answer and point to public resources.",
  },
  {
    first: 'Robert', last: 'Hayes', source: 'website_form', hoursAgo: 5, status: 'active',
    verdict: 'qualified',
    reason: 'Homeowner in Fairhope thinking about selling next spring - good fit for the Free Home Value Review.',
    reply: "Hi Robert, thanks for getting in touch. Spring is a smart time to plan ahead. I'd be glad to put together a free home value review based on recent Fairhope sales - no obligation. Is this week or next better for a short call?",
  },
  {
    first: 'Kim', last: 'Nguyen', source: 'instagram_lead_form', hoursAgo: 30, status: 'active',
    verdict: 'qualified',
    reason: 'Relocating to Mobile for a hospital job starting in March; needs a rental-to-buy plan.',
    reply: "Hi Kim, welcome to Mobile (almost)! With a March start date we have time to do this right. Want to hop on a quick call to talk about areas near your new job and a plan to buy?",
    followUps: 1,
  },
  {
    first: 'James', last: 'Porter', source: 'facebook_lead_form', hoursAgo: 52, status: 'booked',
    verdict: 'qualified',
    reason: 'First-time buyer, pre-approved, 90-day timeline in West Mobile.',
    reply: "Hi James, great to hear from you! First homes are exciting. Let's find a time for a quick call so I can learn what matters most to you.",
    booked: true,
  },
  {
    first: 'Angela', last: 'Brooks', source: 'website_form', hoursAgo: 75, status: 'booked',
    verdict: 'qualified',
    reason: 'Requested a showing of a listing in Spanish Fort this weekend.',
    reply: "Hi Angela, happy to show you that home! I have Saturday morning or Sunday afternoon open. Which works better?",
    booked: true,
  },
  {
    first: 'Chris', last: 'Daniels', source: 'zillow', hoursAgo: 96, status: 'active',
    verdict: 'qualified',
    reason: 'Browsing for a home in Saraland, timeline 4-6 months.',
    reply: "Hi Chris, thanks for checking out homes in Saraland. Want me to set up a saved search so you see new listings first?",
    followUps: 2,
  },
  {
    first: 'Paul', last: 'Simmons', source: 'website_form', hoursAgo: 120, status: 'disqualified',
    verdict: 'disqualified',
    reason: 'Is a mortgage marketing vendor selling services to the team, not a buyer or seller.',
  },
  {
    first: 'Lisa', last: 'Grant', source: 'facebook_lead_form', hoursAgo: 150, status: 'opted_out',
    verdict: 'qualified',
    reason: 'Buyer in Mobile, 6-month timeline.',
    reply: "Hi Lisa, thanks for reaching out! What part of Mobile are you hoping to live in?",
    optedOut: true,
  },
];

// Ready-made inquiries for the "Send a live demo lead" button. The agent
// assesses one of these live, in front of the prospect.
const REALTY_LIVE_INQUIRIES = [
  { firstName: 'Olivia', lastName: 'Reed', message: "Hi, we're pre-approved up to $325k and want to be in Daphne or Fairhope before school starts in August. Can someone help?" },
  { firstName: 'Derrick', lastName: 'Hall', message: "I own a 3 bed in Midtown Mobile and I'm wondering what it would sell for. Not in a rush, maybe next year." },
  { firstName: 'Sandra', lastName: 'Lee', message: "Saw the house on Dauphin St. I want to put in an offer below asking today. What's the lowest they'll take?" },
  { firstName: 'Brian', lastName: 'Cole', message: "Moving from Atlanta for work. Which neighborhoods are safe and have the best schools for kids?" },
];

function seedRealty(brand) {
  const ids = [];
  REALTY_LEADS.forEach((l, i) => {
    const created = ago(l.hoursAgo);
    const info = db.db.prepare(`
      INSERT INTO leads (brand, first_name, last_name, email, phone, source, state, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'AL', ?, ?)
    `).run(brand, l.first, l.last, `${l.first}.${l.last}@example.com`.toLowerCase(), `+1251555${String(110 + i).padStart(4, '0')}`, l.source, l.status, created);
    const leadId = info.lastInsertRowid;
    ids.push(leadId);

    const ev = (agent, action, detail, hoursAfter = 0) =>
      db.db.prepare(`INSERT INTO events (lead_id, agent, action, detail, dry_run, created_at) VALUES (?, ?, ?, ?, 1, ?)`)
        .run(leadId, agent, action, JSON.stringify(detail), ago(Math.max(l.hoursAgo - hoursAfter, 0)));

    ev('leadQualifier', l.verdict, { verdict: l.verdict, reason: l.reason, reply: l.reply || '', demo: true }, 0.02);
    for (let n = 1; n <= (l.followUps || 0); n++) {
      ev('followUp', `sent_attempt_${n}`, { channel: n % 2 ? 'SMS' : 'Email', demo: true }, n * 24);
    }
    if (l.booked) ev('appointmentSetter', 'send_booking_link', { demo: true }, 1);
    if (l.booked) ev('statusSync', 'booked', { demo: true }, 6);
    if (l.optedOut) ev('statusSync', 'opted_out', { demo: true }, 30);
  });
  return ids.length;
}

const SEEDERS = { 'demo-realty': seedRealty };
const LIVE_INQUIRIES = { 'demo-realty': REALTY_LIVE_INQUIRIES };

function demoLeadCount(brand) {
  return db.db.prepare(`SELECT COUNT(*) n FROM leads WHERE brand = ?`).get(brand).n;
}

function seedDemo(brand) {
  demoBrain(brand);
  const seeder = SEEDERS[brand];
  if (!seeder) throw new Error(`No sample data written for demo "${brand}" yet.`);
  return seeder(brand);
}

function resetDemo(brand) {
  demoBrain(brand);
  const tx = db.db.transaction(() => {
    db.db.prepare(`DELETE FROM events WHERE lead_id IN (SELECT id FROM leads WHERE brand = ?)`).run(brand);
    for (const table of ['touches', 'commands', 'user_visits', 'client_packages']) {
      try { db.db.prepare(`DELETE FROM ${table} WHERE brand = ?`).run(brand); } catch { /* table may not exist yet */ }
    }
    db.db.prepare(`DELETE FROM leads WHERE brand = ?`).run(brand);
  });
  tx();
  return seedDemo(brand);
}

/** Seed every demo brain on this deployment that has no leads yet. */
function seedEmptyDemos(brainIds) {
  const seeded = [];
  for (const id of brainIds) {
    try {
      const b = loadBrain(id);
      if (b.demo && SEEDERS[id] && demoLeadCount(id) === 0) { seedDemo(id); seeded.push(id); }
    } catch { /* not served here */ }
  }
  return seeded;
}

function liveInquiry(brand, index) {
  demoBrain(brand);
  const list = LIVE_INQUIRIES[brand] || [];
  if (!list.length) throw new Error(`No live demo inquiries written for "${brand}".`);
  const i = Number.isInteger(index) ? index % list.length : Math.floor(Math.random() * list.length);
  return list[i];
}

module.exports = { seedDemo, resetDemo, seedEmptyDemos, liveInquiry, demoBrain, LIVE_INQUIRIES };
