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
const { ensureCanSpamFooter, checkAdvisoryAutoSend } = require('./src/config/complianceGuard');
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
app.use(express.json({ limit: '1mb' }));
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
  });
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
function isAgentTag(tag) {
  return /^send-to-sales-agent$/i.test(tag) || /^sales-agent-/i.test(tag);
}

/**
 * Makes sure an email ends with the approved sign-off (voice.signOffName,
 * e.g. "Leon Grove, ChFC®, RICP® - Grove Financial Group"). If the model
 * already signed with the full name and both designations, it's left alone.
 * A bare closing line like "Leon", "Leon Grove" or "Dr. Grove" is replaced
 * rather than doubled up. SMS is left as-is (length matters there).
 */
function ensureSignOff(channel, messageText, brain) {
  const text = (messageText || '').trimEnd();
  const signOff = brain?.voice?.signOffName;
  if (channel !== 'Email' || !signOff || !text) return text;

  const [nameLine, ...rest] = signOff.split(' - ');
  const plain = (s) => s.replace(/[®™]/g, '').replace(/\s+/g, ' ').toLowerCase();
  if (plain(text).includes(plain(nameLine))) return text;

  const lines = text.split('\n');
  const last = (lines[lines.length - 1] || '').trim();
  if (/^[-–—\s]*(leon(\s+grove)?|dr\.?\s*(leon\s+)?grove)[,.\s]*$/i.test(last)) lines.pop();
  const body = lines.join('\n').trimEnd();
  const block = [nameLine.trim(), rest.join(' - ').trim()].filter(Boolean).join('\n');
  // Right under a closing like "Best," - otherwise a blank line first.
  return /,\s*$/.test(body) ? `${body}\n${block}` : `${body}\n\n${block}`;
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

function normalizeLead(body) {
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
  const tags = allTags.filter((t) => !isAgentTag(t)).join(', ');
  return {
    brand: pick(b.brand, cd.brand),
    firstName: pick(b.firstName, b.first_name, c.firstName, c.first_name, cd.firstName),
    lastName: pick(b.lastName, b.last_name, c.lastName, c.last_name, cd.lastName),
    email: pick(b.email, c.email, cd.email),
    phone: pick(b.phone, c.phone, cd.phone),
    state: pick(b.state, c.state, cd.state),
    source: pick(b.source, b.contact_source, cd.source, 'gohighlevel'),
    message: pick(b.message, cd.message),
    context: tags ? `Existing GoHighLevel tags on this contact: ${tags}` : undefined,
    ghlContactId: pick(b.contactId, b.contact_id, c.id, cd.contactId),
  };
}

app.post('/webhook/lead', checkToken, async (req, res) => {
  try {
    req.body = { ...req.body, ...normalizeLead(req.body) };
    if (isDuplicateRun(req.body.ghlContactId)) {
      console.log(`Skipped duplicate webhook for contact ${req.body.ghlContactId}`);
      return res.json({ skipped: 'duplicate', contactId: req.body.ghlContactId });
    }
    const brand = req.body.brand || req.query.brand;
    const brain = loadBrain(brand);
    const channel = req.body.phone ? 'SMS' : 'Email';

    const leadId = db.insertLead({
      brand: brain.clientId,
      firstName: req.body.firstName,
      lastName: req.body.lastName,
      email: req.body.email,
      phone: req.body.phone,
      source: req.body.source || 'website_form',
      state: req.body.state,
    });

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
    const ghlContactId = ghlResult.contact?.id || ghlResult.id || null;
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
        source: req.body.source,
        message: req.body.message,
        context: req.body.context,
        ghlContactId,
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
        req.body.ghlContactId ? null : 'sales-agent-inbound',
        { qualified: 'sales-agent-good-fit', needs_human: 'sales-agent-needs-you', disqualified: 'sales-agent-not-a-fit' }[verdict.verdict],
        verdict.suggestedTag === 'gwm-investment-inquiry' ? 'gwm-investment-inquiry' : null,
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

    let sendResult = null;
    if (verdict.verdict === 'qualified' && verdict.reply && ghlContactId && !req.body.phone && !req.body.email) {
      // Nothing to send a reply to - hand it over instead of drafting one.
      db.updateLeadStatus(leadId, 'needs_human');
      await ghl.addNote({ contactId: ghlContactId, body: 'SALES AGENT: good fit, but this contact has no phone or email on file - no reply drafted. Add one and re-tag send-to-sales-agent.' }).catch(() => {});
      await ghl.removeTags({ contactId: ghlContactId, tags: ['sales-agent-good-fit'] }).catch(() => {});
      await ghl.addTags({ contactId: ghlContactId, tags: ['sales-agent-needs-you'] }).catch(() => {});
      return res.json({ leadId, ghlResult, verdict, assessmentNote, tagResult, sendResult: { held: true, reason: 'no phone or email on file' } });
    }
    if (verdict.verdict === 'qualified' && verdict.reply && ghlContactId) {
      // Approved sign-off, then the CAN-SPAM mailing address on email -
      // both no-ops for SMS.
      const outboundMessage = finalizeOutbound(channel, verdict.reply, brain);
      // Same code-level backstop the follow-up and appointment agents use:
      // advisory or investment-topic wording is never auto-sent.
      const compliance = checkAdvisoryAutoSend(channel, outboundMessage, brain);
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
const REPLY_TAGS = {
  wants_to_book: 'sales-agent-wants-to-book',
  question: 'sales-agent-replied',
  not_now: 'sales-agent-not-now',
  not_interested: 'sales-agent-not-interested',
  needs_human: 'sales-agent-needs-you',
  opted_out: 'sales-agent-opted-out',
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
    const brain = loadBrain(req.body.brand || req.query.brand);
    const channel = /mail/i.test(r.rawChannel) ? 'Email' : /sms|text|phone/i.test(r.rawChannel) ? 'SMS' : (r.phone ? 'SMS' : 'Email');

    let lead = db.findLeadByGhlContactId(r.ghlContactId);
    if (!lead) {
      const id = db.insertLead({ brand: brain.clientId, firstName: r.firstName, lastName: r.lastName, email: r.email, phone: r.phone, source: 'reply', state: r.state, status: 'active', ghlContactId: r.ghlContactId });
      lead = db.getLead(id);
    }
    const leadInfo = { id: lead.id, firstName: lead.first_name || r.firstName, lastName: lead.last_name || r.lastName, ghlContactId: r.ghlContactId };

    // Someone who already opted out and writes again (often "START" or a
    // question) is for Dr. Grove to handle personally - never automated.
    const previouslyOptedOut = lead.status === 'opted_out';
    const result = previouslyOptedOut
      ? { intent: 'needs_human', reason: 'This contact opted out earlier and has written again - please handle personally.', reply: '' }
      : await handleReply({ brain, lead: leadInfo, replyText: r.replyText, channel, context: lastAgentMessage(lead.id) });

    if (REPLY_STATUS[result.intent]) db.updateLeadStatus(lead.id, REPLY_STATUS[result.intent]);
    else if (lead.status !== 'booked' && lead.status !== 'won') db.updateLeadStatus(lead.id, 'active');

    const label = REPLY_LABELS[result.intent] || result.intent;
    await ghl.addNote({
      contactId: r.ghlContactId,
      body: [
        `SALES AGENT - REPLY RECEIVED: ${label}`,
        `Their reply (${channel}): ${r.replyText || '(no text came through)'}`,
        result.reason ? `Why: ${result.reason}` : '',
        result.draftForDrGrove ? `\nDraft for you to review (NOT sent):\n${finalizeOutbound(channel, result.draftForDrGrove, brain)}` : '',
      ].filter(Boolean).join('\n'),
    }).catch((e) => console.error('Could not add reply note:', e.message));

    const tags = [REPLY_TAGS[result.intent], result.investmentTopic ? 'gwm-investment-inquiry' : null].filter(Boolean);
    await ghl.addTags({ contactId: r.ghlContactId, tags }).catch((e) => console.error('Could not tag reply:', e.message));

    let sendResult = null;
    if (result.reply) {
      const outbound = finalizeOutbound(channel, result.reply, brain);
      const compliance = checkAdvisoryAutoSend(channel, outbound, brain);
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

// --- Status sync ------------------------------------------------------------
// GHL tells the agent when something happened outside it, so it stops
// nurturing that person: POST /webhook/status?status=booked (an "Appointment
// Status: Booked" workflow), ?status=opted_out (a "Contact DND changed" or
// opt-out workflow), ?status=won (a won opportunity).
const STATUS_SYNC = {
  booked: { tag: 'sales-agent-booked', note: 'Appointment booked - automated follow-ups stopped.' },
  won: { tag: 'sales-agent-won', note: 'Marked won - automated follow-ups stopped.' },
  opted_out: { tag: 'sales-agent-opted-out', note: 'Opted out - no more automated messages.' },
};

app.post('/webhook/status', checkToken, async (req, res) => {
  try {
    const b = req.body || {};
    const cd = b.customData || b.custom_data || {};
    const status = String(req.query.status || cd.status || b.status || '').toLowerCase().replace(/[\s-]+/g, '_');
    const contactId = cd.contactId || cd.contact_id || b.contactId || b.contact_id || (b.contact && b.contact.id);
    if (!STATUS_SYNC[status]) return res.status(400).json({ error: `status must be one of: ${Object.keys(STATUS_SYNC).join(', ')}` });
    if (!contactId) return res.status(400).json({ error: 'no contact id in the status webhook' });

    const lead = db.findLeadByGhlContactId(contactId);
    if (!lead) return res.json({ found: false, contactId, note: 'Not a contact the agent has worked - nothing to update.' });

    db.updateLeadStatus(lead.id, status);
    db.logEvent({ leadId: lead.id, agent: 'statusSync', action: status, detail: { contactId }, dryRun: false });
    await ghl.addTags({ contactId, tags: [STATUS_SYNC[status].tag] }).catch((e) => console.error('Could not tag status:', e.message));
    await ghl.addNote({ contactId, body: `SALES AGENT: ${STATUS_SYNC[status].note}` }).catch((e) => console.error('Could not add status note:', e.message));
    res.json({ found: true, leadId: lead.id, status });
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
      const result = await handleBookingIntent({
        brain,
        lead: {
          id: req.body.leadId || null,
          firstName: req.body.firstName || req.body.contact?.firstName,
          ghlContactId: req.body.contactId || req.body.contact?.id,
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
      try { return { id, name: loadBrain(id).businessName || id }; } catch { return null; }
    })
    .filter(Boolean);
  res.json({ brains, defaultBrain: process.env.DEFAULT_BRAIN || 'grove-financial' });
});

app.get('/api/leads', requireAuth, (req, res) => {
  res.json({ leads: db.listLeads({ brand: req.query.brand, limit: 50 }) });
});

app.get('/api/activity', requireAuth, (req, res) => {
  res.json({ events: db.listEvents({ limit: 50 }), commands: db.listCommands({ limit: 20 }) });
});

app.listen(PORT, () => {
  console.log(`Grove Sales Agent listening on http://localhost:${PORT}`);
  console.log(`  Anthropic configured: ${Boolean(process.env.ANTHROPIC_API_KEY)}`);
  console.log(`  GHL configured: ${ghl.isConfigured()}`);

  if (process.env.AUTO_FOLLOWUP === 'true') {
    startScheduler();
  } else {
    console.log('  Auto follow-up scheduler: off (set AUTO_FOLLOWUP=true in .env to turn it on)');
  }
});
