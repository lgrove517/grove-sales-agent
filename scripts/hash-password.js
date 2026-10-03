/**
 * Generates a bcrypt hash for a password so you never have to put the
 * plain-text password in .env. Run it, paste the output into
 * AUTH_PASSWORD_HASH, and the original password is never stored anywhere.
 *
 * Usage:
 *   npm run hash-password -- "your-real-password"
 *   (the -- is required so npm passes the argument through to the script)
 * or directly:
 *   node scripts/hash-password.js "your-real-password"
 */
const bcrypt = require('bcryptjs');

const password = process.argv[2];

if (!password) {
  console.error('Usage: node scripts/hash-password.js "your-password"');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 12);
console.log('\nAdd this line to your .env file:\n');
console.log(`AUTH_PASSWORD_HASH=${hash}\n`);
