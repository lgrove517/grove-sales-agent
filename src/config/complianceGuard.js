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
 * Returns { blocked: boolean, reason?: string, requiresManualSend?: boolean }.
 * Blocks on every channel now, not just SMS: advisory-flavored content is
 * never auto-sent by this system. The reason text calls out the specific
 * rule that applies (unapproved SMS vendor vs. the manual-send/documentation
 * requirement) so whoever reads the escalation log knows which one fired.
 */
function checkAdvisoryAutoSend(channel, messageText) {
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
];

const TPMO_DISCLAIMER =
  'We do not offer every plan available in your area. Any information we provide is limited to those plans we do offer in your area. Please contact Medicare.gov or 1-800-MEDICARE to get information on all of your options.';

/**
 * Returns { messageText, disclaimerAppended: boolean }. Only touches the
 * message if it actually names a specific Medicare plan type AND doesn't
 * already carry the disclaimer language (checked by a distinctive phrase
 * from the disclaimer itself, so re-running this is a no-op).
 */
function ensureMedicareDisclaimer(messageText) {
  const text = messageText || '';
  const lower = text.toLowerCase();
  const mentionsMedicarePlan = MEDICARE_PLAN_KEYWORDS.some((kw) => lower.includes(kw));
  const alreadyDisclosed = lower.includes('we do not offer every plan available in your area');

  if (!mentionsMedicarePlan || alreadyDisclosed) {
    return { messageText: text, disclaimerAppended: false };
  }

  return {
    messageText: `${text}\n\n${TPMO_DISCLAIMER}`,
    disclaimerAppended: true,
  };
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

module.exports = {
  checkAdvisoryAutoSend,
  checkSmsCompliance,
  ADVISORY_KEYWORDS,
  detectInvestmentTopic,
  INVESTMENT_TOPIC_PATTERNS,
  ensureMedicareDisclaimer,
  TPMO_DISCLAIMER,
  MEDICARE_PLAN_KEYWORDS,
  ensureCanSpamFooter,
};
