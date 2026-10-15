/**
 * PACKAGES: what the AI Sales Agent actually does for each Webtech Design
 * package. One line per level:
 *   Starter - no AI. The client runs on the GoHighLevel system only.
 *   Growth  - the AI writes their marketing (content, social calendar,
 *             briefing, recommendations, monthly report) and sends
 *             follow-ups to leads who have gone quiet.
 *   Premium - the AI also works their leads (qualifies, replies, books),
 *             with review mode until the client approves.
 *
 * Where a client's package comes from, first match wins:
 *   1. The package saved in the database - set automatically by Stripe when
 *      the client buys, upgrades or cancels (see setClientPackage), or by hand.
 *   2. "package" in the client's brain file (config/<client>.json).
 *   3. Nothing set: "internal" - Dr. Grove's own organizations (Grove
 *      Financial Group, VCF, Webtech itself) keep every feature.
 *
 * A locked feature never runs: no AI call, nothing drafted, nothing sent.
 */
const db = require('../store/db');

const LEVELS = {
  starter: { rank: 1, label: 'Starter' },
  growth: { rank: 2, label: 'Growth' },
  premium: { rank: 3, label: 'Premium' },
  internal: { rank: 99, label: 'Internal (all features)' },
  canceled: { rank: 0, label: 'Canceled (AI paused)' },
};

// feature -> lowest package that includes it
const FEATURES = {
  // AI writes your marketing (Growth and up)
  content: { needs: 'growth', label: 'Content drafts (posts, emails, ad copy)' },
  socialCalendar: { needs: 'growth', label: '30-day social calendar' },
  briefing: { needs: 'growth', label: '"What did I miss" briefing' },
  recommendations: { needs: 'growth', label: 'Recommendations for more leads' },
  monthlyReport: { needs: 'growth', label: 'Monthly results report' },
  statusSync: { needs: 'growth', label: 'Booked / opted-out status sync' },
  aiFollowUp: { needs: 'growth', label: 'AI follow-ups' },
  // AI works your leads (Premium)
  leadAgent: { needs: 'premium', label: 'Lead qualifier and first reply' },
  replyAgent: { needs: 'premium', label: 'Reply handler' },
  appointmentSetter: { needs: 'premium', label: 'Appointment setter' },
};

db.db.exec(`
  CREATE TABLE IF NOT EXISTS client_packages (
    brand TEXT PRIMARY KEY,
    package TEXT NOT NULL,
    source TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

function normalize(pkg) {
  const p = String(pkg || '').trim().toLowerCase();
  return LEVELS[p] ? p : null;
}

/** The client's package right now: { key, label, source }. */
function packageFor(brain) {
  const brand = brain && brain.clientId;
  const row = brand ? db.db.prepare('SELECT package, source FROM client_packages WHERE brand = ?').get(brand) : null;
  const saved = row && normalize(row.package);
  if (saved) return { key: saved, label: LEVELS[saved].label, source: row.source || 'saved' };
  const fromFile = normalize(brain && brain.package);
  if (fromFile) return { key: fromFile, label: LEVELS[fromFile].label, source: 'brain file' };
  return { key: 'internal', label: LEVELS.internal.label, source: 'default' };
}

function hasFeature(brain, feature) {
  const f = FEATURES[feature];
  if (!f) return true;
  return LEVELS[packageFor(brain).key].rank >= LEVELS[f.needs].rank;
}

/** Plain-language reason a feature is off, for logs, notes and the dashboard. */
function lockedMessage(brain, feature) {
  const f = FEATURES[feature];
  const pkg = packageFor(brain);
  if (pkg.key === 'canceled') {
    return `${f ? f.label : 'This feature'}: paused - ${brain.businessName || brain.clientId}'s subscription has ended.`;
  }
  return `${f ? f.label : 'This feature'}: part of the ${LEVELS[f.needs].label} package. ${brain.businessName || brain.clientId} is on ${pkg.label}.`;
}

/** Feature list with on/off, for /health and the dashboard. */
function featureStatus(brain) {
  return Object.entries(FEATURES).map(([key, f]) => ({
    key, label: f.label, needs: LEVELS[f.needs].label, enabled: hasFeature(brain, key),
  }));
}

function setClientPackage(brand, pkg, source) {
  const p = normalize(pkg);
  if (!brand || !p) return false;
  db.db.prepare(`
    INSERT INTO client_packages (brand, package, source, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(brand) DO UPDATE SET package = excluded.package, source = excluded.source, updated_at = excluded.updated_at
  `).run(brand, p, source || null);
  return true;
}

/** Stripe plan key (starter, growth, premium, upgrade-growth...) -> package. */
function packageForPlanKey(planKey) {
  const k = String(planKey || '').toLowerCase();
  if (k.endsWith('premium')) return 'premium';
  if (k.endsWith('growth')) return 'growth';
  if (k.endsWith('starter')) return 'starter';
  return null;
}

module.exports = { FEATURES, LEVELS, packageFor, hasFeature, lockedMessage, featureStatus, setClientPackage, packageForPlanKey };
