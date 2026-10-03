const fetch = require('node-fetch');

const API_VERSION = '2021-07-28';

function isConfigured() {
  return Boolean(process.env.GHL_API_KEY && process.env.GHL_LOCATION_ID);
}

function baseUrl() {
  return process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com';
}

function headers() {
  return {
    'content-type': 'application/json',
    Authorization: `Bearer ${process.env.GHL_API_KEY}`,
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
      note: `[DRY_RUN - no GHL_API_KEY/GHL_LOCATION_ID set] Would have called ${method} ${endpoint}`,
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
      locationId: process.env.GHL_LOCATION_ID,
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
      locationId: process.env.GHL_LOCATION_ID,
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
  isConfigured,
  sendMode,
  upsertContact,
  sendMessage,
  addNote,
  addTags,
  removeTags,
  createOpportunity,
};
