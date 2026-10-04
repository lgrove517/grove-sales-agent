const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.join(__dirname, '..', '..', 'config');
const cache = new Map();

/**
 * Loads a client "brain" (business info, voice, offers, guardrails) by id.
 * id maps to config/<id>.json. Falls back to DEFAULT_BRAIN env var, then
 * to 'example'. Cached in memory after first read; call clearBrainCache()
 * if you edit a brain file while the server is running.
 */
function loadBrain(id) {
  const brainId = id || process.env.DEFAULT_BRAIN || 'grove-financial';

  if (cache.has(brainId)) return cache.get(brainId);

  const filePath = path.join(CONFIG_DIR, `${brainId}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `No brain config found for "${brainId}" (expected ${filePath}). ` +
        `Copy config/brain.example.json to config/${brainId}.json and fill it in.`
    );
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const brain = applyApprovalGates(JSON.parse(raw));
  cache.set(brainId, brain);
  return brain;
}

/**
 * Compliance on/off switch. Any offer (or the messagingThemes block) that
 * carries an "approvalFlag" stays OFF - removed from what the agents see -
 * until that environment variable is set to "true" on the host. That lets a
 * workflow sit in the code, fully built, while Gradient/compliance reviews
 * it, and go live the day approval lands just by flipping the variable in
 * Railway (no code change, no redeploy of new code).
 *
 * The removed items are listed on brain.pendingWorkflows so the prompt can
 * tell the agents not to improvise them, and /health can show their status.
 */
function isApproved(flag) {
  return !flag || String(process.env[flag] || '').trim().toLowerCase() === 'true';
}

function applyApprovalGates(brain) {
  const pending = [];
  const workflows = [];

  brain.offers = (brain.offers || []).filter((o) => {
    if (!o.approvalFlag) return true;
    const on = isApproved(o.approvalFlag);
    workflows.push({ name: o.name, flag: o.approvalFlag, enabled: on });
    if (!on) pending.push(o.name);
    return on;
  });

  const themes = brain.messagingThemes;
  if (themes && themes.approvalFlag && !isApproved(themes.approvalFlag)) {
    // Keep the notes/flag for reference, drop the actual messaging lines.
    brain.messagingThemes = { approvalFlag: themes.approvalFlag };
  }

  brain.pendingWorkflows = pending;
  brain.workflowStatus = workflows;
  return brain;
}

function clearBrainCache() {
  cache.clear();
}

/**
 * Renders the brain into a system-prompt block every agent shares. Keeping
 * this in one place means every agent (qualifier, follow-up, scheduler,
 * content) stays consistent about who the business is and what it won't do.
 */
function brainToSystemPrompt(brain) {
  const g = brain.guardrails || {};
  const ad = g.advisoryDisclosure;

  return [
    `You represent ${brain.businessName} (${brain.industry}).`,
    `Website: ${brain.website || 'n/a'}. Phone: ${brain.phone || 'n/a'}.`,
    ``,
    brain.marketingApproach ? `MARKETING APPROACH: ${brain.marketingApproach}` : '',
    ``,
    `VOICE: ${brain.voice?.tone || ''} Reading level: ${brain.voice?.readingLevel || 'plain English'}.`,
    brain.voice?.bannedPhrases?.length
      ? `Never use these phrases: ${brain.voice.bannedPhrases.join(', ')}.`
      : '',
    ``,
    `IDEAL CUSTOMER: ${brain.idealCustomerProfile?.description || 'n/a'}`,
    ``,
    `OFFERS:`,
    ...(brain.offers || []).map(
      (o) => `- ${o.name}: ${o.description} (CTA: ${o.cta})`
    ),
    ``,
    brain.messagingThemes?.retirementIncome?.length
      ? `RETIREMENT MESSAGING - open retirement conversations with these questions (${brain.messagingThemes.notes || ''}): ${brain.messagingThemes.retirementIncome.map((q) => `"${q}"`).join(' / ')}`
      : '',
    brain.pendingWorkflows?.length
      ? `PENDING COMPLIANCE APPROVAL - these workflows are switched OFF. Do not offer, describe, or write messaging for them, and do not invent a substitute: ${brain.pendingWorkflows.join('; ')}. If a lead raises one of these topics, use the General Conversation offer (an invitation to talk with Dr. Grove) and nothing more.`
      : '',
    `VALUE PROPS: ${(brain.valueProps || []).join('; ')}`,
    ``,
    `OBJECTION HANDLING:`,
    ...Object.entries(brain.objectionHandling || {}).map(
      ([obj, resp]) => `- If they say ${obj}: ${resp}`
    ),
    ``,
    brain.approvedFacts?.length
      ? [
          `APPROVED FACTS - the ONLY statistics, dollar figures and percentages you may use. Quote them as written and name the source. Any other number (including state or local costs) must be a [ADD REAL NUMBER] placeholder:`,
          ...brain.approvedFacts.map((f) => `- ${f.fact} (Source: ${f.source})`),
          ``,
        ].join('\n')
      : '',
    `HARD GUARDRAILS - these override everything else:`,
    ...(g.neverSay || []).map((s) => `- NEVER say or imply: ${s}`),
    `Escalate to a human (do not answer, do not proceed) if:`,
    ...(g.escalateToHumanIf || []).map((s) => `- ${s}`),
    g.manualSendRequirement ? `MANUAL-SEND RULE: ${g.manualSendRequirement}` : '',
    g.smsRestrictions ? `SMS-SPECIFIC RULE: ${g.smsRestrictions}` : '',
    g.approvedTitles?.length
      ? `Only use these titles, verbatim, if a title is needed: ${g.approvedTitles.join(', ')}.`
      : '',
    g.approvedDesignations?.length
      ? `Only use these professional designation abbreviations, if any are needed: ${g.approvedDesignations.join(', ')}.`
      : '',
    // Simple template case: a flat footer required on every outbound message.
    g.requiredDisclosureFooter
      ? `Any outbound message must include this disclosure footer verbatim: """${g.requiredDisclosureFooter}"""`
      : '',
    // Regulated-client case: the disclosure only applies to specific content.
    ad
      ? [
          ``,
          `CONDITIONAL DISCLOSURE (investment advisory only): ${ad.appliesWhen}`,
          `If, and only if, this message actually discusses or solicits investment advisory services through Gradient Advisors, draft it WITH the matching disclosure verbatim for the channel in use, but mark it as needing Dr. Grove's personal review and send - do not treat it as ready to auto-send on any channel:`,
          ad.email ? `- Email/memo channel: """${ad.email}"""` : '',
          ad.website ? `- Website channel: """${ad.website}"""` : '',
          ad.printOrBusinessCard ? `- Print/business-card channel: """${ad.printOrBusinessCard}"""` : '',
          `This system never auto-sends advisory content on ANY channel, not just SMS - Gradient requires Dr. Grove to send it personally so it can be documented for their compliance files. Draft it, then stop and hand off.`,
        ]
          .filter(Boolean)
          .join('\n')
      : '',
    g.stateInsuranceDisclosure?.producerIdentificationRule
      ? [
          ``,
          `STATE INSURANCE ADVERTISING/DISCLOSURE RULES (separate from the Gradient/advisory disclosure above - applies to insurance-side content: life, IUL, annuities, Medicare):`,
          `- ${g.stateInsuranceDisclosure.producerIdentificationRule}`,
          g.stateInsuranceDisclosure.generalAdvertisingStandard
            ? `- ${g.stateInsuranceDisclosure.generalAdvertisingStandard}`
            : '',
          g.stateInsuranceDisclosure.medicareMarketingDisclaimer
            ? `- MEDICARE-SPECIFIC (federal CMS rule, any state): ${g.stateInsuranceDisclosure.medicareMarketingDisclaimer}`
            : '',
        ]
          .filter(Boolean)
          .join('\n')
      : '',
    ``,
    `Sign off as: ${brain.voice?.signOffName || brain.businessName}.`,
  ]
    .filter(Boolean)
    .join('\n');
}

module.exports = { loadBrain, clearBrainCache, brainToSystemPrompt, applyApprovalGates, CONFIG_DIR };
