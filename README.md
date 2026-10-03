# Grove Sales Agent

A working, Vibeera-style AI sales agent: a small team of specialized agents
(lead qualifier, follow-up/nurture, appointment setter, content drafter) that
share one "Company Brain" per client and report to a single chat-style
command center - "send one line, get a day of work done."

Unlike Vibeera itself (a managed service Vibeera's team installs for you),
this is code you own outright, so it can become a real Webtech Design LLC
product: one codebase, a different `config/<client>.json` brain per
customer.

## What's actually here

- **Real, tested integration code** for Claude (Anthropic API) and
  GoHighLevel (LeadConnector API v2) - contacts, SMS/email sending, notes,
  opportunities.
- **DRY_RUN mode everywhere.** If `ANTHROPIC_API_KEY` or
  `GHL_API_KEY`/`GHL_LOCATION_ID` are missing, every agent still runs its
  full logic and logs exactly what it *would* have sent, instead of failing
  or faking success. That's how this was verified end-to-end in this
  session, without touching your live accounts - see the terminal output
  under "Verified" below.
- **Four agents:**
  - `leadQualifier` - scores a new lead against the ideal-customer profile,
    writes the first reply, flags anything that needs a human (compliance
    triggers, out-of-license states, complaints).
  - `followUp` - drafts nurture touches on a cadence, backs off in tone on
    later attempts instead of escalating pressure.
  - `appointmentSetter` - moves a warm lead to booking, or escalates instead
    of answering something only a licensed human should.
  - `contentDrafter` - turns one instruction ("draft 3 LinkedIn posts about
    X") into ready drafts, in brand voice, with `[ADD REAL NUMBER]`
    placeholders instead of invented stats.
- **A "Company Brain" per client** (`config/*.json`): business info, voice,
  offers, objection handling, and **hard guardrails** (things the agent must
  never say, and conditions that force a human handoff). `config/
  grove-financial.json` is filled in as a working example; `config/
  brain.example.json` is the blank template for the next client you sell
  this to.
- **A command center UI** (`public/index.html`) - Grove-branded, shows
  connection status, lets you type instructions, shows recent leads. Sits
  behind a username/password login (`public/login.html`), with a brute-force
  lockout after 5 failed attempts - see "Logging in" below.
- **SQLite storage** (`data/agent.db`, created automatically) - leads,
  every agent action, every command - so nothing only lives in a chat log.

## Why it's a prototype, not "done"

I don't have your Anthropic API key or your GoHighLevel credentials, and I
shouldn't guess at them or take real actions against your live GHL account
without you explicitly wiring it up. Everything above is real, working code
- it just runs in DRY_RUN mode until you add keys. That's a deliberate
design choice (see `.env.example`), not a placeholder for missing work.

The compliance guardrails in `config/grove-financial.json` reflect what Dr.
Grove and Gradient Advisors confirmed directly: marketing opens as a general
Grove Financial Group conversation (not a product pitch), the Gradient/IAR
disclosure only applies to communications that actually discuss investment
advisory services, and - critically - this system never auto-sends that
disclosure on any channel. `src/config/complianceGuard.js` enforces that in
code (not just in the prompt): any drafted message referencing Gradient
Advisors/investment advisory is blocked from auto-sending and handed back for
Dr. Grove to send personally, since Gradient requires him to be the one who
sends it (through their own platform, which does its own send-and-record).
The state-specific insurance advertising disclosure rules for AL, AZ, FL, SC,
and NC (`guardrails.stateInsuranceDisclosure` in the config) are now sourced
from each state's own insurance-department administrative code - separate
from the Gradient/IAR document, which only governs investment-advisory
content. AL, AZ, and SC are confirmed by direct citation; FL and NC almost
certainly carry the same core requirement but the exact clause text couldn't
be pulled from public mirrors, so it's worth a quick confirmation with Dr.
Grove's FMO/carrier compliance contact before treating those two as identical
to the other three. Separately, whenever a message names a specific Medicare
plan type (Medicare Advantage, Part D, Supplement/Medigap), the federal
CMS-required disclaimer is now enforced in code, not just the prompt -
`ensureMedicareDisclaimer()` in `src/config/complianceGuard.js` appends the
exact required language automatically if the model didn't include it.

## Getting it running

```bash
cd grove-sales-agent
npm install
cp .env.example .env
# Required before you can log in at all - see "Logging in" below:
npm run hash-password -- "your-real-password"
# paste the printed AUTH_PASSWORD_HASH line into .env, and set AUTH_USERNAME
# and SESSION_SECRET there too.
# edit .env: add ANTHROPIC_API_KEY to get real agent output instead of
# DRY_RUN stubs. Add GHL_API_KEY + GHL_LOCATION_ID when you're ready to
# connect to live GoHighLevel.
npm start
# open http://localhost:3000 - you'll land on the sign-in page first
```

## Logging in

The command center now requires a username and password - there's no login
until you set one. Three values in `.env` control it:

- `AUTH_USERNAME` - whatever you want to sign in as, e.g. `drgrove`.
- `AUTH_PASSWORD_HASH` - never a plain-text password. Generate it with
  `npm run hash-password -- "your-real-password"` and paste only the
  resulting hash into `.env`. The real password isn't stored anywhere.
- `SESSION_SECRET` - a random string that signs the session cookie. Generate
  one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

Until all three are set, login fails closed (nobody gets in, not "anyone gets
in") - that's deliberate. Five wrong password attempts locks that IP out for
five minutes. Sessions last 12 hours; "Sign out" in the top-right of the
command center ends yours immediately. If you deploy this behind a reverse
proxy (Render, Railway, etc.), also set `TRUST_PROXY=1` so secure cookies and
the lockout's IP tracking work correctly.

The machine-to-machine endpoints (`/webhook/lead`, `/webhook/ghl`, used by
GoHighLevel) are unaffected - they're still protected separately by
`WEBHOOK_TOKEN`, since GHL can't fill out a login form.

To see the whole pipeline run without starting a server at all:

```bash
node test/simulate.js
```

## Turning on the 24/7 follow-up scheduler

By default, follow-ups only go out when you type a command or a webhook
fires - nothing happens on its own. Set `AUTO_FOLLOWUP=true` in `.env` to
turn on the "always on" piece: the server checks, on a timer (hourly by
default; change it with `FOLLOWUP_SWEEP_INTERVAL_MINUTES`), which leads are
due for their next touch based on each brain's `agents.followUp.cadenceDays`
(Grove's default is 1, 3, 7, then 14 days after the last touch) and drafts -
and, once real GHL credentials are connected, sends - a follow-up
automatically. It uses the exact same code path and compliance guards as a
manual "follow up with X" command; nothing is special-cased for the
scheduler.

This is off by default on purpose: once GHL is connected for real, this is
the switch that turns unattended, automatic outbound messaging on. Turn it
on only once you're comfortable with what the follow-up agent drafts.

You don't have to wait for the timer to test it - type **"run follow-up
sweep"** in the command center (or send that as `instruction` to
`POST /command`) to trigger one pass immediately, regardless of whether
`AUTO_FOLLOWUP` is on.

## Verified this session (DRY_RUN, no live keys)

- `node test/simulate.js` ran the full pipeline - new lead -> GHL upsert ->
  qualification -> follow-up draft -> content draft -> command router - with
  no errors.
- `npm start` boots the server; `/health`, `POST /webhook/lead`,
  `POST /command`, `GET /api/leads`, and the static UI at `/` all responded
  correctly.
- The full login flow: unauthenticated `GET /` redirects to the sign-in page,
  `/api/leads` returns 401 without a session, a wrong password redirects
  back with an error, a correct one logs in and unlocks every protected
  route, five wrong attempts locks out even a correct password for five
  minutes, and "Sign out" fully clears the session.
- The compliance guard directly: a clean insurance-topic SMS passes through,
  a message mentioning "Gradient Advisors" is blocked on both SMS and email
  and handed back for manual send instead.
- The Medicare disclaimer guard directly: a message naming "Medicare
  Advantage" gets the required CMS disclaimer appended automatically; a
  message that already has it, or doesn't mention a Medicare plan at all,
  is left untouched (no double-appending, no false positives).
- The auto follow-up scheduler: a lead backdated to look overdue was
  correctly picked up by `runFollowUpSweep()`, drafted a follow-up, and had
  its attempt counter and next-due-date advanced; a second sweep immediately
  after correctly found nothing due. The command center's "run follow-up
  sweep" phrase routes correctly (verified it doesn't get shadowed by the
  "follow up with <name>" pattern, which an early version of the routing
  rule accidentally did).

## Connecting GoHighLevel for real

1. In GHL: **Settings > Business Profile > Private Integrations** -> create
   a token with scopes `contacts.readonly`, `contacts.write`,
   `conversations.write`, `conversations/message.write`,
   `opportunities.write`.
2. Put that token in `.env` as `GHL_API_KEY`, and your location ID as
   `GHL_LOCATION_ID`.
3. In a GHL workflow, add a **Webhook** action pointing at
   `https://<your-deployed-url>/webhook/lead` (for new leads) or
   `/webhook/ghl` (for events like appointment requests). While testing
   locally, use `ngrok http 3000` to get a public URL.
4. Set `WEBHOOK_TOKEN` in `.env` and pass it as `?token=...` or an
   `x-agent-token` header from GHL so random internet traffic can't hit your
   webhook.

## Deploying it

This is a plain Node/Express app with a local SQLite file - it runs on
Render, Railway, Fly.io, or any small VPS. It needs a persistent disk (or
swap SQLite for a hosted Postgres later) since `data/agent.db` holds your
lead history.

## Turning this into a sellable Webtech Design product

Each client is just a new `config/<clientId>.json` (copy
`brain.example.json`) plus their own GHL Private Integration token. The
agent code, command center, and database schema don't change per client -
that's the same "one brain per business" model Vibeera uses, but here it's
your own codebase rather than a service you'd be reselling.

Natural next steps, in rough priority order:
1. Confirm the exact Florida and North Carolina disclosure clause text with
   Dr. Grove's FMO/carrier compliance contact (see
   `guardrails.stateInsuranceDisclosure.status`) - Alabama, Arizona, and
   South Carolina are already confirmed by direct citation.
2. Add your real GHL pipeline/stage IDs so `createOpportunity` actually
   files qualified leads into your pipeline (it's wired up, just needs
   those IDs from your GHL account).
3. Once you're comfortable with what the follow-up agent drafts, set
   `AUTO_FOLLOWUP=true` to turn on the 24/7 scheduler (see "Turning on the
   24/7 follow-up scheduler" above) - it's built and tested, just off by
   default.
4. For a multi-user setup (more than just you signing in), swap the single
   hardcoded `AUTH_USERNAME`/`AUTH_PASSWORD_HASH` pair for a small users
   table - the `requireAuth` middleware and session wiring already do the
   hard part, this would just change what `verifyCredentials` checks against.
