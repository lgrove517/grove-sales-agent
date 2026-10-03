/**
 * Resets the command-center login and SAVES it to .env for you, so there's
 * no copy-and-paste step to forget.
 *
 * Usage (from the app folder):
 *   npm run reset-password
 *
 * It asks for a username (Enter keeps the current one) and a new password
 * twice (hidden as you type), backs up .env to .env.bak, then writes
 * AUTH_USERNAME and AUTH_PASSWORD_HASH into .env. If SESSION_SECRET is
 * missing it creates one too. Restart the server afterwards (Ctrl+C, then
 * npm start) so it picks up the new login.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const bcrypt = require('bcryptjs');

const ENV_PATH = path.join(__dirname, '..', '.env');
const MIN_LENGTH = 8;

function readEnv() {
  return fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
}

function getValue(text, key) {
  const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].trim() : '';
}

function setValue(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) return text.replace(re, () => line);
  return text + (text.endsWith('\n') || text === '' ? '' : '\n') + line + '\n';
}

// Line reader that works both in a real terminal (hidden password input)
// and when input is piped in (tests).
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
const queued = [];
const waiting = [];
rl.on('line', (l) => (waiting.length ? waiting.shift()(l) : queued.push(l)));
let muted = false;
rl._writeToOutput = function (s) {
  if (!muted) rl.output.write(s);
  else if (s.includes('\n')) rl.output.write('\n');
};

function ask(question, hidden = false) {
  process.stdout.write(question);
  muted = hidden && process.stdin.isTTY;
  return new Promise((resolve) => {
    const done = (l) => {
      muted = false;
      if (hidden && !process.stdin.isTTY) process.stdout.write('\n');
      resolve(l);
    };
    queued.length ? done(queued.shift()) : waiting.push(done);
  });
}

(async () => {
  let env = readEnv();
  const currentUser = getValue(env, 'AUTH_USERNAME');

  console.log('\nReset the Sales Agent login\n');
  const userIn = (await ask(`Username${currentUser ? ` [${currentUser}]` : ''}: `)).trim();
  const username = userIn || currentUser;
  if (!username) {
    console.error('\nA username is required. Nothing was changed.');
    process.exit(1);
  }

  const pw1 = await ask('New password (hidden): ', true);
  if (pw1.length < MIN_LENGTH) {
    console.error(`\nPassword must be at least ${MIN_LENGTH} characters. Nothing was changed.`);
    process.exit(1);
  }
  const pw2 = await ask('Type it again: ', true);
  if (pw1 !== pw2) {
    console.error('\nThe two passwords did not match. Nothing was changed.');
    process.exit(1);
  }
  rl.close();

  const hash = bcrypt.hashSync(pw1, 12);
  if (!bcrypt.compareSync(pw1, hash)) {
    console.error('\nCould not verify the new password hash. Nothing was changed.');
    process.exit(1);
  }

  if (fs.existsSync(ENV_PATH)) fs.copyFileSync(ENV_PATH, ENV_PATH + '.bak');
  env = setValue(env, 'AUTH_USERNAME', username);
  env = setValue(env, 'AUTH_PASSWORD_HASH', hash);
  let madeSecret = false;
  if (!getValue(env, 'SESSION_SECRET')) {
    env = setValue(env, 'SESSION_SECRET', crypto.randomBytes(32).toString('hex'));
    madeSecret = true;
  }
  fs.writeFileSync(ENV_PATH, env);

  // Read it back from disk to prove it was saved.
  const saved = readEnv();
  const ok = getValue(saved, 'AUTH_USERNAME') === username && bcrypt.compareSync(pw1, getValue(saved, 'AUTH_PASSWORD_HASH'));
  if (!ok) {
    console.error('\nSomething went wrong saving .env. Your previous version is in .env.bak.');
    process.exit(1);
  }

  console.log(`\nSaved. Sign in as "${username}" with your new password.`);
  if (madeSecret) console.log('A SESSION_SECRET was also created (it was missing).');
  console.log('Your previous .env is backed up as .env.bak.');
  console.log('Restart the server (Ctrl+C, then npm start) for the new login to take effect.\n');
})();
