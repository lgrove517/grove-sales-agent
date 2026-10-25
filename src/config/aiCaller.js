/**
 * PHASE 2 AI CALLER: one short, friendly AI phone call to a new opted-in lead
 * to hear their tone and intent and offer a time with Dr. Grove.
 *
 * Who gets called - all of these must be true:
 *   - the client has "aiCaller": { "enabled": true } AND the approval flag
 *     (default AI_CALLER_APPROVED) is "true" on the host. The flag is set
 *     only after Dr. Grove has reviewed the call script.
 *   - documented call consent: a consent tag (default "ai-call-consent",
 *     added by the form workflow when the call-consent box is checked) or a
 *     call_consent = yes field. Text or email opt-in alone is NOT enough.
 *   - a phone number, and not a Medicare lead (Medicare calls are recorded
 *     and need the CMS disclaimer in the first minute - Dr. Grove makes those).
 *
 * When: only inside the calling window in the LEAD's time zone (default
 * 10 AM - 6 PM, Monday - Friday, the same window GoHighLevel's Voice AI
 * enforces). A form filled at 2 AM is scheduled for the next window. At most
 * `dailyCap` calls per 24 hours (start small), `maxAttempts` tries per lead,
 * one try per day, and never for a lead older than `maxLeadAgeDays`.
 *
 * How: the agent adds the trigger tag (default "sales-agent-ai-call"); a GHL
 * workflow on that tag runs the "Voice AI Outbound Call" action with the
 * reviewed script, then posts the result to /webhook/call.
 */
const { MEDICARE_INTEREST_PATTERN } = require('./complianceGuard');

const DEFAULTS = {
  approvalFlag: 'AI_CALLER_APPROVED',
  consentTags: ['ai-call-consent', 'call-opt-in'],
  callWindow: { startHour: 10, endHour: 18, days: [1, 2, 3, 4, 5] },
  // Lead's state unknown: a window that is inside 10-6 for Eastern through Pacific.
  unknownStateWindow: { timezone: 'America/Chicago', startHour: 12, endHour: 17 },
  firstCallDelayMinutes: 5,
  retryAfterHours: 20,
  dailyCap: 5,
  maxAttempts: 2,
  maxLeadAgeDays: 3,
  excludeMedicare: true,
  triggerTag: 'sales-agent-ai-call',
};

// State -> time zone for the calling window. Where a state spans two zones,
// the EASTERN-most zone is used, so a call is never early for anyone there.
const STATE_TZ = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago', CA: 'America/Los_Angeles',
  CO: 'America/Denver', CT: 'America/New_York', DE: 'America/New_York', DC: 'America/New_York', FL: 'America/New_York',
  GA: 'America/New_York', HI: 'Pacific/Honolulu', ID: 'America/Denver', IL: 'America/Chicago', IN: 'America/New_York',
  IA: 'America/Chicago', KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago', ME: 'America/New_York',
  MD: 'America/New_York', MA: 'America/New_York', MI: 'America/New_York', MN: 'America/Chicago', MS: 'America/Chicago',
  MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago', NV: 'America/Los_Angeles', NH: 'America/New_York',
  NJ: 'America/New_York', NM: 'America/Denver', NY: 'America/New_York', NC: 'America/New_York', ND: 'America/Chicago',
  OH: 'America/New_York', OK: 'America/Chicago', OR: 'America/Denver', PA: 'America/New_York', RI: 'America/New_York',
  SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/New_York', TX: 'America/Chicago', UT: 'America/Denver',
  VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles', WV: 'America/New_York', WI: 'America/Chicago',
  WY: 'America/Denver',
};
const STATE_NAMES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};

/** The client's AI caller settings, or null when it's off or not yet approved. */
function callerConfig(brain, { ignoreApproval = false } = {}) {
  const cfg = brain && brain.aiCaller;
  if (!cfg || !cfg.enabled) return null;
  const merged = {
    ...DEFAULTS,
    ...cfg,
    callWindow: { ...DEFAULTS.callWindow, ...(cfg.callWindow || {}) },
    unknownStateWindow: { ...DEFAULTS.unknownStateWindow, ...(cfg.unknownStateWindow || {}) },
  };
  merged.approved = String(process.env[merged.approvalFlag] || '').toLowerCase() === 'true';
  if (!merged.approved && !ignoreApproval) return null;
  return merged;
}

const truthy = (v) => /^(1|true|yes|y|checked|on)$/i.test(String(v == null ? '' : v).trim());

/** Documented consent to be called (tag or field). */
function hasCallConsent({ tags = [], customData = {} } = {}, cfg) {
  const want = (cfg || DEFAULTS).consentTags.map((t) => t.toLowerCase());
  const cd = customData || {};
  return tags.some((t) => want.includes(String(t).toLowerCase())) || truthy(cd.call_consent ?? cd.callConsent ?? cd.ai_call_consent);
}

function stateCode(state) {
  const s = String(state || '').trim();
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return STATE_NAMES[s.toLowerCase()] || null;
}

/** { timezone, startHour, endHour, days } for this lead's calls. */
function windowFor(cfg, state) {
  const tz = STATE_TZ[stateCode(state)];
  if (tz) return { timezone: tz, startHour: cfg.callWindow.startHour, endHour: cfg.callWindow.endHour, days: cfg.callWindow.days };
  return { ...cfg.unknownStateWindow, days: cfg.callWindow.days };
}

function localParts(date, timezone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(date).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour), minute: Number(p.minute), day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}

function inWindow(win, date) {
  const { hour, day } = localParts(date, win.timezone);
  return win.days.includes(day) && hour >= win.startHour && hour < win.endHour;
}

/**
 * The first moment at or after `from` that is inside the lead's calling
 * window (checked in 5-minute steps, up to 9 days ahead). A form at 2 AM
 * gives the start of the next window, e.g. 10:00 AM their time.
 */
function nextCallTime(win, from) {
  const step = 5 * 60 * 1000;
  let t = new Date(Math.ceil(from.getTime() / step) * step);
  for (let i = 0; i < 9 * 24 * 12; i++) {
    if (inWindow(win, t)) return t;
    t = new Date(t.getTime() + step);
  }
  return null;
}

/** Medicare leads are called by Dr. Grove personally (CMS recording and disclaimer rules). */
function isMedicareLead({ interest, source, tags = [] } = {}) {
  return MEDICARE_INTEREST_PATTERN.test(`${interest || ''} ${source || ''} ${tags.join(' ')}`);
}

/** The call script, with the lead's details filled in - for review and for the GHL agent. */
function renderScript(brain, lead = {}) {
  const sc = (brain.aiCaller && brain.aiCaller.script) || {};
  const fill = (s) => String(s || '')
    .replace(/\{firstName\}/g, lead.firstName || 'there')
    .replace(/\{interest\}/g, lead.interest || 'your financial picture')
    .replace(/\{businessName\}/g, brain.businessName || '')
    .replace(/\{phone\}/g, brain.phone || '');
  const list = (arr) => (arr || []).map((x, i) => `${i + 1}. ${fill(x)}`).join('\n');
  return [
    `AI CALL SCRIPT - ${brain.businessName}${sc.version ? ` (version ${sc.version})` : ''}`,
    '',
    'OPENING (say all of this first):',
    fill(sc.opening),
    '',
    'IF IT IS NOT A GOOD TIME:',
    fill(sc.notGoodTime),
    '',
    'QUESTIONS (one at a time; listen, keep it conversational):',
    list(sc.questions),
    '',
    'OFFER THE APPOINTMENT:',
    fill(sc.offer),
    '',
    'CLOSING:',
    fill(sc.closing),
    '',
    'RULES - NEVER BREAK THESE:',
    list(sc.rules),
    '',
    'VOICEMAIL:',
    fill(sc.voicemail),
  ].join('\n');
}

module.exports = {
  DEFAULTS,
  STATE_TZ,
  callerConfig,
  hasCallConsent,
  stateCode,
  windowFor,
  inWindow,
  nextCallTime,
  isMedicareLead,
  renderScript,
};
