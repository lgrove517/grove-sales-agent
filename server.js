require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const { SqliteSessionStore } = require('./src/store/sessionStore');

const { loadBrain } = require('./src/config/loadBrain');
const { qualifyLead } = require('./src/agents/leadQualifier');
const { handleBookingIntent } = require('./src/agents/appointmentSetter');
const { handleReply } = require('./src/agents/replyHandler');
const { runCommand } = require('./src/agents/orchestrator');
const { buildBriefing, recommend } = require('./src/agents/briefing');
const ghl = require('./src/integrations/ghl');
const db = require('./src/store/db');
const { startScheduler } = require('./src/scheduler/followUpScheduler');
const { ensureCanSpamFooter, checkAdvisoryAutoSend, checkSeparation, financialGuardsOn } = require('./src/config/complianceGuard');
const packages = require('./src/config/packages');
const { ensureSignOff } = require('./src/config/signOff');
const seq = require('./src/config/bookingSequence');
const { sendSequenceTouch } = require('./src/agents/sequenceTouch');
const aiCaller = require('./src/agents/aiCallerAgent');
const {
  verifyCredentials,
  requireAuth,
  isLockedOut,
  recordFailedAttempt,
  clearAttempts,
} = require('./src/auth/auth');

const app = express();

// Needed when deployed behind a reverse proxy (Render/Railway/etc.) so
// secure cookies and req.ip (used for login rate-limiting) work correctly.
if (process.env.TRUST_PROXY || process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

// Refuse to start in production with the placeholder session secret - it
// would let anyone forge a login cookie.
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET must be set in production. Exiting.');
  process.exit(1);
}

app.use(cors());
// Keep the exact bytes Stripe sent: its signature check needs the raw body.
app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { if (req.originalUrl.startsWith('/webhook/stripe')) req.rawBody = buf.toString('utf8'); } }));
app.use(express.urlencoded({ extended: false })); // for the login form POST

// Run each request "inside" the client brain it's for (body or ?brand=), so
// every GoHighLevel call uses that client's own account. An unknown brand
// falls through to the route, which reports the missing brain as before.
app.use((req, res, next) => {
  let brain = null;
  try { brain = loadBrain((req.body && req.body.brand) || req.query.brand); } catch { /* route handles it */ }
  ghl.runWithBrain(brain, next);
});

app.use(
  session({
    store: new SqliteSessionStore(),
    secret: process.env.SESSION_SECRET || 'change-me-in-.env-SESSION_SECRET',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 12 * 60 * 60 * 1000, // 12 hours
    },
  })
);

// index: false so express.static never auto-serves the protected
// index.html for GET / - that route is handled explicitly below, behind
// requireAuth. login.html itself is still reachable as a plain static file.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const PORT = process.env.PORT || 3000;

function checkToken(req, res, next) {
  const required = process.env.WEBHOOK_TOKEN;
  if (!required) {
    // Fail closed: once the app is reachable from the internet (ngrok or a
    // host), an unset token would let anyone inject leads.
    return res.status(503).json({ error: 'WEBHOOK_TOKEN is not set in .env - webhooks are disabled until it is.' });
  }
  const provided = req.query.token || req.headers['x-agent-token'];
  if (provided !== required) {
    return res.status(401).json({ error: 'invalid or missing webhook token' });
  }
  next();
}

// --- Auth: login / logout ---------------------------------------------
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/login', (req, res) => {
  const ip = req.ip;
  if (isLockedOut(ip)) {
    return res.redirect('/login.html?error=locked');
  }
  const { username, password } = req.body;
  const result = verifyCredentials(username, password);
  if (!result.ok) {
    recordFailedAttempt(ip);
    if (!process.env.AUTH_USERNAME || !process.env.AUTH_PASSWORD_HASH) {
      console.error(
        'Login attempted but AUTH_USERNAME/AUTH_PASSWORD_HASH are not set in .env - see README for setup.'
      );
    }
    return res.redirect('/login.html?error=1');
  }
  clearAttempts(ip);
  req.session.authenticated = true;
  req.session.username = username;
  res.redirect('/');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login.html'));
});

// --- Health check ------------------------------------------------------
app.get('/health', (req, res) => {
  const brand = req.query.brand;
  res.json({
    ok: true,
    anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
    ghlConfigured: ghl.isConfigured(),
    ghlSendMode: ghl.sendMode(),
    defaultBrain: process.env.DEFAULT_BRAIN || 'grove-financial',
    brand: brand || process.env.DEFAULT_BRAIN || 'grove-financial',
    clientName: (() => { try { return loadBrain(brand).businessName; } catch { return null; } })(),
    // Compliance-gated workflows and whether each is switched on.
    workflows: (() => { try { return loadBrain(brand).workflowStatus || []; } catch { return []; } })(),
    // The client's Webtech package and which agent features it turns on.
    package: (() => { try { return packages.packageFor(loadBrain(brand)); } catch { return null; } })(),
    features: (() => { try { return packages.featureStatus(loadBrain(brand)); } catch { return []; } })(),
    // Sales-demo client (sample data, nothing is ever sent).
    demo: (() => { try { return Boolean(loadBrain(brand).demo); } catch { return false; } })(),
  });
});

// --- Booking-sequence tracking (public, no login) ------------------------
// /go/<code>: counts the click on a sequence message's link, then forwards
// to the scheduling page. /o/<code>.gif: a 1x1 image in sequence emails that
// counts the open (approximate - some mail apps load images automatically,
// some block them).
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const LINK_SCANNER = /bot|crawl|spider|preview|scanner|proofpoint|mimecast|barracuda|safelinks|urldefense|facebookexternalhit|slackbot|whatsapp|curl|wget|python-requests/i;

app.get('/go/:code', (req, res) => {
  const touch = db.getTouch(req.params.code);
  if (!touch) {
    let fallback = '/';
    try { fallback = loadBrain().website || '/'; } catch { /* keep "/" */ }
    return res.redirect(302, fallback);
  }
  // Email security scanners "click" links before people do; don't count them.
  if (!LINK_SCANNER.test(req.get('user-agent') || '')) {
    db.recordTouchEvent(touch.code, 'click');
    db.logEvent({ leadId: touch.lead_id, agent: 'tracking', action: 'click', detail: { step: touch.step, channel: touch.channel }, dryRun: false });
  }
  res.redirect(302, touch.url);
});

app.get('/o/:file', (req, res) => {
  const code = String(req.params.file).replace(/\.gif$/i, '');
  const touch = db.getTouch(code);
  if (touch && !LINK_SCANNER.test(req.get('user-agent') || '')) db.recordTouchEvent(code, 'open');
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' });
  res.send(PIXEL);
});

// --- Website form / generic lead webhook --------------------------------
// Point your website form handler or GHL "Custom Webhook" workflow action
// at POST /webhook/lead. Expects: { brand?, firstName, lastName, email,
// phone, state, source, message }
/**
 * GoHighLevel's workflow Webhook action sends contact fields in snake_case
 * (first_name, contact_id, ...); a website form may send camelCase. Accept
 * both, so the agents always see a name, email and the existing GHL contact.
 */
// The tags the agent itself applies. Each client brain can rename them
// (brain.agentTags - Village Covenant Foundation uses vcf-* tags); these
// are the defaults Grove Financial Group uses.
const DEFAULT_TAGS = {
  inbound: 'sales-agent-inbound',
  good_fit: 'sales-agent-good-fit',
  needs_you: 'sales-agent-needs-you',
  not_a_fit: 'sales-agent-not-a-fit',
  handoff: 'sales-agent-needs-you',
  plannedGift: 'sales-agent-needs-you',
  wants_to_book: 'sales-agent-wants-to-book',
  question: 'sales-agent-replied',
  not_now: 'sales-agent-not-now',
  not_interested: 'sales-agent-not-interested',
  opted_out: 'sales-agent-opted-out',
  booked: 'sales-agent-booked',
  booked_by_agent: 'sales-agent-booked-by-agent',
  booked_by_you: 'sales-agent-booked-by-you',
  won: 'sales-agent-won',
  no_opt_in: 'sales-agent-no-opt-in',
};
const TAG_ALIASES = { qualified: 'good_fit', needs_human: 'needs_you', disqualified: 'not_a_fit' };

function tagFor(brain, key) {
  const k = TAG_ALIASES[key] || key;
  return (brain && brain.agentTags && (brain.agentTags[key] || brain.agentTags[k])) || DEFAULT_TAGS[k] || null;
}

function isAgentTag(tag, brain) {
  if (/^send-to-sales-agent$/i.test(tag) || /^sales-agent-/i.test(tag)) return true;
  const own = Object.values((brain && brain.agentTags) || {}).map((t) => String(t).toLowerCase());
  return own.includes(String(tag).toLowerCase());
}

/**
 * A contact the agent has already worked keeps the brain it was worked
 * under. Grove Financial Group and its agency share one GoHighLevel
 * account, so one "Customer Replied" workflow serves both: an agency
 * recruit's reply is answered by the agency brain even if the webhook
 * names grove-financial (or nothing). Falls back to the requested brain
 * when the contact is new or its brain isn't served by this deployment.
 */
function brainForContact(contactId, requested) {
  const known = contactId ? db.findLeadByGhlContactId(contactId) : null;
  if (known && known.brand) {
    try { return loadBrain(known.brand); } catch { /* not served here */ }
  }
  return loadBrain(requested);
}

/** Every outbound draft passes both checks: advisory content and the client's separation rule. */
function checkOutbound(channel, text, brain) {
  const advisory = checkAdvisoryAutoSend(channel, text, brain);
  if (advisory.blocked) return advisory;
  return checkSeparation(text, brain);
}

/** Sign-off first, then the CAN-SPAM address, so the address sits at the very end. */
function finalizeOutbound(channel, messageText, brain) {
  return ensureCanSpamFooter(channel, ensureSignOff(channel, messageText, brain), brain).messageText;
}

// GoHighLevel can fire the same webhook twice (a retry while the first run
// is still waiting on the AI, or two workflows on one tag). Ignore a repeat
// for the same contact within this window so it doesn't get two notes.
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;
const recentRuns = new Map();
function isDuplicateRun(contactId) {
  if (!contactId) return false;
  const now = Date.now();
  for (const [id, t] of recentRuns) if (now - t > DUPLICATE_WINDOW_MS) recentRuns.delete(id);
  if (recentRuns.has(contactId)) return true;
  recentRuns.set(contactId, now);
  return false;
}

function normalizeLead(body, brain) {
  const b = body || {};
  const c = b.contact || {};
  const cd = b.customData || b.custom_data || {};
  const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && String(v).trim() !== '');
  // Internal routing tags (the one that triggers this webhook) and the
  // agent's own sales-agent-* tags from earlier runs say nothing about the
  // person, so they're left out of the agent's context - otherwise a past
  // verdict would bias the new assessment.
  const allTags = (Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(','))
    .map((t) => String(t).trim())
    .filter(Boolean);
  const tags = allTags.filter((t) => !isAgentTag(t, brain)).join(', ');
  return {
    brand: pick(b.brand, cd.brand),
    firstName: pick(b.firstName, b.first_name, c.firstName, c.first_name, cd.firstName),
    lastName: pick(b.lastName, b.last_name, c.lastName, c.last_name, cd.lastName),
    email: pick(b.email, c.email, cd.email),
    phone: pick(b.phone, c.phone, cd.phone),
    state: pick(b.state, c.state, cd.state),
    postalCode: pick(b.postalCode, b.postal_code, c.postalCode, c.postal_code, cd.postalCode, cd.postal_code, b.zip, cd.zip),
    source: pick(b.source, b.contact_source, cd.source, 'gohighlevel'),
    message: pick(b.message, cd.message),
    context: tags ? `Existing GoHighLevel tags on this contact: ${tags}` : undefined,
    ghlContactId: pick(b.contactId, b.contact_id, c.id, cd.contactId),
  };
}

app.post('/webhook/lead', checkToken, async (req, res) => {
  try {
    const brainForLead = loadBrain(normalizeLead(req.body).brand || req.query.brand);
    const rawBody = req.body || {};
    req.body = { ...req.body, ...normalizeLead(req.body, brainForLead) };
    if (isDuplicateRun(req.body.ghlContactId)) {
      console.log(`Skipped duplicate webhook for contact ${req.body.ghlContactId}`);
      return res.json({ skipped: 'duplicate', contactId: req.body.ghlContactId });
    }
    const brand = req.body.brand || req.query.brand;
    const brain = loadBrain(brand);
    const channel = req.body.phone ? 'SMS' : 'Email';

    // Package check: below Premium the lead is recorded (it counts in the
    // monthly report) but never assessed, drafted or followed up.
    if (!packages.hasFeature(brain, 'leadAgent')) {
      const reason = packages.lockedMessage(brain, 'leadAgent');
      const leadId = db.insertLead({
        brand: brain.clientId, firstName: req.body.firstName, lastName: req.body.lastName, email: req.body.email,
        phone: req.body.phone, source: req.body.source || 'website_form', state: req.body.state, postalCode: req.body.postalCode,
        status: 'logged', ghlContactId: req.body.ghlContactId,
      });
      db.logEvent({ leadId, agent: 'package', action: 'lead_logged', detail: { reason }, dryRun: false });
      if (req.body.ghlContactId) {
        await ghl.removeTags({ contactId: req.body.ghlContactId, tags: ['send-to-sales-agent'] }).catch(() => {});
      }
      return res.json({ leadId, skipped: 'package', reason });
    }

    const leadId = db.insertLead({
      brand: brain.clientId,
      firstName: req.body.firstName,
      lastName: req.body.lastName,
      email: req.body.email,
      phone: req.body.phone,
      source: req.body.source || 'website_form',
      state: req.body.state,
      postalCode: req.body.postalCode,
    });

    // Phase 1 booking sequence: did this person ask to hear from us?
    const seqCfg = seq.sequenceConfig(brain);
    const optIn = seqCfg
      ? seq.checkOptIn({ source: req.body.source, tags: seq.tagsFrom(rawBody), customData: rawBody.customData || rawBody.custom_data }, seqCfg)
      : null;
    if (seqCfg) {
      db.updateLeadSequence(leadId, { optInVia: optIn.via, smsConsent: optIn.smsConsent, interest: req.body.message || null });
    }

    // Push the lead into GHL right away (create/update contact) so it's
    // never siloed in this app's own database.
    // A lead sent BY GoHighLevel already exists there - use its contact id
    // instead of upserting (which could create a duplicate).
    const ghlResult = req.body.ghlContactId
      ? { existing: true, id: req.body.ghlContactId }
      : await ghl.upsertContact({
      firstName: req.body.firstName,
      lastName: req.body.lastName,
      email: req.body.email,
      phone: req.body.phone,
      source: req.body.source || 'website_form',
      // No tags here: on an existing contact GHL's upsert can REPLACE its
      // tags (Medicare, CD...). The inbound tag is added separately below.
    });
    // In DRY_RUN (no GHL credentials, e.g. the sales-demo client) every
    // contact gets the same fake id - keeping it would make each new lead
    // "supersede" the one before it, so it's dropped.
    const ghlContactId = ghlResult.dryRun ? null : (ghlResult.contact?.id || ghlResult.id || null);
    if (ghlContactId) {
      db.setLeadGhlContactId(leadId, ghlContactId);
      db.supersedeOlderLeads(ghlContactId, leadId);
    }

    const verdict = await qualifyLead({
      brain,
      lead: {
        id: leadId,
        firstName: req.body.firstName,
        lastName: req.body.lastName,
        email: req.body.email,
        phone: req.body.phone,
        state: req.body.state,
        postalCode: req.body.postalCode,
        source: req.body.source,
        message: req.body.message,
        context: req.body.context,
        ghlContactId,
        writingNote: seqCfg && optIn.optedIn
          ? `Write the reply as an ${seq.channelFor(seqCfg.firstTouchChannel, { email: req.body.email, phone: req.body.phone, sms_consent: optIn.smsConsent }) === 'SMS' ? 'SMS text (1-2 sentences)' : 'email (2-4 sentences)'}. Do not include any link, URL, sign-off or opt-out line - the scheduling link and sign-off are added automatically after your message.`
          : null,
      },
    });

    // Keep lead.status in sync with the qualifier's verdict so the auto
    // follow-up scheduler knows to leave disqualified/needs-human leads
    // alone instead of nurturing them forever.
    if (verdict.verdict === 'disqualified') {
      db.updateLeadStatus(leadId, 'disqualified');
    } else if (verdict.verdict === 'needs_human') {
      db.updateLeadStatus(leadId, 'needs_human');
    } else {
      db.updateLeadStatus(leadId, 'active');
    }

    // Always leave the agent's decision on the contact in GoHighLevel, so
    // Dr. Grove can see what happened (and why) without opening this app.
    let assessmentNote = null;
    if (ghlContactId) {
      const label = {
        qualified: 'Good fit - first reply drafted',
        needs_human: 'Needs you - no reply drafted',
        disqualified: 'Not a fit - no reply drafted',
      }[verdict.verdict] || verdict.verdict;
      try {
        assessmentNote = await ghl.addNote({
          contactId: ghlContactId,
          body: [
            `SALES AGENT ASSESSMENT: ${label}`,
            verdict.reason ? `Why: ${verdict.reason}` : '',
            verdict.suggestedTag ? `Suggested tag: ${verdict.suggestedTag}` : '',
            verdict.draftForDrGrove ? `\nDraft for you to review (NOT sent, ${channel}):\n${finalizeOutbound(channel, verdict.draftForDrGrove, brain)}` : '',
          ].filter(Boolean).join('\n'),
        });
      } catch (noteErr) {
        console.error('Could not add assessment note:', noteErr.message);
      }
    }

    // Tag the contact in GoHighLevel so Dr. Grove can build lists and alerts
    // on the agent's decisions. Only this fixed set of tags is applied - the
    // model's free-form suggestedTag stays in the note, so GHL doesn't fill up
    // with one-off tags. Then clear the trigger tag, so adding it again
    // later re-runs the agent on that contact.
    let tagResult = null;
    if (ghlContactId) {
      const tags = [
        req.body.ghlContactId ? null : tagFor(brain, 'inbound'),
        tagFor(brain, verdict.verdict),
        verdict.handoffTagKey ? tagFor(brain, verdict.handoffTagKey) : null,
        financialGuardsOn(brain) && verdict.suggestedTag === 'gwm-investment-inquiry' ? 'gwm-investment-inquiry' : null,
      ].filter(Boolean);
      try {
        tagResult = await ghl.addTags({ contactId: ghlContactId, tags });
      } catch (tagErr) {
        console.error('Could not update tags:', tagErr.message);
        tagResult = { error: tagErr.message };
      }
      // Separate from the add above, so the trigger tag is cleared even if
      // adding the verdict tags failed.
      if (req.body.ghlContactId) {
        try {
          await ghl.removeTags({ contactId: ghlContactId, tags: ['send-to-sales-agent'] });
        } catch (rmErr) {
          console.error('Could not remove send-to-sales-agent tag:', rmErr.message);
          tagResult = { ...(tagResult || {}), triggerTagRemoveError: rmErr.message };
        }
      }
    }

    // Phase 1: no opt-in on file = nobody is contacted automatically.
    if (seqCfg && !optIn.optedIn && ghlContactId) {
      db.updateLeadSequence(leadId, { seqStatus: 'not_opted_in' });
      db.logEvent({ leadId, agent: 'sequence', action: 'not_opted_in', detail: { source: req.body.source, blocked: optIn.blocked || null }, dryRun: false });
      await ghl.addNote({
        contactId: ghlContactId,
        body: `SALES AGENT: not contacted - ${optIn.blocked || `no opt-in on file (source: ${req.body.source || 'unknown'})`}.\nThe booking sequence only goes to people who asked to hear from you (a form, a referral or RetireFlo). If this person did, add the "opt-in" tag and re-tag send-to-sales-agent.`,
      }).catch((e) => console.error('Could not add opt-in note:', e.message));
      await ghl.addTags({ contactId: ghlContactId, tags: [tagFor(brain, 'no_opt_in')] }).catch(() => {});
      return res.json({ leadId, ghlResult, verdict, assessmentNote, tagResult, sendResult: { held: true, reason: 'no opt-in on file' } });
    }

    if (seqCfg && verdict.verdict === 'qualified' && verdict.reply && ghlContactId) {
      const firstChannel = seq.channelFor(seqCfg.firstTouchChannel, { email: req.body.email, phone: req.body.phone, sms_consent: optIn.smsConsent });
      if (!firstChannel) {
        db.updateLeadStatus(leadId, 'needs_human');
        db.updateLeadSequence(leadId, { seqStatus: 'held' });
        await ghl.addNote({ contactId: ghlContactId, body: 'SALES AGENT: good fit, but there is no email and no text consent on file - booking sequence not started. Add one and re-tag send-to-sales-agent.' }).catch(() => {});
        await ghl.addTags({ contactId: ghlContactId, tags: [tagFor(brain, 'needs_you')] }).catch(() => {});
        return res.json({ leadId, ghlResult, verdict, assessmentNote, tagResult, sendResult: { held: true, reason: 'no email or text consent on file' } });
      }
      const touch = await sendSequenceTouch({
        brain, cfg: seqCfg, lead: { id: leadId, ghlContactId }, step: 0, channel: firstChannel,
        text: verdict.reply, subject: `Thanks for reaching out to ${brain.businessName}`,
      });
      if (touch.held) {
        db.updateLeadStatus(leadId, 'needs_human');
        db.updateLeadSequence(leadId, { seqStatus: 'held' });
        db.logEvent({ leadId, agent: 'leadQualifier', action: 'blocked_compliance', detail: { reason: touch.reason }, dryRun: false });
        await ghl.addNote({ contactId: ghlContactId, body: `SALES AGENT: first message held, not sent\nWhy: ${touch.reason}\n\n${touch.message}` }).catch(() => {});
        return res.json({ leadId, ghlResult, verdict, assessmentNote, tagResult, sendResult: { held: true, reason: touch.reason } });
      }
      db.updateLeadSequence(leadId, { seqStatus: 'active', seqStep: 0, seqStartedAt: db.toDbTime(new Date()) });
      db.logEvent({ leadId, agent: 'sequence', action: 'started', detail: { channel: firstChannel, optInVia: optIn.via, mode: touch.mode, link: touch.link }, dryRun: touch.mode === 'dry_run' });
      // Phase 2: an AI call too, if they gave call consent (next allowed time in their time zone).
      const call = packages.hasFeature(brain, 'leadAgent')
        ? await aiCaller.scheduleFirstCall({
          brain, leadId, ghlContactId, phone: req.body.phone, state: req.body.state, interest: req.body.message,
          source: req.body.source, tags: seq.tagsFrom(rawBody), customData: rawBody.customData || rawBody.custom_data,
        }).catch((e) => ({ scheduled: false, reason: e.message }))
        : null;
      return res.json({ leadId, ghlResult, verdict, assessmentNote, tagResult, sendResult: touch.sendResult, sequence: { started: true, channel: firstChannel, link: touch.link }, call });
    }

    let sendResult = null;
    if (verdict.verdict === 'qualified' && verdict.reply && ghlContactId && !req.body.phone && !req.body.email) {
      // Nothing to send a reply to - hand it over instead of drafting one.
      db.updateLeadStatus(leadId, 'needs_human');
      await ghl.addNote({ contactId: ghlContactId, body: 'SALES AGENT: good fit, but this contact has no phone or email on file - no reply drafted. Add one and re-tag send-to-sales-agent.' }).catch(() => {});
      if (tagFor(brain, 'good_fit') !== tagFor(brain, 'needs_you')) {
        await ghl.removeTags({ contactId: ghlContactId, tags: [tagFor(brain, 'good_fit')] }).catch(() => {});
      }
      await ghl.addTags({ contactId: ghlContactId, tags: [tagFor(brain, 'needs_you')] }).catch(() => {});
      return res.json({ leadId, ghlResult, verdict, assessmentNote, tagResult, sendResult: { held: true, reason: 'no phone or email on file' } });
    }
    if (verdict.verdict === 'qualified' && verdict.reply && ghlContactId) {
      // Approved sign-off, then the CAN-SPAM mailing address on email -
      // both no-ops for SMS.
      const outboundMessage = finalizeOutbound(channel, verdict.reply, brain);
      // Same code-level backstop the follow-up and appointment agents use:
      // advisory or investment-topic wording is never auto-sent.
      const compliance = checkOutbound(channel, outboundMessage, brain);
      if (compliance.blocked) {
        db.logEvent({ leadId, agent: 'leadQualifier', action: 'blocked_compliance', detail: { reason: compliance.reason }, dryRun: false });
        db.updateLeadStatus(leadId, 'needs_human');
        await ghl.addNote({ contactId: ghlContactId, body: `SALES AGENT: reply held, not sent\nWhy: ${compliance.reason}\n\n${outboundMessage}` }).catch(() => {});
        return res.json({ leadId, ghlResult, verdict, assessmentNote, tagResult, sendResult: { held: true, reason: compliance.reason } });
      }
      sendResult = await ghl.sendMessage({
        contactId: ghlContactId,
        type: channel,
        message: outboundMessage,
        subject: `Thanks for reaching out to ${brain.businessName}`,
      });
    }

    res.json({ leadId, ghlResult, verdict, assessmentNote, tagResult, sendResult });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Lead replied ----------------------------------------------------------
// Point a GHL workflow with the "Customer Replied" trigger at
// POST /webhook/reply. The agent reads the reply, tags the contact with what
// the person wants, and drafts the next message (a note in review mode).
// Opt-outs are honored in code and never get a reply.
function normalizeReply(body) {
  const b = body || {};
  const c = b.contact || {};
  const cd = b.customData || b.custom_data || {};
  const m = b.message && typeof b.message === 'object' ? b.message : {};
  const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && String(v).trim() !== '');
  const rawChannel = String(pick(cd.reply_channel, cd.channel, m.type, b.messageType, b.message_type) || '');
  return {
    ghlContactId: pick(cd.contactId, cd.contact_id, b.contactId, b.contact_id, c.id),
    replyText: String(pick(cd.reply_text, cd.message, m.body, typeof b.message === 'string' ? b.message : null, b.body, b.reply) || ''),
    rawChannel,
    firstName: pick(b.firstName, b.first_name, c.firstName, c.first_name),
    lastName: pick(b.lastName, b.last_name, c.lastName, c.last_name),
    email: pick(b.email, c.email),
    phone: pick(b.phone, c.phone),
    state: pick(b.state, c.state),
    postalCode: pick(b.postalCode, b.postal_code, c.postalCode, c.postal_code, cd.postalCode, cd.postal_code),
  };
}

const REPLY_LABELS = {
  wants_to_book: 'Wants to book - reply drafted',
  question: 'Asked a question - reply drafted',
  not_now: 'Interested, not ready - reply drafted',
  not_interested: 'Not interested - closing reply drafted, follow-ups stopped',
  needs_human: 'Needs you - no reply drafted',
  opted_out: 'Asked to stop - no reply, all automated messages stopped',
};
const REPLY_STATUS = { not_interested: 'disqualified', needs_human: 'needs_human', opted_out: 'opted_out' };

function lastAgentMessage(leadId) {
  for (const agent of ['replyHandler', 'leadQualifier', 'followUp']) {
    const ev = db.latestEvent(leadId, agent);
    if (!ev) continue;
    let d = ev.detail;
    try { d = typeof d === 'string' ? JSON.parse(d) : d; } catch { continue; }
    const text = d && (d.reply || d.draftForDrGrove || d.message || (d.parsed && d.parsed.message));
    if (text) return text;
  }
  return null;
}

app.post('/webhook/reply', checkToken, async (req, res) => {
  try {
    const r = normalizeReply(req.body);
    if (!r.ghlContactId) {
      console.error('Reply webhook without a contact id. Keys received:', Object.keys(req.body || {}).join(', '));
      return res.status(400).json({ error: 'no contact id in the reply webhook' });
    }
    if (isDuplicateRun(`reply:${r.ghlContactId}:${r.replyText}`)) {
      return res.json({ skipped: 'duplicate', contactId: r.ghlContactId });
    }
    if (!r.replyText) {
      console.warn('Reply webhook with no message text. Keys received:', Object.keys(req.body || {}).join(', '));
    }
    const brain = brainForContact(r.ghlContactId, req.body.brand || req.query.brand);
    if (!packages.hasFeature(brain, 'replyAgent')) {
      return res.json({ skipped: 'package', reason: packages.lockedMessage(brain, 'replyAgent'), contactId: r.ghlContactId });
    }
    const channel = /mail/i.test(r.rawChannel) ? 'Email' : /sms|text|phone/i.test(r.rawChannel) ? 'SMS' : (r.phone ? 'SMS' : 'Email');

    let lead = db.findLeadByGhlContactId(r.ghlContactId);
    if (!lead) {
      const id = db.insertLead({ brand: brain.clientId, firstName: r.firstName, lastName: r.lastName, email: r.email, phone: r.phone, source: 'reply', state: r.state, postalCode: r.postalCode, status: 'active', ghlContactId: r.ghlContactId });
      lead = db.getLead(id);
    }
    const leadInfo = { id: lead.id, firstName: lead.first_name || r.firstName, lastName: lead.last_name || r.lastName, ghlContactId: r.ghlContactId, postalCode: r.postalCode || lead.postal_code };
    if (r.postalCode && !lead.postal_code) db.setLeadPostalCode(lead.id, r.postalCode);

    // Someone who already opted out and writes again (often "START" or a
    // question) is for Dr. Grove to handle personally - never automated.
    const previouslyOptedOut = lead.status === 'opted_out';
    const result = previouslyOptedOut
      ? { intent: 'needs_human', reason: 'This contact opted out earlier and has written again - please handle personally.', reply: '' }
      : await handleReply({ brain, lead: leadInfo, replyText: r.replyText, channel, context: lastAgentMessage(lead.id) });

    if (REPLY_STATUS[result.intent]) db.updateLeadStatus(lead.id, REPLY_STATUS[result.intent]);
    else if (lead.status !== 'booked' && lead.status !== 'won') db.updateLeadStatus(lead.id, 'active');

    // Any reply ends the timed booking sequence and cancels a scheduled AI
    // call - from here it's a conversation.
    aiCaller.cancelCall(lead, 'they replied');
    const stoppedSequence = lead.seq_status === 'active';
    if (stoppedSequence) {
      db.updateLeadSequence(lead.id, { seqStatus: result.intent === 'opted_out' ? 'stopped_opted_out' : 'stopped_replied' });
      db.logEvent({ leadId: lead.id, agent: 'sequence', action: result.intent === 'opted_out' ? 'stopped_opted_out' : 'stopped_replied', detail: { channel }, dryRun: false });
    }

    const label = REPLY_LABELS[result.intent] || result.intent;
    await ghl.addNote({
      contactId: r.ghlContactId,
      body: [
        `SALES AGENT - REPLY RECEIVED: ${label}`,
        `Their reply (${channel}): ${r.replyText || '(no text came through)'}`,
        result.reason ? `Why: ${result.reason}` : '',
        stoppedSequence ? 'Booking sequence stopped - they replied.' : '',
        result.draftForDrGrove ? `\nDraft for you to review (NOT sent):\n${finalizeOutbound(channel, result.draftForDrGrove, brain)}` : '',
      ].filter(Boolean).join('\n'),
    }).catch((e) => console.error('Could not add reply note:', e.message));

    const tags = [
      tagFor(brain, result.intent),
      result.handoffTagKey ? tagFor(brain, result.handoffTagKey) : null,
      result.investmentTopic && financialGuardsOn(brain) ? 'gwm-investment-inquiry' : null,
    ].filter((t, i, a) => t && a.indexOf(t) === i);
    await ghl.addTags({ contactId: r.ghlContactId, tags }).catch((e) => console.error('Could not tag reply:', e.message));

    let sendResult = null;
    if (result.reply) {
      const outbound = finalizeOutbound(channel, result.reply, brain);
      const compliance = checkOutbound(channel, outbound, brain);
      if (compliance.blocked) {
        db.updateLeadStatus(lead.id, 'needs_human');
        await ghl.addNote({ contactId: r.ghlContactId, body: `SALES AGENT: reply held, not sent\nWhy: ${compliance.reason}\n\n${outbound}` }).catch(() => {});
        sendResult = { held: true, reason: compliance.reason };
      } else {
        sendResult = await ghl.sendMessage({ contactId: r.ghlContactId, type: channel, message: outbound, subject: `Re: ${brain.businessName}` });
      }
    }

    res.json({ leadId: lead.id, intent: result.intent, reason: result.reason, tags, sendResult });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Stripe billing (Webtech Design) ------------------------------------------
// Stripe -> POST /webhook/stripe. Authenticated by Stripe's own signature
// (STRIPE_WEBHOOK_SECRET), not WEBHOOK_TOKEN. Tags the paying client's
// contact in the billing brain's GHL account (STRIPE_BRAIN, default
// webtech-design); GHL workflows on those tags send the emails.
const stripeHook = require('./src/integrations/stripeWebhook');

/** Client brains on this deployment whose billingEmail matches (case-insensitive). */
function clientsByBillingEmail(email) {
  const want = String(email || '').trim().toLowerCase();
  if (!want) return [];
  const fs = require('fs');
  const { CONFIG_DIR } = require('./src/config/loadBrain');
  return fs.readdirSync(CONFIG_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('brain.example'))
    .map((f) => { try { return loadBrain(f.replace(/\.json$/, '')); } catch { return null; } })
    .filter((b) => b && [].concat(b.billingEmail || []).some((e) => String(e).trim().toLowerCase() === want));
}

app.post('/webhook/stripe', async (req, res) => {
  const check = stripeHook.verifySignature(req.rawBody, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  if (!check.ok) {
    console.error('Stripe webhook rejected:', check.reason);
    return res.status(400).json({ error: check.reason });
  }
  const event = req.body || {};
  if (stripeHook.alreadyHandled(event.id)) return res.json({ received: true, duplicate: true });

  let brain;
  try { brain = loadBrain(process.env.STRIPE_BRAIN || 'webtech-design'); } catch (e) {
    console.error('Stripe webhook: billing brain not available:', e.message);
    return res.status(500).json({ error: e.message });
  }

  try {
    const action = stripeHook.eventToAction(event, brain);
    if (action.ignore) {
      if (action.needsAttention) console.warn('Stripe webhook:', action.ignore);
      stripeHook.markHandled(event.id);
      return res.json({ received: true, ignored: action.ignore });
    }
    if (!action.email) {
      console.warn(`Stripe webhook: ${event.type} ${event.id} has no customer email - nothing to tag.`);
      stripeHook.markHandled(event.id);
      return res.json({ received: true, ignored: 'no customer email' });
    }

    // Package sync: the client whose brain lists this billing email gets the
    // package they just bought, upgraded to, or lost on cancellation.
    if (action.packageChange) {
      const clients = clientsByBillingEmail(action.email);
      const label = packages.LEVELS[action.packageChange].label;
      clients.forEach((c) => packages.setClientPackage(c.clientId, action.packageChange, `stripe ${event.type}`));
      action.note = [action.note, clients.length
        ? `AI Sales Agent package for ${clients.map((c) => c.businessName || c.clientId).join(', ')} is now: ${label}.`
        : `AI Sales Agent package NOT changed: no client brain lists ${action.email} as its billing email. Add "billingEmail" to their config file, or set the package by hand.`,
      ].filter(Boolean).join('\n');
    }

    const result = await ghl.runWithBrain(brain, async () => {
      const { firstName, lastName } = stripeHook.splitName(action.name);
      const up = await ghl.upsertContact({ firstName, lastName, email: action.email, phone: action.phone || undefined, source: 'Stripe' });
      const contactId = up.contact?.id || up.id;
      if (!contactId) throw new Error('GHL did not return a contact id for ' + action.email);
      if (action.removeTags?.length) await ghl.removeTags({ contactId, tags: action.removeTags }).catch((e) => console.error('Stripe webhook: could not remove tags:', e.message));
      if (action.addTags?.length) await ghl.addTags({ contactId, tags: action.addTags });
      if (action.note) await ghl.addNote({ contactId, body: action.note }).catch((e) => console.error('Stripe webhook: could not add note:', e.message));
      return { contactId, dryRun: Boolean(up.dryRun) };
    });

    stripeHook.markHandled(event.id);
    console.log(`Stripe webhook: ${event.type} -> ${action.email} tagged [${(action.addTags || []).join(', ')}]${result.dryRun ? ' (DRY_RUN - Webtech GHL keys not set)' : ''}`);
    res.json({ received: true, type: event.type, ...result, tagged: action.addTags });
  } catch (err) {
    // A 500 makes Stripe retry later (it was not marked handled).
    console.error('Stripe webhook failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Status sync ------------------------------------------------------------
// GHL tells the agent when something happened outside it, so it stops
// nurturing that person: POST /webhook/status?status=booked (an "Appointment
// Status: Booked" workflow), ?status=opted_out (a "Contact DND changed" or
// opt-out workflow), ?status=won (a won opportunity).
const STATUS_SYNC = {
  booked: { note: 'Appointment booked - automated follow-ups stopped.' },
  won: { note: 'Marked won - automated follow-ups stopped.' },
  opted_out: { note: 'Opted out - no more automated messages.' },
};

app.post('/webhook/status', checkToken, async (req, res) => {
  try {
    const b = req.body || {};
    const cd = b.customData || b.custom_data || {};
    const status = String(req.query.status || cd.status || b.status || '').toLowerCase().replace(/[\s-]+/g, '_');
    const contactId = cd.contactId || cd.contact_id || b.contactId || b.contact_id || (b.contact && b.contact.id);
    if (!STATUS_SYNC[status]) return res.status(400).json({ error: `status must be one of: ${Object.keys(STATUS_SYNC).join(', ')}` });
    if (!contactId) return res.status(400).json({ error: 'no contact id in the status webhook' });

    const statusBrain = brainForContact(contactId, b.brand || req.query.brand);
    if (!packages.hasFeature(statusBrain, 'statusSync')) {
      return res.json({ skipped: 'package', reason: packages.lockedMessage(statusBrain, 'statusSync'), contactId });
    }
    const lead = db.findLeadByGhlContactId(contactId);
    if (!lead) return res.json({ found: false, contactId, note: 'Not a contact the agent has worked - nothing to update.' });

    db.updateLeadStatus(lead.id, status);
    db.logEvent({ leadId: lead.id, agent: 'statusSync', action: status, detail: { contactId }, dryRun: false });
    // Booking sequence: stop it, and give the booking to the message that earned it.
    if (lead.seq_status === 'active') db.updateLeadSequence(lead.id, { seqStatus: `stopped_${status}` });
    aiCaller.cancelCall(lead, status);
    const statusTags = [tagFor(statusBrain, status)];
    if (status === 'booked') {
      db.updateLeadSequence(lead.id, { bookedAt: db.toDbTime(new Date()) });
      db.creditBooking(lead.id);
      // Who earned it: the agent, if a message it actually sent or a call it
      // completed came first; otherwise the owner (seminar, own call, referral).
      const byAgent = db.agentReachedLead(lead.id) || lead.call_status === 'completed';
      statusTags.push(tagFor(statusBrain, byAgent ? 'booked_by_agent' : 'booked_by_you'));
      db.logEvent({ leadId: lead.id, agent: 'statusSync', action: byAgent ? 'booked_by_agent' : 'booked_by_you', detail: { contactId }, dryRun: false });
    }
    await ghl.addTags({ contactId, tags: statusTags }).catch((e) => console.error('Could not tag status:', e.message));
    await ghl.addNote({ contactId, body: `SALES AGENT: ${STATUS_SYNC[status].note}` }).catch((e) => console.error('Could not add status note:', e.message));
    res.json({ found: true, leadId: lead.id, status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- AI call result (Phase 2) ----------------------------------------------
// A GHL workflow posts here when a Voice AI call ends: contact id plus
// whatever GHL offers for the call (status/outcome, summary, transcript,
// recording). The agent reads it for tone and intent, tags and notes the
// contact, retries a no-answer once, and stops everything on an opt-out.
app.post('/webhook/call', checkToken, async (req, res) => {
  try {
    const b = req.body || {};
    const cd = b.customData || b.custom_data || {};
    const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && String(v).trim() !== '');
    const contactId = pick(cd.contactId, cd.contact_id, b.contactId, b.contact_id, b.contact && b.contact.id);
    if (!contactId) return res.status(400).json({ error: 'no contact id in the call webhook' });
    if (isDuplicateRun(`call:${contactId}:${pick(cd.call_id, b.call_id, cd.call_summary, cd.summary, '') || ''}`)) {
      return res.json({ skipped: 'duplicate', contactId });
    }
    const brain = brainForContact(contactId, b.brand || req.query.brand);
    const lead = db.findLeadByGhlContactId(contactId);
    if (!lead) return res.json({ found: false, contactId, note: 'Not a contact the agent has worked - nothing to update.' });
    const result = await aiCaller.handleCallResult({
      brain,
      lead,
      callStatus: pick(cd.call_status, cd.call_outcome, cd.status, cd.outcome, b.call_status, b.status),
      summary: pick(cd.call_summary, cd.summary, b.call_summary, b.summary),
      transcript: pick(cd.call_transcript, cd.transcript, b.call_transcript, b.transcript),
      recordingUrl: pick(cd.recording_url, cd.recording, b.recording_url),
    });
    res.json({ leadId: lead.id, outcome: result.outcome, intent: result.intent, tone: result.tone, tags: result.tags, retryAt: result.retryAt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- GHL event webhook ---------------------------------------------------
// Point a GHL "Webhook" workflow action here for events like
// "appointment requested" or "replied to conversation".
app.post('/webhook/ghl', checkToken, async (req, res) => {
  try {
    const brand = req.body.brand || req.query.brand;
    const brain = loadBrain(brand);
    const eventType = req.body.type || req.body.event || 'unknown';

    if (eventType.toLowerCase().includes('appointment') || eventType.toLowerCase().includes('booking')) {
      if (!packages.hasFeature(brain, 'appointmentSetter')) {
        return res.json({ skipped: 'package', reason: packages.lockedMessage(brain, 'appointmentSetter') });
      }
      const result = await handleBookingIntent({
        brain,
        lead: {
          id: req.body.leadId || null,
          firstName: req.body.firstName || req.body.contact?.firstName,
          ghlContactId: req.body.contactId || req.body.contact?.id,
          postalCode: req.body.postalCode || req.body.postal_code || req.body.contact?.postalCode || req.body.contact?.postal_code,
        },
        context: JSON.stringify(req.body),
      });
      return res.json({ handled: 'booking', result });
    }

    db.logEvent({ agent: 'ghlWebhook', action: eventType, detail: req.body, dryRun: false });
    res.json({ handled: 'logged', eventType });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Command center --------------------------------------------------------
// The "type one line, get a day of work" interface. POST { brand?, instruction }
// Session-protected (called from the logged-in browser UI), not token-protected
// like the machine-to-machine webhooks above.
app.post('/command', requireAuth, async (req, res) => {
  try {
    const { instruction, brand } = req.body;
    if (!instruction || !instruction.trim()) {
      return res.status(400).json({ error: 'instruction is required' });
    }
    const brain = loadBrain(brand);
    const result = await runCommand({ brain, instruction, since: briefingSince(req, brain.clientId) });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- "Since your last visit" ------------------------------------------------
// The first time a signed-in session asks about a client, remember when the
// user was last here (from the DB) and stamp "now" as the new last visit. The
// session keeps the old time, so refreshing the page or typing "what did I
// miss?" shows the same briefing instead of an empty one.
function briefingSince(req, brand) {
  req.session.briefingSince = req.session.briefingSince || {};
  if (!req.session.briefingSince[brand]) {
    const username = req.session.username || '';
    const last = db.getLastVisit(username, brand);
    req.session.briefingSince[brand] = last || db.toDbTime(Date.now() - 7 * 86400000);
    req.session.firstVisit = req.session.firstVisit || {};
    req.session.firstVisit[brand] = !last;
    db.setLastVisit(username, brand);
  }
  return req.session.briefingSince[brand];
}

app.get('/api/briefing', requireAuth, (req, res) => {
  try {
    const brain = loadBrain(req.query.brand);
    if (!packages.hasFeature(brain, 'briefing')) {
      return res.status(403).json({ locked: true, error: packages.lockedMessage(brain, 'briefing') });
    }
    const since = briefingSince(req, brain.clientId);
    const briefing = buildBriefing({ brain, since });
    briefing.firstVisit = Boolean(req.session.firstVisit && req.session.firstVisit[brain.clientId]);
    res.json(briefing);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/recommendations', requireAuth, async (req, res) => {
  try {
    const brain = loadBrain(req.body.brand);
    if (!packages.hasFeature(brain, 'recommendations')) {
      return res.json({ intent: 'recommendations', response: { locked: true, message: packages.lockedMessage(brain, 'recommendations') } });
    }
    const result = await recommend({ brain, focus: req.body.focus || '' });
    db.logCommand({ brand: brain.clientId, instruction: '(button) Get recommendations', response: result });
    res.json({ intent: 'recommendations', dryRun: result.dryRun, response: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Read-only helpers for the UI ------------------------------------------
// The client brains on file (config/*.json, minus the template), for the
// command center's client switcher.
app.get('/api/brains', requireAuth, (req, res) => {
  const fs = require('fs');
  const { CONFIG_DIR } = require('./src/config/loadBrain');
  const brains = fs.readdirSync(CONFIG_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('brain.example'))
    .map((f) => {
      const id = f.replace(/\.json$/, '');
      try {
        const b = loadBrain(id);
        return { id, name: b.businessName || id, package: packages.packageFor(b).label };
      } catch { return null; }
    })
    .filter(Boolean);
  res.json({ brains, defaultBrain: process.env.DEFAULT_BRAIN || 'grove-financial' });
});

// Set a client's package by hand from the dashboard (Stripe sets it too).
app.post('/api/package', requireAuth, (req, res) => {
  try {
    const brain = loadBrain(req.body.brand);
    if (!packages.setClientPackage(brain.clientId, req.body.package, `set by ${req.session.username || 'dashboard'}`)) {
      return res.status(400).json({ error: `package must be one of: ${Object.keys(packages.LEVELS).join(', ')}` });
    }
    db.logEvent({ agent: 'package', action: 'set', detail: { brand: brain.clientId, package: req.body.package }, dryRun: false });
    res.json({ brand: brain.clientId, package: packages.packageFor(brain) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ad / lead spend for cost per booked appointment: { brand, month: "2026-11", source: "facebook", amount: 250 }
app.post('/api/spend', requireAuth, (req, res) => {
  try {
    const brain = loadBrain(req.body.brand);
    const month = String(req.body.month || '');
    const amount = Number(req.body.amount);
    const source = String(req.body.source || '').trim();
    if (!/^20\d\d-(0[1-9]|1[0-2])$/.test(month) || !source || !(amount >= 0)) {
      return res.status(400).json({ error: 'Send month as YYYY-MM, a source name, and an amount of 0 or more.' });
    }
    db.setSpend({ brand: brain.clientId, month, source, amount });
    res.json({ ok: true, brand: brain.clientId, month, spend: db.spendFor(brain.clientId, month) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/leads', requireAuth, (req, res) => {
  res.json({ leads: db.listLeads({ brand: req.query.brand, limit: 50 }) });
});

// Mark a lead as a test (or undo it) from the Recent leads list. Test leads
// are kept in the database but drop out of the list, briefings, reports and
// the follow-up scheduler.
app.post('/api/leads/:id/test', requireAuth, (req, res) => {
  try {
    const brain = loadBrain(req.body.brand);
    const isTest = req.body.test !== false;
    const changed = db.setLeadTest(Number(req.params.id), brain.clientId, isTest);
    if (!changed) return res.status(404).json({ error: 'Lead not found for this client.' });
    db.logEvent({ leadId: Number(req.params.id), agent: 'dashboard', action: isTest ? 'marked_test' : 'unmarked_test', detail: { by: req.session.username || 'dashboard' }, dryRun: false });
    res.json({ ok: true, changed, test: isTest });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Sales demo tools (only for brains marked "demo": true) --------------
const demoData = require('./src/demo/demoData');

// Put the demo client back to its sample leads, so each presentation starts clean.
app.post('/api/demo/reset', requireAuth, (req, res) => {
  try {
    const brand = req.body.brand || req.query.brand;
    const seeded = demoData.resetDemo(brand);
    res.json({ ok: true, seeded });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Send one inquiry through the real lead pipeline, live, for the demo client.
// Uses a ready-made inquiry, or the message the prospect types in.
app.post('/api/demo/lead', requireAuth, async (req, res) => {
  try {
    const brand = req.body.brand || req.query.brand;
    demoData.demoBrain(brand);
    const sample = demoData.liveInquiry(brand);
    const typed = String(req.body.message || '').trim();
    const lead = {
      brand,
      firstName: typed ? (String(req.body.firstName || '').trim() || 'Demo') : sample.firstName,
      lastName: typed ? (String(req.body.lastName || '').trim() || 'Prospect') : sample.lastName,
      email: `live-demo-${Date.now()}@example.com`,
      phone: '',
      state: 'AL',
      source: 'live_demo',
      message: typed || sample.message,
    };
    const r = await fetch(`http://127.0.0.1:${PORT}/webhook/lead?brand=${encodeURIComponent(brand)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-token': process.env.WEBHOOK_TOKEN || '' },
      body: JSON.stringify(lead),
    });
    const data = await r.json().catch(() => ({}));
    res.status(r.ok ? 200 : r.status).json({ ...data, inquiry: { name: `${lead.firstName} ${lead.lastName}`, message: lead.message } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/activity', requireAuth, (req, res) => {
  res.json({ events: db.listEvents({ limit: 50 }), commands: db.listCommands({ limit: 20 }) });
});

app.listen(PORT, () => {
  console.log(`Grove Sales Agent listening on http://localhost:${PORT}`);
  // Load sample leads for any sales-demo client that has none yet.
  try {
    const fs = require('fs');
    const { CONFIG_DIR } = require('./src/config/loadBrain');
    const ids = fs.readdirSync(CONFIG_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('brain.example')).map((f) => f.replace(/\.json$/, ''));
    const seeded = demoData.seedEmptyDemos(ids);
    if (seeded.length) console.log(`  Demo sample leads loaded for: ${seeded.join(', ')}`);
  } catch (err) {
    console.error('  Could not load demo sample leads:', err.message);
  }
  console.log(`  Anthropic configured: ${Boolean(process.env.ANTHROPIC_API_KEY)}`);
  console.log(`  GHL configured: ${ghl.isConfigured()}`);

  if (process.env.AUTO_FOLLOWUP === 'true') {
    startScheduler();
  } else {
    console.log('  Auto follow-up scheduler: off (set AUTO_FOLLOWUP=true in .env to turn it on)');
  }
});
