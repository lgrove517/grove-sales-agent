require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const { SqliteSessionStore } = require('./src/store/sessionStore');

const { loadBrain } = require('./src/config/loadBrain');
const { qualifyLead } = require('./src/agents/leadQualifier');
const { handleBookingIntent } = require('./src/agents/appointmentSetter');
const { runCommand } = require('./src/agents/orchestrator');
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
function normalizeLead(body) {
  const b = body || {};
  const c = b.contact || {};
  const cd = b.customData || b.custom_data || {};
  const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && String(v).trim() !== '');
  // Internal routing tags (like the one that triggers this webhook) say
  // nothing about the person, so they're left out of the agent's context.
  const allTags = (Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(','))
    .map((t) => String(t).trim())
    .filter(Boolean);
  const tags = allTags.filter((t) => !/^send-to-sales-agent$/i.test(t)).join(', ');
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
    const brand = req.body.brand || req.query.brand;
    const brain = loadBrain(brand);

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
            verdict.draftForDrGrove ? `\nDraft for you to review (NOT sent):\n${verdict.draftForDrGrove}` : '',
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
        if (req.body.ghlContactId) {
          await ghl.removeTags({ contactId: ghlContactId, tags: ['send-to-sales-agent'] });
        }
      } catch (tagErr) {
        console.error('Could not update tags:', tagErr.message);
        tagResult = { error: tagErr.message };
      }
    }

    let sendResult = null;
    if (verdict.verdict === 'qualified' && verdict.reply && ghlContactId) {
      const channel = req.body.phone ? 'SMS' : 'Email';
      // CAN-SPAM requires a physical mailing address on commercial email -
      // no-op for SMS or if the brain has no mailingAddress on file.
      const outboundMessage = ensureCanSpamFooter(channel, verdict.reply, brain).messageText;
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
    const result = await runCommand({ brain, instruction });
    res.json(result);
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
