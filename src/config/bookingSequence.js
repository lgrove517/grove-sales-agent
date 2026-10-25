/**
 * PHASE 1 BOOKING SEQUENCE: email and text ONLY to people who asked to hear
 * from the business (a form, a referral, a RetireFlo survey, or a contact
 * tagged as opted in). Each message carries ONE link - the scheduling
 * landing page - and the sequence stops the moment the person books,
 * replies or opts out.
 *
 *   Day 0  first touch (sent by the lead qualifier when the lead arrives)
 *   Day 1, 3, 7  follow-ups (sent by the scheduler sweep)
 *
 * Turned on per client in its brain file:
 *   "bookingSequence": {
 *     "enabled": true,
 *     "landingPageUrl": "https://...",          // default: bookingLink
 *     "steps": [{ "day": 1, "channel": "Email" }, { "day": 3, "channel": "SMS" }, { "day": 7, "channel": "Email" }],
 *     "optInSourcePatterns": ["form", "referral", "retireflo"],
 *     "optInTags": ["opt-in", "referral"],
 *     "smsConsentTags": ["sms-opt-in"],
 *     "sendWindow": { "timezone": "America/Chicago", "startHour": 9, "endHour": 19, "days": [1,2,3,4,5,6] }
 *   }
 * Anything left out uses the defaults below.
 */
const crypto = require('crypto');

const DEFAULTS = {
  steps: [
    { day: 1, channel: 'Email' },
    { day: 3, channel: 'SMS' },
    { day: 7, channel: 'Email' },
  ],
  firstTouchChannel: 'Email',
  optInSourcePatterns: ['form', 'survey', 'retireflo', 'referral', 'seminar', 'landing'],
  optInTags: ['opt-in', 'requested-info', 'referral', 'retireflo'],
  smsConsentTags: ['sms-opt-in'],
  // Never contact these, whatever else is true.
  blockTags: ['dnd', 'do-not-contact', 'no-contact'],
  sendWindow: { timezone: 'America/Chicago', startHour: 9, endHour: 19, days: [1, 2, 3, 4, 5, 6] },
  utm: { source: 'sales-agent', campaign: 'booking-sequence' },
  linkLeadIn: 'Pick a time that works for you:',
};

/** The client's sequence settings, or null when the sequence is off. */
function sequenceConfig(brain) {
  const cfg = brain && brain.bookingSequence;
  if (!cfg || !cfg.enabled) return null;
  const landingPageUrl = cfg.landingPageUrl || brain.bookingLink;
  if (!landingPageUrl) return null; // nothing to send people to
  return {
    ...DEFAULTS,
    ...cfg,
    landingPageUrl,
    steps: Array.isArray(cfg.steps) && cfg.steps.length ? cfg.steps : DEFAULTS.steps,
    sendWindow: { ...DEFAULTS.sendWindow, ...(cfg.sendWindow || {}) },
    utm: { ...DEFAULTS.utm, ...(cfg.utm || {}) },
  };
}

const lc = (s) => String(s || '').trim().toLowerCase();
const truthy = (v) => /^(1|true|yes|y|checked|on)$/i.test(String(v == null ? '' : v).trim());

/** Tags from a GHL webhook body (array or comma list), lower-cased. */
function tagsFrom(body) {
  const b = body || {};
  const raw = Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(',');
  return raw.map(lc).filter(Boolean);
}

/**
 * Did this person ask to hear from us? Looks at the contact source, tags and
 * an explicit opt-in field. A list import, a manually added contact or an
 * old CRM contact is NOT opted in unless it carries an opt-in tag.
 * Returns { optedIn, via, smsConsent, blocked }.
 */
function checkOptIn({ source, tags = [], customData = {} } = {}, cfg) {
  const c = cfg || DEFAULTS;
  const t = tags.map(lc);
  const cd = customData || {};
  const blockTag = t.find((x) => c.blockTags.map(lc).includes(x));
  if (blockTag) return { optedIn: false, via: null, smsConsent: false, blocked: `contact is tagged "${blockTag}"` };

  const smsConsent = t.some((x) => c.smsConsentTags.map(lc).includes(x)) || truthy(cd.sms_consent ?? cd.smsConsent ?? cd.sms_opt_in);

  if (truthy(cd.opt_in ?? cd.optIn ?? cd.opted_in)) return { optedIn: true, via: 'opt-in field', smsConsent };
  const tag = t.find((x) => c.optInTags.map(lc).includes(x));
  if (tag) return { optedIn: true, via: `tag: ${tag}`, smsConsent };
  const src = lc(source);
  const pattern = c.optInSourcePatterns.map(lc).find((p) => p && src.includes(p));
  if (pattern) return { optedIn: true, via: `source: ${source}`, smsConsent };
  return { optedIn: false, via: null, smsConsent };
}

/** Short random code for tracking links (not guessable, URL-safe). */
function newCode() {
  return crypto.randomBytes(6).toString('base64url');
}

/** The landing page URL with UTM tags, so GHL and analytics see where the visit came from. */
function landingUrlWithUtm(cfg, { step, channel }) {
  const u = new URL(cfg.landingPageUrl);
  u.searchParams.set('utm_source', cfg.utm.source);
  u.searchParams.set('utm_medium', channel === 'SMS' ? 'sms' : 'email');
  u.searchParams.set('utm_campaign', cfg.utm.campaign);
  u.searchParams.set('utm_content', `day${step === 0 ? 0 : cfg.steps[step - 1]?.day ?? step}`);
  return u.toString();
}

/**
 * The link that goes in the message. With PUBLIC_BASE_URL set, a short
 * tracked link on this server that counts the click, then forwards to the
 * landing page. Without it, the landing page itself (with UTM tags), and
 * clicks are only visible in GoHighLevel/analytics.
 */
function linkFor(cfg, { step, channel, code }) {
  const destination = landingUrlWithUtm(cfg, { step, channel });
  const base = String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  return { destination, link: base ? `${base}/go/${code}` : destination, tracked: Boolean(base) };
}

const URL_RE = /\bhttps?:\/\/[^\s<>()"']+/gi;

/**
 * One link per message: takes out any link the AI wrote (the prompt asks it
 * not to) and puts the scheduling link on its own line at the end of the
 * message body.
 */
function applySingleLink(text, link, leadIn = DEFAULTS.linkLeadIn) {
  const cleaned = String(text || '')
    .replace(URL_RE, '')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/(here|below|link)\s*:\s*$/gim, '') // "Book here:" left hanging by a removed link
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return `${cleaned}\n\n${leadIn} ${link}`;
}

/** Texts must tell people how to stop them. */
function ensureSmsOptOut(text) {
  return /\bstop\b/i.test(text) ? text : `${text}\nReply STOP to opt out.`;
}

/** Emails get a plain way out, honored by the reply handler. */
function ensureEmailOptOut(text) {
  return /unsubscribe|\bstop\b/i.test(text) ? text : `${text}\n\nPrefer not to hear from us? Reply "unsubscribe" and we won't email again.`;
}

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Email body as HTML (line breaks kept, the link clickable) plus the open pixel when tracking is on. */
function emailHtml(text, { link, code }) {
  const body = escapeHtml(text)
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n')
    .replace(escapeHtml(link), `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>`);
  const base = String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const pixel = base && code ? `\n<img src="${base}/o/${code}.gif" width="1" height="1" alt="" style="display:block;border:0;">` : '';
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222;">\n${body}${pixel}\n</div>`;
}

/** Is it a reasonable time to send right now, in the client's time zone? */
function inSendWindow(cfg, now = new Date()) {
  const w = cfg.sendWindow;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: w.timezone, hour: 'numeric', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(now).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return w.days.includes(day) && hour >= w.startHour && hour < w.endHour;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** When the lead's next follow-up step is due (null when the sequence is used up). */
function nextDueAt(cfg, lead) {
  const step = cfg.steps[lead.seq_step || 0];
  if (!step || !lead.seq_started_at) return null;
  const started = new Date(`${String(lead.seq_started_at).replace(' ', 'T')}${/Z|[+-]\d\d:?\d\d$/.test(lead.seq_started_at) ? '' : 'Z'}`);
  return new Date(started.getTime() + step.day * DAY_MS);
}

/**
 * Which channel a step actually uses for this lead: texts only with a phone
 * AND text consent, otherwise email; null if neither works.
 */
function channelFor(wanted, lead) {
  const canEmail = Boolean(lead.email);
  const canText = Boolean(lead.phone) && Boolean(lead.sms_consent ?? lead.smsConsent);
  if (wanted === 'SMS' && canText) return 'SMS';
  if (canEmail) return 'Email';
  if (canText) return 'SMS';
  return null;
}

/** How a touch was handled, from ghl.sendMessage's result. */
function modeFrom(sendResult) {
  if (!sendResult) return 'not_sent';
  if (sendResult.reviewMode) return 'review';
  if (sendResult.dryRun) return 'dry_run';
  return 'live';
}

module.exports = {
  DEFAULTS,
  sequenceConfig,
  tagsFrom,
  checkOptIn,
  newCode,
  landingUrlWithUtm,
  linkFor,
  applySingleLink,
  ensureSmsOptOut,
  ensureEmailOptOut,
  emailHtml,
  inSendWindow,
  nextDueAt,
  channelFor,
  modeFrom,
};
