/**
 * Simulates a new lead hitting the webhook, then a follow-up command,
 * without needing a running server or live API keys. Run with:
 *   node test/simulate.js
 *
 * This exercises the exact same code paths the real server uses
 * (loadBrain -> qualifyLead -> ghl.upsertContact/sendMessage -> logEvent),
 * so a clean run here is a real signal the pipeline works end to end.
 */
require('dotenv').config();
const { loadBrain } = require('../src/config/loadBrain');
const { qualifyLead } = require('../src/agents/leadQualifier');
const { draftFollowUp } = require('../src/agents/followUp');
const { draftContent } = require('../src/agents/contentAgent');
const { runCommand } = require('../src/agents/orchestrator');
const ghl = require('../src/integrations/ghl');
const db = require('../src/store/db');

async function main() {
  console.log('--- Simulating a new inbound lead ---');
  const brain = loadBrain('grove-financial');

  const leadId = db.insertLead({
    brand: brain.clientId,
    firstName: 'Marcus',
    lastName: 'Simulated',
    email: 'marcus@example.com',
    phone: '+12515550100',
    source: 'simulation',
    state: 'AL',
  });

  const ghlResult = await ghl.upsertContact({
    firstName: 'Marcus',
    lastName: 'Simulated',
    email: 'marcus@example.com',
    phone: '+12515550100',
    source: 'simulation',
    tags: ['sim'],
  });
  console.log('GHL upsertContact ->', JSON.stringify(ghlResult, null, 2));

  const verdict = await qualifyLead({
    brain,
    lead: {
      id: leadId,
      firstName: 'Marcus',
      lastName: 'Simulated',
      email: 'marcus@example.com',
      phone: '+12515550100',
      state: 'AL',
      source: 'simulation',
      message: 'I own a small business and have not looked at our retirement plan fees in years.',
      ghlContactId: ghlResult.contact?.id || null,
    },
  });
  console.log('Lead qualifier verdict ->', JSON.stringify(verdict, null, 2));

  console.log('\n--- Simulating a follow-up ---');
  const followUp = await draftFollowUp({
    brain,
    lead: { id: leadId, firstName: 'Marcus', ghlContactId: ghlResult.contact?.id || null },
    attemptNumber: 1,
    channel: 'SMS',
    context: 'Sent the intro reply two days ago, no response yet.',
  });
  console.log('Follow-up ->', JSON.stringify(followUp, null, 2));

  console.log('\n--- Simulating a content-drafting command ---');
  const content = await draftContent({
    brain,
    instruction: 'Draft 2 LinkedIn posts about the free retirement plan review for business owners',
  });
  console.log('Content ->', JSON.stringify(content, null, 2));

  console.log('\n--- Simulating the command center router ---');
  const commandResult = await runCommand({ brain, instruction: 'list leads' });
  console.log('Command result ->', JSON.stringify(commandResult, null, 2));

  console.log('\nDone. Check data/agent.db (SQLite) for persisted leads/events.');
}

main().catch((err) => {
  console.error('Simulation failed:', err);
  process.exit(1);
});
