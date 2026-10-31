const db = require('../store/db');

/**
 * INCOME PLAN: works backward from a goal to the opted-in leads the pipeline
 * has to bring in. The goal can be general or tied to one line of business,
 * because each line earns money differently:
 *
 *   "income plan $120,000"                        general: average commission per sale
 *   "income plan $90,000 from life insurance"     % of annual premium (first year)
 *   "income plan $2M annuity premium at 6%"       a production goal: premium written
 *   "income plan $40,000 from LTC"                % of premium
 *   "income plan $25,000 from new-to-Medicare"    flat first-year payout + monthly renewals
 *   "income plan $1M AUM next quarter"            an assets goal: payout shown, not chased
 *   "income plan $30,000 in planning fees"        fee per plan
 *
 * then: sales -> appointments held (close rate) -> booked (show rate)
 *       -> opted-in leads (booking rate)
 *
 * Every number says where it came from, in this order:
 *   1. typed in the command ("close rate 35%", "average case $80,000") - saved
 *   2. saved from an earlier income plan
 *   3. the booking rate measured from the agent's own last 90 days (30+ leads)
 *   4. "incomePlan" in the client's brain file (config/<client>.json)
 *   5. a placeholder, labeled as one
 * Pure arithmetic from the database - no AI call, nothing sent. Planning an
 * AUM goal never changes what the agent says to leads: investment topics
 * still go to the licensed advisor personally.
 */

const STARTING = { avgCommission: 2000, closeRate: 0.3, showRate: 0.8, bookingRate: 0.15 };
const MIN_SAMPLE = 30;
const WEEKS_PER_MONTH = 52 / 12;
const WORKDAYS_PER_MONTH = 21.7;

// Placeholder economics per line. A client's brain file (incomePlan.lines)
// replaces these with real payouts; anything still from here is labeled.
const LINES = {
  life: { label: 'Life insurance', kind: 'percent', basis: 'annual premium', rate: 0.9, caseSize: 1500 },
  annuity: { label: 'Annuities', kind: 'percent', basis: 'premium', rate: 0.06, caseSize: 100000 },
  ltc: { label: 'Long-term care', kind: 'percent', basis: 'premium', rate: 0.11, caseSize: 3000 },
  medicare_new: { label: 'Medicare (new to Medicare)', kind: 'flat', firstYear: 640, renewalMonthly: 28 },
  medicare_switch: { label: 'Medicare (plan change)', kind: 'flat', firstYear: 289, renewalMonthly: 28 },
  aum: { label: 'Advisory assets (AUM)', kind: 'aum', feeRate: 0.01, payout: 0.7, caseSize: 150000, fixedCostsYear: 2088 },
  planning: { label: 'Planning fees', kind: 'fee', fee: 1500 },
};
const FIELD_LABELS = {
  rate: 'Commission rate', caseSize: 'Average case size', firstYear: 'First-year payout', renewalMonthly: 'Renewal per month',
  feeRate: 'Advisory fee (yearly)', payout: 'Your payout share', fixedCostsYear: 'Fixed advisory costs a year', fee: 'Fee per plan',
  avgCommission: 'Average commission per sale', closeRate: 'Close rate (of appointments held)',
  showRate: 'Show rate (of appointments booked)', bookingRate: 'Booking rate (of opted-in leads)',
};
const MONEY_FIELDS = new Set(['caseSize', 'firstYear', 'renewalMonthly', 'fixedCostsYear', 'fee', 'avgCommission']);

db.db.exec(`
  CREATE TABLE IF NOT EXISTS plan_rates (
    brand TEXT NOT NULL,
    key TEXT NOT NULL,
    value REAL NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (brand, key)
  );
`);

const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const pct = (r) => `${Math.round(r * 1000) / 10}%`;
const show = (field, v) => (MONEY_FIELDS.has(field) ? money(v) : pct(v));

/** "$120,000", "120k", "1.5m", "$2M", "10000" -> number, or null. */
function toAmount(raw) {
  if (raw == null) return null;
  const m = String(raw).replace(/[$,\s]/g, '').match(/^(\d+(?:\.\d+)?)([km])?$/i);
  if (!m) return null;
  const mult = m[2] ? (m[2].toLowerCase() === 'k' ? 1e3 : 1e6) : 1;
  return Number(m[1]) * mult;
}

const AMOUNT = String.raw`\$?\s*\d[\d,]*(?:\.\d+)?\s*[km]?\b`;
const RATE = String.raw`(\d+(?:\.\d+)?)\s*%`;
const LINK = String.raw`\s*(?:rate|ratio)?\s*(?:of|is|=|:|at|around|about)?\s*`;

function detectLine(text) {
  const t = text.toLowerCase();
  if (/\b(aum|assets under management|advisory assets|new assets)\b/.test(t)) return 'aum';
  if (/\bmedicare\b/.test(t)) return /(switch|chang|replac|moving|plan change)/.test(t) ? 'medicare_switch' : 'medicare_new';
  if (/\b(ltc|long[- ]term care)\b/.test(t)) return 'ltc';
  if (/\bannuit(y|ies)\b/.test(t)) return 'annuity';
  if (/\blife( insurance)?\b/.test(t)) return 'life';
  if (/\b(planning fees?|plan fees?|financial plans?|fee[- ]based plan)/.test(t)) return 'planning';
  return null;
}

/**
 * Read the goal, the line of business and any numbers typed in the command.
 * -> { goal, goalType: 'income'|'production', line, period: 'year'|'quarter'|'month', rates, facts }
 */
function parseIncomeGoal(instruction) {
  let text = String(instruction || '');
  const line = detectLine(text);
  const rates = {};
  const facts = {};
  const take = (re, into, key, conv) => {
    const m = text.match(re);
    if (!m) return;
    const v = conv(m[1]);
    if (v != null && v > 0) into[key] = v;
    text = text.replace(m[0], ' ');
  };
  const rate = (s) => { const n = Number(s) / 100; return n > 0 && n <= 1 ? n : null; };

  take(new RegExp(String.raw`\bclos(?:e|ing)${LINK}${RATE}`, 'i'), rates, 'closeRate', rate);
  take(new RegExp(String.raw`\b(?:show(?:-up)?|attendance)${LINK}${RATE}`, 'i'), rates, 'showRate', rate);
  take(new RegExp(String.raw`\bbook(?:ing)?${LINK}${RATE}`, 'i'), rates, 'bookingRate', rate);
  take(new RegExp(String.raw`\b(?:average|avg\.?)\s+(?:case|premium|account|policy)(?:\s+size)?\s*(?:of|is|=|:|at|around|about)?\s*(${AMOUNT})`, 'i'), facts, 'caseSize', toAmount);
  take(new RegExp(String.raw`\b(?:case|account)\s+size\s*(?:of|is|=|:|at|around|about)?\s*(${AMOUNT})`, 'i'), facts, 'caseSize', toAmount);
  take(new RegExp(String.raw`(${AMOUNT})\s*(?:per|a|each)\s+plan\b`, 'i'), facts, 'fee', toAmount);
  take(new RegExp(String.raw`\b(?:advisory\s+)?fee\s*(?:of|is|=|:|at)?\s*${RATE}`, 'i'), facts, 'feeRate', rate);
  take(new RegExp(String.raw`\bpayout\s*(?:of|is|=|:|at)?\s*${RATE}`, 'i'), facts, 'payout', rate);
  // "at 6%" / "6% commission" - a commission rate for the line
  take(new RegExp(String.raw`(?:\bat\s+|\bcommission\s*(?:rate)?\s*(?:of|is|=|:|at)?\s*)${RATE}`, 'i'), facts, 'rate', rate);
  take(new RegExp(String.raw`${RATE}\s*commission`, 'i'), facts, 'rate', rate);
  // general plan: "average commission $2,000" / "$2,000 per sale"
  take(new RegExp(String.raw`\b(?:avg\.?|average)?\s*(?:commission|comp|revenue)(?:\s+per\s+(?:sale|case|policy|client))?\s*(?:of|is|=|:|at|around|about)?\s*(${AMOUNT})`, 'i'), rates, 'avgCommission', toAmount);
  take(new RegExp(String.raw`(${AMOUNT})\s*(?:average\s+)?(?:commission|per\s+(?:sale|case|policy|client))`, 'i'), rates, 'avgCommission', toAmount);

  const goalMatch = text.match(new RegExp(String.raw`(?:^|[^\d%])(${AMOUNT})(?!\s*%)`, 'i'));
  const goal = goalMatch ? toAmount(goalMatch[1]) : null;
  const after = goalMatch ? text.slice(goalMatch.index + goalMatch[0].length, goalMatch.index + goalMatch[0].length + 40).toLowerCase() : '';

  // Production goal (premium written, assets gathered) or income goal?
  let goalType = 'income';
  if (line === 'aum') goalType = /^\s*(?:in\s+)?(?:new\s+)?(aum|assets|in assets|under management)/.test(after) || !/\b(income|earn|make|from aum|revenue)\b/i.test(text) ? 'production' : 'income';
  else if (['annuity', 'life', 'ltc'].includes(line)) goalType = /^\s*(?:in\s+|of\s+)?(?:\w+\s+){0,2}(premium|production|written|in sales|of sales)/.test(after) ? 'production' : 'income';

  let period = 'year';
  if (/\bquarter(ly)?\b/i.test(text)) period = 'quarter';
  else if (/\b(per|a|each|every|this|next)\s+month\b|\bmonthly\b|\/\s*mo\b/i.test(text)) period = 'month';
  return { goal: goal && goal > 0 ? goal : null, goalType, line, period, rates, facts };
}

function savedRates(brand) {
  return Object.fromEntries(db.db.prepare(`SELECT key, value FROM plan_rates WHERE brand = ?`).all(brand).map((r) => [r.key, r.value]));
}

function saveRates(brand, rates) {
  const stmt = db.db.prepare(`
    INSERT INTO plan_rates (brand, key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(brand, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`);
  for (const [k, v] of Object.entries(rates)) stmt.run(brand, k, v);
}

/** Booking rate the agent has actually achieved over the last 90 days. */
function measuredBookingRate(brand, now) {
  const since = db.toDbTime(new Date(now.getTime() - 90 * 86400000));
  const row = db.db.prepare(`
    SELECT COUNT(*) leads, SUM(booked_at IS NOT NULL) booked FROM leads
    WHERE brand = ? AND created_at >= ? AND opt_in_via IS NOT NULL AND status != 'superseded' AND is_test = 0`).get(brand, since);
  return { leads: row.leads || 0, booked: row.booked || 0 };
}

function lastThirtyDays(brand, now) {
  const since = db.toDbTime(new Date(now.getTime() - 30 * 86400000));
  const one = (sql) => db.db.prepare(sql).get(brand, since).n || 0;
  return {
    leads: one(`SELECT COUNT(*) n FROM leads WHERE brand = ? AND created_at >= ? AND opt_in_via IS NOT NULL AND status != 'superseded' AND is_test = 0`),
    booked: one(`SELECT COUNT(*) n FROM leads WHERE brand = ? AND booked_at >= ? AND is_test = 0`),
  };
}

/** The four funnel rates, each with its source. A line's own saved rates win over general ones. */
function resolveRates({ brain, typed, line, now }) {
  const brand = brain.clientId;
  const saved = savedRates(brand);
  const fromBrain = (brain && brain.incomePlan) || {};
  const lineBrain = (line && fromBrain.lines && fromBrain.lines[line]) || {};
  const measured = measuredBookingRate(brand, now);
  const out = {};
  for (const key of Object.keys(STARTING)) {
    if (line && key === 'avgCommission') continue; // a line computes its own payout
    const lk = line ? `${line}:${key}` : null;
    if (typed[key] != null) out[key] = { value: typed[key], source: 'your entry (saved for next time)' };
    else if (lk && saved[lk] != null) out[key] = { value: saved[lk], source: 'your earlier entry for this line' };
    else if (saved[key] != null) out[key] = { value: saved[key], source: 'your earlier entry' };
    else if (key === 'bookingRate' && measured.leads >= MIN_SAMPLE && measured.booked > 0) {
      out[key] = { value: measured.booked / measured.leads, source: `measured: ${measured.booked} booked of ${measured.leads} opted-in leads, last 90 days` };
    } else if (Number(lineBrain[key]) > 0) out[key] = { value: Number(lineBrain[key]), source: 'your business settings' };
    else if (Number(fromBrain[key]) > 0) out[key] = { value: Number(fromBrain[key]), source: 'your business settings' };
    else out[key] = { value: STARTING[key], source: 'placeholder - replace with your real number', assumed: true };
  }
  return { rates: out, measured };
}

/** A line's economics (payout, case size...), each with its source. */
function resolveLine({ brain, line, typedFacts }) {
  const saved = savedRates(brain.clientId);
  const fromBrain = ((brain && brain.incomePlan && brain.incomePlan.lines) || {})[line] || {};
  const base = LINES[line];
  const facts = {};
  for (const [field, placeholder] of Object.entries(base)) {
    if (['label', 'kind', 'basis'].includes(field)) continue;
    const key = `${line}:${field}`;
    if (typedFacts[field] != null) facts[field] = { value: typedFacts[field], source: 'your entry (saved for next time)' };
    else if (saved[key] != null) facts[field] = { value: saved[key], source: 'your earlier entry' };
    else if (fromBrain[field] != null) facts[field] = { value: Number(fromBrain[field]), source: (fromBrain.sources && fromBrain.sources[field]) || fromBrain.source || 'your business settings' };
    else facts[field] = { value: placeholder, source: 'placeholder - replace with your real number', assumed: true };
  }
  return { ...base, label: fromBrain.label || base.label, facts };
}

/** The arithmetic, on its own so it can be tested directly. */
function workBackward({ monthlyIncome, avgCommission, closeRate, showRate, bookingRate, sales }) {
  const s = sales != null ? sales : Math.ceil(monthlyIncome / avgCommission);
  const held = Math.ceil(s / closeRate);
  const booked = Math.ceil(held / showRate);
  const leads = Math.ceil(booked / bookingRate);
  return { sales: s, held, booked, leads };
}

const PERIOD_MONTHS = { year: 12, quarter: 3, month: 1 };
const PERIOD_LABEL = { year: 'a year', quarter: 'a quarter', month: 'a month' };

/**
 * One line of business: turn the goal into sales for the whole period and
 * explain what that production pays.
 * -> { sales, rows: [[label, value]...], payoutNote }
 */
function lineMath({ L, goal, goalType, period }) {
  const f = Object.fromEntries(Object.entries(L.facts).map(([k, x]) => [k, x.value]));
  const per = PERIOD_LABEL[period];
  if (L.kind === 'percent') {
    const perSale = f.caseSize * f.rate;
    const sales = goalType === 'production' ? Math.ceil(goal / f.caseSize) : Math.ceil(goal / perSale);
    const production = sales * f.caseSize;
    return { sales, rows: [
      [goalType === 'production' ? `${L.basis[0].toUpperCase()}${L.basis.slice(1)} goal` : 'Commission goal', `${money(goal)} ${per}`],
      [`Commission per sale (${pct(f.rate)} of a ${money(f.caseSize)} ${L.basis})`, money(perSale)],
      [`Sales needed ${per}`, sales],
      [`  that is ${money(production)} in ${L.basis}, paying`, `${money(sales * perSale)} first-year commission`],
    ] };
  }
  if (L.kind === 'flat') {
    const sales = Math.ceil(goal / f.firstYear);
    return { sales, rows: [
      ['First-year payout goal', `${money(goal)} ${per}`],
      ['First-year payout per enrollment', money(f.firstYear)],
      [`Enrollments needed ${per}`, sales],
      ['  renewals these clients add from year two', `${money(sales * f.renewalMonthly * 12)} a year (${money(f.renewalMonthly)} a month each)`],
    ] };
  }
  if (L.kind === 'aum') {
    const yearlyPay = f.feeRate * f.payout;
    const assets = goalType === 'production' ? goal : goal / yearlyPay;
    const sales = Math.ceil(assets / f.caseSize);
    const rows = [
      goalType === 'production' ? ['New assets goal', `${money(goal)} ${per}`] : ['Recurring income goal', `${money(goal)} a year, which takes ${money(assets)} in assets`],
      [`New accounts needed (at ${money(f.caseSize)} average)`, sales],
      [`What those assets pay you (${pct(f.feeRate)} fee x ${pct(f.payout)} payout)`, `${money(assets * yearlyPay)} a year, recurring while assets stay`],
      ['Break-even on fixed advisory costs', `${money(f.fixedCostsYear / yearlyPay)} in total assets (${money(f.fixedCostsYear)} a year in costs)`],
    ];
    return { sales, rows, payoutNote: 'Planning only: the agent still never discusses investments with leads. These conversations go to you personally.' };
  }
  // fee
  const sales = Math.ceil(goal / f.fee);
  return { sales, rows: [
    ['Planning fee goal', `${money(goal)} ${per}`],
    [`Plans needed (at ${money(f.fee)} each)`, sales],
  ] };
}

function buildIncomePlan({ brain, instruction, now = new Date() }) {
  const brand = brain.clientId;
  const parsed = parseIncomeGoal(instruction);
  if (!parsed.goal) {
    return { message: 'Tell me the goal, for example: "income plan $120,000", "income plan $2M annuity premium at 6%", "income plan $1M AUM next quarter", or "income plan $25,000 from new-to-Medicare". Add your own numbers in the same line: "average case $80,000, close rate 35%, show rate 75%".' };
  }
  const { line, period, goalType } = parsed;

  // Save what was typed: funnel rates under the line (or generally), line facts under the line.
  const toSave = {};
  for (const [k, v] of Object.entries(parsed.rates)) toSave[line ? `${line}:${k}` : k] = v;
  if (line) for (const [k, v] of Object.entries(parsed.facts)) if (LINES[line][k] !== undefined) toSave[`${line}:${k}`] = v;
  if (Object.keys(toSave).length) saveRates(brand, toSave);

  const { rates, measured } = resolveRates({ brain, typed: parsed.rates, line, now });
  const v = Object.fromEntries(Object.entries(rates).map(([k, r]) => [k, r.value]));
  const months = PERIOD_MONTHS[period];
  const now30 = lastThirtyDays(brand, now);
  const sections = [];
  let need;
  let headline;
  let assumedFields = Object.keys(rates).filter((k) => rates[k].assumed);
  let factRows = [];
  let lineNote = null;

  if (line) {
    const L = resolveLine({ brain, line, typedFacts: parsed.facts });
    const math = lineMath({ L, goal: parsed.goal, goalType, period });
    lineNote = math.payoutNote || null;
    const totals = workBackward({ ...v, sales: math.sales });
    const perMonth = workBackward({ ...v, sales: math.sales / months });
    need = { ...perMonth, sales: Math.ceil(math.sales / months) };
    sections.push({ title: `${L.label}: the goal`, rows: math.rows });
    if (months > 1) {
      sections.push({ title: `Working backward (whole ${period})`, rows: [
        ['Appointments held', totals.held], ['Appointments booked', totals.booked], ['Opted-in leads', totals.leads],
      ] });
    }
    factRows = Object.entries(L.facts).map(([k, x]) => [`${FIELD_LABELS[k]}: ${show(k, x.value)}`, x.source]);
    assumedFields = assumedFields.concat(Object.keys(L.facts).filter((k) => L.facts[k].assumed).map((k) => `${line}:${k}`));
    headline = `${L.label}: ${money(parsed.goal)} ${goalType === 'production' ? (line === 'aum' ? 'in new assets' : `in ${L.basis}`) : 'income'} ${PERIOD_LABEL[period]} takes ${math.sales} ${L.kind === 'flat' ? 'enrollments' : L.kind === 'aum' ? 'new accounts' : L.kind === 'fee' ? 'plans' : 'sales'}, about ${need.leads} opted-in leads a month.`;
  } else {
    const monthlyIncome = parsed.goal / months;
    need = workBackward({ monthlyIncome, ...v });
    sections.push({ title: 'Your goal', rows: [
      ['Income goal', `${money(monthlyIncome * 12)} a year`],
      ['  per month', money(monthlyIncome)],
    ] });
    headline = `To earn ${money(monthlyIncome * 12)} a year (${money(monthlyIncome)} a month), you need about ${need.leads} opted-in leads a month, which become ${need.booked} booked, ${need.held} held and ${need.sales} sales.`;
  }

  const perWeek = Math.ceil(need.leads / WEEKS_PER_MONTH);
  const perDay = Math.ceil(need.leads / WORKDAYS_PER_MONTH);
  sections.push({ title: 'Working backward (each month)', rows: [
    [line ? 'Sales needed' : `Sales needed (at ${money(v.avgCommission)} each)`, need.sales],
    [`Appointments held (at ${pct(v.closeRate)} close rate)`, need.held],
    [`Appointments booked (at ${pct(v.showRate)} show rate)`, need.booked],
    [`Opted-in leads (at ${pct(v.bookingRate)} booking rate)`, need.leads],
    ['  about this many a week', perWeek],
    ['  about this many a workday', perDay],
  ] });
  sections.push({ title: 'Where each number comes from', rows: factRows.concat(Object.keys(rates).map((k) => [
    `${FIELD_LABELS[k]}: ${show(k, v[k])}`, rates[k].source,
  ])).concat(measured.leads && /^your/.test(rates.bookingRate.source)
    ? [['  agent\'s measured booking rate, last 90 days', `${pct(measured.booked / measured.leads)} (${measured.booked} of ${measured.leads})`]]
    : []) });
  sections.push({ title: 'Where you are now (last 30 days)', rows: [
    ['Opted-in leads', now30.leads],
    ['Appointments booked', now30.booked],
    now30.leads >= need.leads
      ? ['Gap', 'none - last 30 days already met the lead target']
      : ['Gap', `${need.leads - now30.leads} more opted-in leads a month (about ${Math.ceil((need.leads - now30.leads) / WEEKS_PER_MONTH)} a week)`],
  ] });
  if (lineNote) sections.push({ title: 'Note', rows: [[lineNote, '']] });
  if (assumedFields.length) {
    sections.push({ title: 'Make it yours', rows: [
      [`${assumedFields.length} number${assumedFields.length === 1 ? ' is a placeholder' : 's are placeholders'}`, 'replace them with your own'],
      ['Type, for example', line ? (line === 'aum' ? `income plan ${money(parsed.goal)} AUM with average account $250,000, fee 1%, close rate 35%, show rate 75%` : `income plan ${money(parsed.goal)} from ${LINES[line].label.toLowerCase()}${LINES[line].kind === 'percent' ? ' with average case $80,000' : ''}, close rate 35%, show rate 75%`) : `income plan ${money(parsed.goal)} with average commission $1,800, close rate 35%, show rate 75%`],
      ['After 90 days', 'the booking rate comes from your own results automatically'],
    ] });
  }

  const summary = `${headline}${assumedFields.length ? ` ${assumedFields.length} of the numbers ${assumedFields.length === 1 ? 'is a placeholder' : 'are placeholders'}, so treat this as a sketch until you enter your own.` : ''}`;
  const clientText = [
    `Income plan: ${headline}`,
    ...sections.filter((s) => s.title !== 'Make it yours' && s.title !== 'Where each number comes from')
      .flatMap((s) => s.rows.map((r) => `- ${String(r[0]).trim()}${r[1] !== '' ? `: ${r[1]}` : ''}`)),
    assumedFields.length ? `Note: ${assumedFields.length} placeholder number${assumedFields.length === 1 ? '' : 's'} - not results.` : null,
  ].filter(Boolean).join('\n');

  db.logEvent({ agent: 'incomePlan', action: 'plan', detail: { brand, line, period, goalType, goal: parsed.goal, ...need, assumed: assumedFields }, dryRun: false });
  return { monthlyReport: true, incomePlan: true, month: 'Income plan', summary, sections, clientText, clientTextLabel: 'Copy-ready plan' };
}

module.exports = { buildIncomePlan, parseIncomeGoal, workBackward, lineMath, resolveLine, savedRates, saveRates, toAmount, LINES, STARTING };
