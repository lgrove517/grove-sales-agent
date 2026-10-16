/**
 * Code-level backstop for advisory-content sending rules, on top of the
 * prompt-level instructions in brainToSystemPrompt(). Two confirmed rules
 * from Dr. Grove / Gradient Advisors (Sep 17 2026) sit behind this:
 *
 * 1. GoHighLevel is not an approved SMS vendor for investment-related
 *    material - advisory content can never go out over SMS at all.
 * 2. Gradient wants documentation that the advisory disclosure was sent,
 *    and Dr. Grove has to be the one who sends it (not an automated
 *    system) so that record exists for their compliance files. In
 *    practice that means: on ANY channel, this system never auto-sends
 *    content that carries or requires the advisory disclosure - it
 *    always stops short and hands the drafted message to Dr. Grove to
 *    review, send himself, and log for Gradient.
 *
 * Both rules matter enough that they shouldn't rely on the model alone
 * remembering them, so this scans generated message text before any send
 * and blocks it if it looks like advisory/securities content, regardless
 * of channel.
 */
const ADVISORY_KEYWORDS = [
  'gradient advisors',
  'investment advisory',
  'investment advisor representative',
  'securities',
  'registered investment advisor',
];

/**
 * Investment TOPICS (Oct 2026 direction from Dr. Grove): 401(k)s, rollovers,
 * pensions, IRAs, business retirement plans and fiduciary language belong to
 * Grove Wealth Management / Gradient Advisors, not Grove Financial Group. The
 * Grove Financial Group agents may invite people into a conversation about
 * retirement INCOME, but any message or lead that gets into these topics is
 * routed to Dr. Grove personally - never auto-sent, never auto-qualified.
 * Matched as patterns so "401k", "401(k)" and "401 (k)" all count.
 */
const INVESTMENT_TOPIC_PATTERNS = [
  { label: '401(k)', re: /\b401\s?\(?k\)?/i },
  { label: '403(b)', re: /\b403\s?\(?b\)?/i },
  { label: '457 plan', re: /\b457\s?(?:\(b\)|plan)/i },
  { label: 'rollover', re: /\broll[\s-]?over/i },
  { label: 'IRA', re: /\bIRAs?\b/ }, // capitals only, so a lead named Ira doesn't trip it
  { label: 'IRA', re: /\b(?:roth|sep|simple)[\s-]ira\b/i },
  { label: 'pension', re: /\bpension/i },
  { label: 'lump sum', re: /\blump[\s-]sum/i },
  { label: 'fiduciary', re: /\bfiduciar/i },
  { label: 'portfolio', re: /\bportfolio/i },
  { label: 'stocks/mutual funds', re: /\b(?:stocks?|mutual funds?|etfs?|bonds?)\b/i },
  { label: 'brokerage account', re: /\bbrokerage/i },
  { label: 'cash balance plan', re: /\bcash[\s-]balance/i },
];

/** Returns the label of the first investment topic found, or null. */
function detectInvestmentTopic(text) {
  const t = text || '';
  const hit = INVESTMENT_TOPIC_PATTERNS.find((p) => p.re.test(t));
  return hit ? hit.label : null;
}

/**
 * The investment-advisory guards (Gradient / Grove Wealth Management rules)
 * exist for Grove Financial Group. A client brain that has nothing to do with
 * securities - Webtech Design, for example - switches them off with
 * "compliance": { "financialAdvisoryGuards": false }, so a word like
 * "portfolio" (a web designer's portfolio) or a CPA lead mentioning IRAs
 * isn't routed to Dr. Grove as an investment inquiry. Missing = ON, so any
 * brain that doesn't say otherwise keeps the full protection.
 */
function financialGuardsOn(brain) {
  return brain?.compliance?.financialAdvisoryGuards !== false;
}

/**
 * Returns { blocked: boolean, reason?: string, requiresManualSend?: boolean }.
 * Blocks on every channel now, not just SMS: advisory-flavored content is
 * never auto-sent by this system. The reason text calls out the specific
 * rule that applies (unapproved SMS vendor vs. the manual-send/documentation
 * requirement) so whoever reads the escalation log knows which one fired.
 */
function checkAdvisoryAutoSend(channel, messageText, brain) {
  if (brain && !financialGuardsOn(brain)) return { blocked: false };
  const lower = (messageText || '').toLowerCase();
  const hit = ADVISORY_KEYWORDS.find((kw) => lower.includes(kw));
  if (!hit) {
    const topic = detectInvestmentTopic(messageText);
    if (!topic) return { blocked: false };
    return {
      blocked: true,
      requiresManualSend: true,
      reason: `Message mentions "${topic}", an investment topic that belongs to Grove Wealth Management / Gradient Advisors, not Grove Financial Group. Not sent - draft is ready for Dr. Grove to review and handle personally.`,
    };
  }

  if (channel === 'SMS') {
    return {
      blocked: true,
      requiresManualSend: true,
      reason: `Message references "${hit}", which is investment-advisory content. GoHighLevel is not an approved SMS vendor for that content (confirmed with Gradient Advisors), and advisory content must be sent by Dr. Grove personally regardless of channel. Do not send - hand this to Dr. Grove.`,
    };
  }

  return {
    blocked: true,
    requiresManualSend: true,
    reason: `Message references "${hit}", which is investment-advisory content. Per Gradient Advisors, Dr. Grove must personally send any communication carrying the advisory disclosure so it can be documented for their compliance files - this system never auto-sends it, on any channel. Draft is ready for his review and manual send.`,
  };
}

// Backward-compatible alias for existing call sites.
const checkSmsCompliance = checkAdvisoryAutoSend;

/**
 * Separate, federal-level backstop: CMS's Medicare Communications and
 * Marketing Guidelines (the "TPMO rule") require a specific disclaimer any
 * time Medicare Advantage/Part D/Medicare Supplement plans are actually
 * discussed - not blocked like advisory content, just required to be
 * present. Sourced Sep 2026 (see config stateInsuranceDisclosure for
 * citations). Unlike the advisory guard, this does not stop the send - it
 * appends the required language automatically so a drafted message can
 * never go out silently missing it.
 */
const MEDICARE_PLAN_KEYWORDS = [
  'medicare advantage',
  'medicare part d',
  'part d plan',
  'medicare supplement',
  'medigap',
  'medicare plan',
];

// Any consumer quoting/enrollment site link counts as discussing plans.
const QUOTE_SITE_PATTERN = /destinationrx\.com|planenroll\.com|retireflo\.com/i;
const QUOTE_LINK_PATTERN = /(?:https?:\/\/)?(?:[\w-]+\.)*(?:destinationrx|planenroll)\.com\S*/gi;
// The Scope of Appointment survey (RetireFlo): checked like the quoting links,
// but may ride alongside one of them.
const SOA_LINK_PATTERN = /(?:https?:\/\/)?(?:[\w-]+\.)*retireflo\.com\S*/gi;

// Signs the LEAD (not the draft) has shown Medicare interest.
const MEDICARE_INTEREST_PATTERN = /\b(medicare|medigap|part d|turning 65|turn(?:s|ed)? 65|annual enrollment)\b/i;

// Fallback only, for a brain with no medicareDisclaimer config. CMS now
// expects the version with exact organization/product counts, which a brain
// supplies per county (see config/grove-financial.json medicareDisclaimer).
const TPMO_DISCLAIMER =
  'We do not offer every plan available in your area. Any information we provide is limited to those plans we do offer in your area. Please contact Medicare.gov or 1-800-MEDICARE to get information on all of your options.';

/** First 5 digits of the lead's ZIP code, whatever shape the lead object is in. */
function leadZip(lead) {
  const raw = lead && (lead.postalCode || lead.postal_code || lead.zip || lead.zipCode);
  const m = String(raw || '').match(/\d{5}/);
  return m ? m[0] : null;
}

/** The brain's area entry (e.g. Mobile County) for this lead's ZIP, or null. */
function medicareAreaFor(brain, lead) {
  const zip = leadZip(lead);
  const areas = brain?.medicareDisclaimer?.areas || [];
  return zip ? areas.find((a) => (a.zips || []).includes(zip)) || null : null;
}

/**
 * Returns { messageText, disclaimerAppended, needsArea?, reason? }. Only acts
 * when the message names a specific Medicare plan type and doesn't already
 * carry the disclaimer (re-running is a no-op).
 *
 * With a brain that has medicareDisclaimer config:
 *  - a lead in a listed area gets that county's exact-count disclaimer;
 *  - a lead outside the listed areas (or with no ZIP on file) gets nothing
 *    appended and needsArea: true - callers hold that draft for Dr. Grove,
 *    because the counts can't be stated correctly for that person;
 *  - no lead at all (social posts) gets the brain's generalText.
 *  - anyMedicareMention: true (social posts) treats any mention of the word
 *    Medicare as discussing plans.
 */
function ensureMedicareDisclaimer(messageText, { brain, lead, anyMedicareMention = false } = {}) {
  const text = messageText || '';
  const lower = text.toLowerCase();
  const mentionsMedicarePlan =
    MEDICARE_PLAN_KEYWORDS.some((kw) => lower.includes(kw)) || QUOTE_SITE_PATTERN.test(text) ||
    // Social posts are mass marketing to Medicare beneficiaries, so any
    // mention of Medicare gets the disclaimer there (Oct 14 2026).
    (anyMedicareMention && /\bmedicare\b/i.test(text));
  const alreadyDisclosed = lower.includes('we do not offer every plan available in your area');

  // A brain that never markets plans to Medicare beneficiaries (the GFG
  // agency, which talks to agents and professionals) opts out with
  // "compliance": { "medicareConsumerDisclaimer": false }. Quoting and SOA
  // links are still held for it by checkMedicareQuoteLink.
  if (brain?.compliance?.medicareConsumerDisclaimer === false) {
    return { messageText: text, disclaimerAppended: false };
  }

  if (!mentionsMedicarePlan || alreadyDisclosed) {
    return { messageText: text, disclaimerAppended: false };
  }

  const cfg = brain?.medicareDisclaimer;
  let disclaimer = TPMO_DISCLAIMER;
  if (cfg && lead) {
    const area = medicareAreaFor(brain, lead);
    if (!area) {
      const zip = leadZip(lead);
      return {
        messageText: text,
        disclaimerAppended: false,
        needsArea: true,
        reason: zip
          ? `Draft discusses Medicare plans, but ZIP ${zip} is outside the areas with plan counts on file (${cfg.areas.map((a) => a.name).join(', ')}). Held for Dr. Grove.`
          : `Draft discusses Medicare plans, but no ZIP code is on file for this lead, so the required plan-count disclaimer can't be filled in. Held for Dr. Grove.`,
      };
    }
    disclaimer = cfg.template
      .replace('{organizations}', area.organizations)
      .replace('{products}', area.products);
  } else if (cfg && cfg.generalText) {
    disclaimer = cfg.generalText;
  }

  return {
    messageText: `${text}\n\n${disclaimer}`,
    disclaimerAppended: true,
  };
}

/**
 * Medicare quoting-link guard (Oct 2026). The model is told the rules in the
 * prompt; this makes the important ones hold even if it forgets. Returns
 * { hold: false } or { hold: true, reason } - callers hold the draft for
 * Dr. Grove, the same as a missing-county disclaimer.
 *
 * Holds a draft that carries a quoting-site link when:
 *  - the quoting link is switched off (MEDICARE_QUOTING_APPROVED not true);
 *  - the link isn't the exact one on file (altered or a different site);
 *  - the lead never showed Medicare interest (leadText is what they said
 *    plus their GHL tags) - the link is never cold-sent;
 *  - the draft names a carrier (carrier names need carrier approval).
 * The RetireFlo Scope of Appointment survey link gets the same checks and
 * must match brain.medicareQuoting.soaSurvey.url exactly. It works even while
 * the quoting links are switched off (medicareQuoting.quotingOff).
 * Social posts pass leadText: null to skip the interest check.
 */
/**
 * Link rules (brain.linkRules), e.g. the agency's carrier-contracting link.
 * A draft carrying a rule's link is held unless the link is exactly the one
 * on file, it's a one-to-one message (not a social post), and what the lead
 * said matches every requireLeadPatterns entry. Runs at the top of
 * checkMedicareQuoteLink, so every agent that checks quote links checks
 * these too. Returns { hold: false } or { hold: true, reason }.
 */
function checkLinkRules(messageText, { brain, leadText } = {}) {
  const text = messageText || '';
  const clean = (u) => u.replace(/[).,;:!?'"]+$/, '');
  for (const rule of brain?.linkRules || []) {
    const re = new RegExp(rule.matchPattern, 'gi');
    const found = text.match(re);
    if (!found) continue;
    const allowed = [rule.url, ...(rule.aliases || [])];
    if (found.some((u) => !allowed.includes(clean(u)))) {
      return { hold: true, reason: `Draft's ${rule.label} doesn't match the one on file (${rule.url}). Held for Dr. Grove.` };
    }
    if (leadText === null) {
      return { hold: true, reason: `The ${rule.label} is for one-to-one messages, not social posts.` };
    }
    const missing = (rule.requireLeadPatterns || []).find((r) => !new RegExp(r.pattern, 'i').test(leadText || ''));
    if (missing) {
      return { hold: true, reason: `Draft includes the ${rule.label}, but the lead hasn't ${missing.label}. Held for Dr. Grove.` };
    }
  }
  return { hold: false };
}

function checkMedicareQuoteLink(messageText, { brain, leadText } = {}) {
  const text = messageText || '';
  const linkRule = checkLinkRules(text, { brain, leadText });
  if (linkRule.hold) return linkRule;
  if (!QUOTE_SITE_PATTERN.test(text)) return { hold: false };

  const mq = brain?.medicareQuoting;
  const hasQuoteSite = /destinationrx\.com|planenroll\.com/i.test(text);
  if (!mq || (mq.quotingOff && hasQuoteSite)) {
    return {
      hold: true,
      reason: 'Draft includes a Medicare quoting-site link, but the quoting link is still switched off pending compliance (MEDICARE_QUOTING_APPROVED). Held for Dr. Grove.',
    };
  }

  const clean = (u) => u.replace(/[).,;:!?'"]+$/, '');
  const soaLinks = text.match(SOA_LINK_PATTERN) || [];
  const soaUrl = mq.soaSurvey && mq.soaSurvey.url;
  if (soaLinks.some((u) => clean(u) !== soaUrl)) {
    return {
      hold: true,
      reason: `Draft's survey link doesn't match the Scope of Appointment survey on file (${soaUrl || 'none on file'}). Held for Dr. Grove.`,
    };
  }

  if (soaLinks.length && leadText === null) {
    return { hold: true, reason: 'The Scope of Appointment survey link is for one-to-one messages, not social posts.' };
  }

  const allowed = (mq.quoteTools || []).map((t) => t.url).concat(mq.quoteToolUrl || []);
  const links = text.match(QUOTE_LINK_PATTERN) || [];
  if (links.some((u) => !allowed.includes(clean(u)))) {
    return {
      hold: true,
      reason: `Draft's quoting link doesn't match one on file (${allowed.join(' or ')}). Held for Dr. Grove.`,
    };
  }
  if (new Set(links.map(clean)).size > 1) {
    return { hold: true, reason: 'Draft gives two different Medicare quoting links - send one at a time. Held for Dr. Grove.' };
  }

  if (leadText !== null && !MEDICARE_INTEREST_PATTERN.test(leadText || '')) {
    return {
      hold: true,
      reason: "Draft includes a Medicare link, but this lead hasn't asked about Medicare and has no Medicare tag - Medicare links are never cold-sent. Held for Dr. Grove.",
    };
  }

  const carriers = [
    ...Object.values(mq.quoteToolCovers || {}).flat(),
    ...Object.values(mq.otherCarriersByConversation || {}).flat(),
  ].filter((c) => typeof c === 'string' && /^[A-Z]/.test(c) && !/^[A-Z]{2}\b/.test(c) && !/FMO/.test(c));
  const named = [...new Set(carriers)].find((c) => new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));
  if (named) {
    return {
      hold: true,
      reason: `Draft with a Medicare link names ${named} - carrier names need carrier approval. Held for Dr. Grove.`,
    };
  }

  return { hold: false };
}

/**
 * CAN-SPAM requires a valid physical postal address on any commercial
 * email. This appends the brain's on-file mailing address to Email-channel
 * messages that don't already carry it, the same "append, don't block"
 * pattern as the Medicare disclaimer above - a missing address is a defect
 * to fix silently, not a reason to hold the message for manual review.
 * No-op on SMS (CAN-SPAM doesn't apply) or if no mailingAddress is on file.
 */
function ensureCanSpamFooter(channel, messageText, brain) {
  const address = brain?.mailingAddress?.value;
  const text = messageText || '';

  if (channel !== 'Email' || !address) {
    return { messageText: text, footerAppended: false };
  }
  if (text.toLowerCase().includes(address.toLowerCase())) {
    return { messageText: text, footerAppended: false };
  }

  // The address value is expected to already read naturally on its own
  // (e.g. "Grove Financial Group Inc., Mobile, AL 36618"), so it's appended
  // as-is rather than prefixed with the business name a second time.
  return {
    messageText: `${text}\n\n${address}`,
    footerAppended: true,
  };
}

/**
 * Separation guard, configured per brain (compliance.blockedMentions): a
 * client like Village Covenant Foundation must never mention Dr. Grove's
 * advisory or insurance businesses or any financial product. Returns the
 * same { blocked, reason } shape as checkAdvisoryAutoSend so callers can
 * hold the message for Dr. Grove instead of sending it.
 */
function checkSeparation(messageText, brain) {
  const rules = brain?.compliance?.blockedMentions || [];
  const text = messageText || '';
  const hit = rules.find((r) => new RegExp(r.pattern, 'i').test(text));
  if (!hit) return { blocked: false };
  return {
    blocked: true,
    requiresManualSend: true,
    reason: `Draft mentions ${hit.label}, which ${brain.businessName} messages must never mention (separation rule). Held for Dr. Grove to review and rewrite.`,
  };
}

/** Largest dollar amount mentioned in a message ("$5,000", "5k", "$1.2 million", "10,000 dollars"). */
function largestAmount(text) {
  const re = /\$\s*([\d,]+(?:\.\d+)?)\s*(k|thousand|m|million)?\b|\b([\d,]+(?:\.\d+)?)\s*(k|thousand|million|dollars)\b/gi;
  let max = 0;
  let m;
  while ((m = re.exec(text || ''))) {
    const n = parseFloat((m[1] || m[3] || '0').replace(/,/g, ''));
    const unit = (m[2] || m[4] || '').toLowerCase();
    const mult = unit === 'k' || unit === 'thousand' ? 1e3 : unit === 'm' || unit === 'million' ? 1e6 : 1;
    if (!Number.isNaN(n)) max = Math.max(max, n * mult);
  }
  return max;
}

/**
 * Donor handoff rules (brain.donorRules), enforced in code rather than left
 * to the model: a gift interest at or above the threshold, or any planned-
 * gift or sensitive topic, goes to Dr. Grove personally. Returns null, or
 * { reason, tagKey } where tagKey is looked up in brain.agentTags.
 */
function detectDonorHandoff(text, brain) {
  // donorRules (Village Covenant Foundation) or handoffRules (any other
  // brain, e.g. the agency's securities / referral-fee / consumer routing).
  const rules = brain?.donorRules || brain?.handoffRules;
  if (!rules || !text) return null;
  const amount = largestAmount(text);
  if (rules.handoffThreshold && amount >= rules.handoffThreshold) {
    return {
      reason: `Mentions a gift of about $${amount.toLocaleString('en-US')}, at or above the $${Number(rules.handoffThreshold).toLocaleString('en-US')} handoff amount - for Dr. Grove personally.`,
      tagKey: 'handoff',
    };
  }
  const hit = (rules.handoffTopics || []).find((t) => new RegExp(t.pattern, 'i').test(text));
  if (hit) return { reason: `Mentions ${hit.label} - for Dr. Grove personally.`, tagKey: hit.tag || 'handoff' };
  return null;
}

module.exports = {
  checkSeparation,
  detectDonorHandoff,
  largestAmount,
  financialGuardsOn,
  checkAdvisoryAutoSend,
  checkSmsCompliance,
  ADVISORY_KEYWORDS,
  detectInvestmentTopic,
  INVESTMENT_TOPIC_PATTERNS,
  ensureMedicareDisclaimer,
  checkMedicareQuoteLink,
  checkLinkRules,
  MEDICARE_INTEREST_PATTERN,
  medicareAreaFor,
  leadZip,
  TPMO_DISCLAIMER,
  MEDICARE_PLAN_KEYWORDS,
  ensureCanSpamFooter,
};
