const fetch = require('node-fetch');
const { AsyncLocalStorage } = require('async_hooks');

const API_VERSION = '2021-07-28';

/**
 * One GoHighLevel account per client. Each request (and each scheduler
 * sweep) runs "inside" the brain it is working for; every GHL call below
 * reads that brain's credentials.
 *
 * - A brain with "ghl": { "apiKeyEnv": "WEBTECH_GHL_API_KEY",
 *   "locationIdEnv": "WEBTECH_GHL_LOCATION_ID" } uses ONLY those variables.
 *   If they're not set, that client runs in DRY_RUN - it never falls back
 *   to another client's account, so one client's leads can't land in
 *   another client's GoHighLevel.
 * - A brain without a "ghl" block (Grove Financial Group today) uses the
 *   original GHL_API_KEY / GHL_LOCATION_ID, exactly as before.
 */
const brainContext = new AsyncLocalStorage();

function runWithBrain(brain, fn) {
  return brainContext.run(brain || null, fn);
}

function credentials() {
  const brain = brainContext.getStore();
  const cfg = brain && brain.ghl;
  if (cfg && (cfg.apiKeyEnv || cfg.locationIdEnv)) {
    return {
      apiKey: process.env[cfg.apiKeyEnv] || '',
      locationId: process.env[cfg.locationIdEnv] || '',
    };
  }
  return { apiKey: process.env.GHL_API_KEY || '', locationId: process.env.GHL_LOCATION_ID || '' };
}

function isConfigured() {
  const { apiKey, locationId } = credentials();
  return Boolean(apiKey && locationId);
}

function baseUrl() {
  return process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com';
}

function headers() {
  return {
    'content-type': 'application/json',
    Authorization: `Bearer ${credentials().apiKey}`,
    Version: API_VERSION,
  };
}

async function request(method, endpoint, body, dryRunLabel) {
  if (!isConfigured()) {
    // Synthesize a stable-looking fake id so downstream dry-run steps (e.g.
    // sendMessage using the contactId from upsertContact) still have
    // something to chain off of when demoing without real GHL credentials.
    const fakeId = `dryrun-${dryRunLabel || 'contact'}`;
    return {
      dryRun: true,
      note: `[DRY_RUN - no GoHighLevel credentials set for this client] Would have called ${method} ${endpoint}`,
      wouldHaveSent: body || null,
      label: dryRunLabel,
      id: fakeId,
      contact: { id: fakeId },
    };
  }

  const res = await fetch(`${baseUrl()}${endpoint}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`GHL API error ${res.status} on ${method} ${endpoint}: ${text}`);
  }

  return { dryRun: false, ...json };
}

/** Create or update a contact by email/phone. */
async function upsertContact({ firstName, lastName, email, phone, source, tags }) {
  return request(
    'POST',
    '/contacts/upsert',
    {
      locationId: credentials().locationId,
      firstName,
      lastName,
      email,
      phone,
      source,
      tags,
    },
    'upsertContact'
  );
}

/**
 * Review mode (the default): messages are NOT sent. Each one is saved as a
 * note on the contact in GoHighLevel, marked "DRAFT - NOT SENT", so Dr. Grove
 * can read real drafts on real contacts before anything goes out. Set
 * GHL_SEND_MODE=live in .env only when he's ready for the agents to send.
 */
function sendMode() {
  return (process.env.GHL_SEND_MODE || 'review').toLowerCase() === 'live' ? 'live' : 'review';
}

/** Send an SMS or Email through GHL's conversations API (or hold it, in review mode). */
async function sendMessage({ contactId, type, message, subject, html }) {
  if (isConfigured() && sendMode() !== 'live') {
    const note = [
      `DRAFT - NOT SENT (Sales Agent review mode)`,
      `Channel: ${type}${subject ? ` | Subject: ${subject}` : ''}`,
      ``,
      message,
    ].join('\n');
    const noteResult = await addNote({ contactId, body: note });
    return { held: true, reviewMode: true, channel: type, savedAsNote: !noteResult.dryRun, note: 'Not sent - saved as a note on the contact (GHL_SEND_MODE is review).' };
  }
  const body = {
    type, // 'SMS' | 'Email'
    contactId,
    message,
  };
  if (type === 'Email') {
    body.subject = subject;
    body.html = html || message;
  }
  return request('POST', '/conversations/messages', body, `sendMessage:${type}`);
}

/** Add a note to a contact's timeline - useful for logging agent reasoning. */
async function addNote({ contactId, body }) {
  return request(
    'POST',
    `/contacts/${contactId}/notes`,
    { body },
    'addNote'
  );
}

/** Add tags to a contact (GHL creates any tag that doesn't exist yet). */
async function addTags({ contactId, tags }) {
  const list = (tags || []).filter(Boolean);
  if (!contactId || !list.length) return { skipped: true };
  return request('POST', `/contacts/${contactId}/tags`, { tags: list }, 'addTags');
}

/** Remove tags from a contact - used to clear the trigger tag after a run. */
async function removeTags({ contactId, tags }) {
  const list = (tags || []).filter(Boolean);
  if (!contactId || !list.length) return { skipped: true };
  return request('DELETE', `/contacts/${contactId}/tags`, { tags: list }, 'removeTags');
}

/** Create an opportunity (pipeline entry) for a qualified lead. */
async function createOpportunity({ pipelineId, pipelineStageId, contactId, name, status }) {
  return request(
    'POST',
    '/opportunities/',
    {
      locationId: credentials().locationId,
      pipelineId,
      pipelineStageId,
      contactId,
      name,
      status: status || 'open',
    },
    'createOpportunity'
  );
}

module.exports = {
  runWithBrain,
  isConfigured,
  sendMode,
  upsertContact,
  sendMessage,
  addNote,
  addTags,
  removeTags,
  createOpportunity,
};
