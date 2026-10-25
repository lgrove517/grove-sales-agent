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

module.exports = { ensureSignOff };
