const db = require('../store/db');
const { resolveLine, savedRates, saveRates, toAmount } = require('./incomePlan');

/**
 * AGENCY PLAN: the Medicare-front-door model. A team of Medicare agents meets
 * thousands of people turning 65; the few who ask about retirement income or
 * CDs are introduced to the advisor at a separate appointment. This projects
 * that, year by year:
 *
 *   agents x Medicare cases -> introductions (referral rate)
 *   -> new advisory clients (close rate) -> new assets (average account)
 *   -> advisory book, after market growth and outflows -> what it pays
 *
 * plus the Medicare renewal base the agency builds along the way.
 *
 *   "agency plan 6 agents, 250 cases each, 10% referral rate, 30% close rate"
 *   "agency plan 3 agents, 15 years, starting AUM $100,000"
 *
 * Every number says where it came from; anything not typed, saved or set in
 * the brain file (incomePlan.agency) is a labeled placeholder. Arithmetic
 * only - no AI call, nothing sent.
 */

const PARAMS = {
  agents: { label: 'Medicare agents', placeholder: 6, kind: 'count' },
  casesPerAgent: { label: 'Medicare cases per agent a year', placeholder: 250, kind: 'count' },
  referralRate: { label: 'Clients introduced to the advisor', placeholder: 0.1, kind: 'pct' },
  closeRate: { label: 'Introductions that become advisory clients', placeholder: 0.3, kind: 'pct' },
  marketGrowth: { label: 'Market growth on the book a year', placeholder: 0.04, kind: 'pct' },
  outflows: { label: 'Withdrawals and departures a year', placeholder: 0.05, kind: 'pct' },
  medicareRetention: { label: 'Medicare clients kept each year', placeholder: 0.85, kind: 'pct' },
  startingAum: { label: 'Advisory assets today', placeholder: 0, kind: 'money' },
  years: { label: 'Years projected', placeholder: 10, kind: 'count' },
};

const money = (n) => {
  const a = Math.abs(n);
  if (a >= 1e6) return `$${(n / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
};
const pct = (r) => `${Math.round(r * 1000) / 10}%`;
const fmt = (kind, v) => (kind === 'pct' ? pct(v) : kind === 'money' ? money(v) : Math.round(v).toLocaleString('en-US'));

/** Read every number typed in the command. */
function parseAgencyPlan(instruction) {
  let text = String(instruction || '');
  const out = {};
  const take = (re, key, conv) => {
    const m = text.match(re);
    if (!m) return;
    const v = conv(m[1]);
    if (v != null && v >= 0) out[key] = v;
    text = text.replace(m[0], ' ');
  };
  const rate = (s) => { const n = Number(s) / 100; return n >= 0 && n <= 1 ? n : null; };
  const int = (s) => { const n = Number(String(s).replace(/,/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };
  const AMT = String.raw`(\$?\s*\d[\d,]*(?:\.\d+)?\s*[km]?)\b`;
  const LINK = String.raw`\s*(?:rate|ratio)?\s*(?:of|is|=|:|at|around|about)?\s*`;

  take(/\breferr?al\s*(?:rate|ratio)?\s*(?:of|is|=|:|at|around|about)?\s*(\d+(?:\.\d+)?)\s*%/i, 'referralRate', rate);
  take(/(\d+(?:\.\d+)?)\s*%\s*(?:are\s+)?(?:referred|referrals?|introduced)/i, 'referralRate', rate);
  take(new RegExp(String.raw`\bclos(?:e|ing)${LINK}(\d+(?:\.\d+)?)\s*%`, 'i'), 'closeRate', rate);
  take(/(\d+(?:\.\d+)?)\s*%\s*clos(?:e|ing)\b(?:\s*(?:rate|ratio))?/i, 'closeRate', rate);
  take(/(\d+(?:\.\d+)?)\s*%\s*(?:market\s+)?growth\b/i, 'marketGrowth', rate);
  take(/(\d+(?:\.\d+)?)\s*%\s*(?:outflows?|withdrawals?|attrition)\b/i, 'outflows', rate);
  take(/(\d+(?:\.\d+)?)\s*%\s*(?:medicare\s+)?(?:retention|persistency)\b/i, 'medicareRetention', rate);
  take(new RegExp(String.raw`\b(?:market\s+)?growth${LINK}(\d+(?:\.\d+)?)\s*%`, 'i'), 'marketGrowth', rate);
  take(new RegExp(String.raw`\b(?:outflows?|withdrawals?|attrition)${LINK}(\d+(?:\.\d+)?)\s*%`, 'i'), 'outflows', rate);
  take(new RegExp(String.raw`\b(?:medicare\s+)?(?:retention|persistency)${LINK}(\d+(?:\.\d+)?)\s*%`, 'i'), 'medicareRetention', rate);
  take(new RegExp(String.raw`\b(?:starting|current|today'?s?)\s+(?:aum|assets|book)\s*(?:of|is|=|:|at)?\s*${AMT}`, 'i'), 'startingAum', toAmount);
  take(new RegExp(String.raw`\b(?:average|avg\.?)\s+(?:account|case)(?:\s+size)?\s*(?:of|is|=|:|at)?\s*${AMT}`, 'i'), 'avgAccount', toAmount);
  take(new RegExp(String.raw`${AMT}\s*(?:average|avg\.?)\s+(?:account|case)`, 'i'), 'avgAccount', toAmount);
  take(/\b(\d[\d,]*)\s*(?:medicare\s+)?(?:cases|enrollments|policies)\b(?:\s*(?:each|per agent|an agent|a year|per year))*/i, 'casesPerAgent', int);
  take(/\b(\d+)\s*(?:medicare\s+)?agents?\b/i, 'agents', int);
  take(/\b(\d+)\s*(?:-|\s)?years?\b/i, 'years', (s) => { const n = int(s); return n && n <= 40 ? n : null; });
  return out;
}

/** Pick each number and say where it came from. */
function resolveParams({ brain, typed }) {
  const saved = savedRates(brain.clientId);
  const fromBrain = (brain.incomePlan && brain.incomePlan.agency) || {};
  const out = {};
  for (const [key, p] of Object.entries(PARAMS)) {
    if (typed[key] != null) out[key] = { value: typed[key], source: 'your entry (saved for next time)' };
    else if (saved[`agency:${key}`] != null) out[key] = { value: saved[`agency:${key}`], source: 'your earlier entry' };
    else if (fromBrain[key] != null) out[key] = { value: Number(fromBrain[key]), source: (fromBrain.sources && fromBrain.sources[key]) || 'your business settings' };
    else if (key === 'years') out[key] = { value: p.placeholder, source: 'default - add "15 years" to change' };
    else out[key] = { value: p.placeholder, source: 'placeholder - replace with your real number', assumed: true };
  }
  return out;
}

/** The year-by-year arithmetic, on its own so it can be tested directly. */
function project({ agents, casesPerAgent, referralRate, closeRate, avgAccount, marketGrowth, outflows, medicareRetention, startingAum, years, feeRate, payout, renewalMonthly }) {
  let book = startingAum;
  let medicareClients = 0;
  const rows = [];
  let totalNewAssets = 0;
  for (let y = 1; y <= years; y++) {
    const cases = agents * casesPerAgent;
    const introductions = cases * referralRate;
    const newClients = introductions * closeRate;
    const newAssets = newClients * avgAccount;
    totalNewAssets += newAssets;
    // Growth and outflows on what was already there; this year's new assets added at year end.
    book = book * (1 + marketGrowth - outflows) + newAssets;
    // Renewals are paid on clients from earlier years who are still on the plan.
    const kept = medicareClients * medicareRetention;
    const renewals = kept * renewalMonthly * 12;
    medicareClients = kept + cases;
    rows.push({ year: y, cases, introductions, newClients, newAssets, book, advisoryPay: book * feeRate * payout, medicareClients, renewals });
  }
  return { rows, totalNewAssets };
}

function buildAgencyPlan({ brain, instruction }) {
  const typed = parseAgencyPlan(instruction);
  const aum = resolveLine({ brain, line: 'aum', typedFacts: typed.avgAccount ? { caseSize: typed.avgAccount } : {} });
  const medicare = resolveLine({ brain, line: 'medicare_new', typedFacts: {} });
  const toSave = {};
  for (const [k, v] of Object.entries(typed)) {
    if (k === 'avgAccount') toSave['aum:caseSize'] = v;
    else toSave[`agency:${k}`] = v;
  }
  if (Object.keys(toSave).length) saveRates(brain.clientId, toSave);

  const p = resolveParams({ brain, typed });
  const v = Object.fromEntries(Object.entries(p).map(([k, x]) => [k, x.value]));
  const f = Object.fromEntries(Object.entries(aum.facts).map(([k, x]) => [k, x.value]));
  const years = Math.max(1, Math.min(40, Math.round(v.years)));
  const { rows, totalNewAssets } = project({
    ...v, years, avgAccount: f.caseSize, feeRate: f.feeRate, payout: f.payout, renewalMonthly: medicare.facts.renewalMonthly.value,
  });
  const y1 = rows[0];
  const last = rows[rows.length - 1];
  const pick = years <= 10 ? rows : rows.filter((r) => r.year === 1 || r.year % 5 === 0 || r.year === years);
  const milestone = (target) => {
    const hit = rows.find((r) => r.book >= target);
    return hit ? `year ${hit.year}` : `not within ${years} years`;
  };

  const assumptions = [
    ...Object.entries(PARAMS).map(([k, x]) => [`${x.label}: ${fmt(x.kind, v[k])}`, p[k].source, p[k].assumed]),
    [`Average new advisory account: ${money(f.caseSize)}`, aum.facts.caseSize.source, aum.facts.caseSize.assumed],
    [`Advisory fee: ${pct(f.feeRate)} a year`, aum.facts.feeRate.source, aum.facts.feeRate.assumed],
    [`Your payout share: ${pct(f.payout)}`, aum.facts.payout.source, aum.facts.payout.assumed],
    [`Medicare renewal: $${medicare.facts.renewalMonthly.value} a month per client`, medicare.facts.renewalMonthly.source, medicare.facts.renewalMonthly.assumed],
  ];
  const placeholders = assumptions.filter((a) => a[2]).length;

  const sections = [
    { title: 'Each year, the agency writes', rows: [
      ['Medicare cases', `${Math.round(y1.cases).toLocaleString('en-US')} (${v.agents} agents x ${v.casesPerAgent})`],
      ['  clients introduced to you (separate appointment)', Math.round(y1.introductions).toLocaleString('en-US')],
      ['  who become advisory clients', Math.round(y1.newClients).toLocaleString('en-US')],
      ['  new advisory assets', money(y1.newAssets)],
    ] },
    { title: 'Year by year', rows: pick.map((r) => [
      `Year ${r.year}`,
      `book ${money(r.book)} · pays you ${money(r.advisoryPay)} a year · ${Math.round(r.medicareClients).toLocaleString('en-US')} Medicare clients on the books`,
    ]) },
    { title: `After ${years} year${years === 1 ? '' : 's'}`, rows: [
      ['Advisory book', money(last.book)],
      ['  of which new assets brought in', money(totalNewAssets)],
      ['Advisory pay at that size', `${money(last.advisoryPay)} a year, recurring`],
      ['Medicare clients still on the books', Math.round(last.medicareClients).toLocaleString('en-US')],
      ['Medicare renewals in the last year (agency-wide)', `${money(last.renewals)} - who receives them depends on your carrier and override contracts`],
      ['Book reaches $25M', milestone(25e6)],
      ['Book reaches $100M', milestone(100e6)],
    ] },
    { title: 'Where each number comes from', rows: assumptions.map((a) => [a[0], a[1]]) },
    { title: 'Keep it compliant', rows: [
      ['Medicare agents never discuss annuities or investments at a Medicare appointment', 'the client raises it; you meet them at a separate appointment'],
      ['No pay for advisory referrals', 'unless Gradient approves an arrangement'],
      ['Planning only', 'the agent never discusses investments with leads'],
    ] },
  ];
  if (placeholders) {
    sections.push({ title: 'Make it yours', rows: [
      [`${placeholders} number${placeholders === 1 ? ' is a placeholder' : 's are placeholders'}`, 'replace them with your own'],
      ['Type, for example', 'agency plan 6 agents, 250 cases each, 8% referral rate, 35% close rate, average account $175,000, starting AUM $100,000'],
    ] });
  }

  const summary = `${v.agents} Medicare agents writing ${v.casesPerAgent} cases each would introduce about ${Math.round(y1.introductions)} clients a year, ${Math.round(y1.newClients)} becoming advisory clients (${money(y1.newAssets)} a year). After ${years} years the advisory book is about ${money(last.book)}, paying you about ${money(last.advisoryPay)} a year.${placeholders ? ` ${placeholders} of the numbers are placeholders, so treat this as a sketch.` : ''}`;
  const clientText = [
    `Agency plan: ${v.agents} Medicare agents, ${v.casesPerAgent} cases each`,
    `- Medicare cases a year: ${Math.round(y1.cases).toLocaleString('en-US')}`,
    `- Introduced to the advisor: ${Math.round(y1.introductions)} (${pct(v.referralRate)})`,
    `- New advisory clients: ${Math.round(y1.newClients)} (${pct(v.closeRate)}), ${money(y1.newAssets)} a year`,
    ...pick.map((r) => `- Year ${r.year}: book ${money(r.book)}, advisory pay ${money(r.advisoryPay)} a year`),
    `Assumes ${pct(v.marketGrowth)} growth and ${pct(v.outflows)} outflows a year. A projection, not a promise.`,
  ].join('\n');

  db.logEvent({ agent: 'agencyPlan', action: 'plan', detail: { brand: brain.clientId, agents: v.agents, years, finalBook: Math.round(last.book), placeholders }, dryRun: false });
  return { monthlyReport: true, agencyPlan: true, month: 'Agency plan', summary, sections, clientText, clientTextLabel: 'Copy-ready plan' };
}

module.exports = { buildAgencyPlan, parseAgencyPlan, project };
