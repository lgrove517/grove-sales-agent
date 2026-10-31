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

## Phase 1: booking sequence (opt-in leads only)

Turned on per client with `bookingSequence` in its brain file (on for Grove
Financial Group; see `src/config/bookingSequence.js` for every setting).

**Who gets it.** Only people who asked to hear from the business: a form,
a referral, a RetireFlo survey, or a contact tagged `opt-in` (also
`requested-info`, `referral`, `retireflo`, or an `opt_in = yes` field). A
list import or an old CRM contact sent to the agent is assessed but **not
contacted** - it gets a note and the `sales-agent-no-opt-in` tag. A `DND` /
`do-not-contact` tag always wins.

**What it sends.** Day 0: the first reply (email when there is an email).
Day 1, 3, 7: follow-ups (email, text, email). Every message is short,
personal (first name + what they asked about), and carries **one link** -
the scheduling page (`landingPageUrl`, default `bookingLink`). Any link the
AI writes is removed and the scheduling link is added in code. Texts only go
to contacts with text consent (`sms-opt-in` tag or `sms_consent` field);
otherwise that step goes by email. Texts end with "Reply STOP to opt out";
emails get the sign-off, an unsubscribe line and the CAN-SPAM address. The
usual compliance checks (investment topics, Medicare disclaimer, separation
rules) still hold anything that trips them. Sends only inside `sendWindow`
(GFG: 9 AM - 7 PM Central, Monday - Saturday).

**When it stops.** The moment the person books (`/webhook/status?status=booked`),
replies (`/webhook/reply` - from then on it's a conversation), or opts out
(a STOP/unsubscribe reply or `/webhook/status?status=opted_out`). A held
message or an error pauses that one lead and leaves a note on the contact.

**Tracking.** Set `PUBLIC_BASE_URL` (e.g. your Railway URL, or better a
custom domain like `go.grovefinancialgroupinc.com` pointed at Railway) and
each link becomes `/go/<code>`: the click is counted, then the visitor goes
to the scheduling page with UTM tags. Emails also carry a 1x1 open pixel
(`/o/<code>.gif`; opens are approximate). Known email link scanners are not
counted. Without `PUBLIC_BASE_URL`, links go straight to the page with UTM
tags and only GHL/analytics see the clicks. Bookings are credited to the
last message the person clicked (or the last one sent).

**Cost per booked appointment.** Type `spent $250 on Facebook in November`
in the command center (or `POST /api/spend { brand, month: "2026-11",
source, amount }`). Leads whose source contains that name count toward it.
Then type **`booking report`** (or `booking report October`) for the funnel:
opted-in leads -> started -> sent -> opened -> clicked -> booked, results by
step, and cost per lead / per booked appointment by source. In review mode
the report counts drafts and says so.

**GoHighLevel setup for Phase 1**
1. Each opt-in form's workflow (Form Submitted): add tag `opt-in`; if the
   form's SMS consent box is checked, add `sms-opt-in`; then add
   `send-to-sales-agent` (the existing "Sales Agent - New Lead" workflow
   takes it from there). Do the same for referral and RetireFlo entry points.
2. Keep "Sales Agent - Reply" and "Sales Agent - Booked" published (they
   stop the sequence).
3. Add an opt-out workflow: trigger "Contact DND" (or tag `unsubscribed`) ->
   Webhook `POST /webhook/status?status=opted_out&token=...`.
4. Set `PUBLIC_BASE_URL` on Railway. Leave `GHL_SEND_MODE=review` until the
   sequence wording is approved; `AUTO_FOLLOWUP=true` runs the day 1/3/7
   steps (hourly by default).

Leads that were in the system before Phase 1 have no sequence and are not
followed up automatically on a client with the sequence on. Re-tag them
`opt-in` + `send-to-sales-agent` if they asked to hear from you.

Tests: `node test/bookingSequence.test.js` (no keys needed; starts the
server on a spare port and drives the webhooks).

## Income plan and booking credit

**`income plan $120,000`** works backward from an income goal: sales needed
(average commission) -> appointments held (close rate) -> appointments booked
(show rate) -> opted-in leads (booking rate), per month, week and workday,
then compares that with the last 30 days. Add your own numbers in the same
line ("with average commission $1,800, close rate 35%, show rate 75%, booking
rate 20%"); they are saved per client and reused. Every rate says where it
came from, and any starting assumption is labeled as one. Once 30+ opted-in
leads exist from the last 90 days, the booking rate comes from the agent's own
results automatically. No AI call, nothing sent. Open to every package. Test:
`node test/incomePlan.test.js`.

**By line of business.** Name the line and the plan uses that line's
economics instead of an average commission: life insurance (% of annual
premium), annuities and LTC (% of premium; the goal can be income or premium
written: "income plan $2M annuity premium at 6%"), Medicare new-to-Medicare
or plan change (flat first-year payout, plus the monthly renewals those
clients add), AUM ("income plan $1M AUM next quarter": the goal stays in
assets; it shows what they pay after fee and payout, and the break-even on
fixed advisory costs), and planning fees. Each client's real payouts live in
`incomePlan.lines` in its brain file (never shown to leads or sent to the AI);
funnel rates typed for a line are saved for that line. An AUM plan is
arithmetic only: the agent still never discusses investments with leads.

**Who earned each booking.** When GHL reports a booking
(`/webhook/status?status=booked`), the contact is also tagged
`sales-agent-booked-by-agent` if a message the agent actually sent (not a
review-mode draft) or a completed AI call came first, otherwise
`sales-agent-booked-by-you`. The booking report shows both counts.

## Agency plan and agency referrals (the Medicare front door)

A team of Medicare agents meets thousands of people turning 65. The few who
raise retirement income, a CD or an annuity are introduced to the advisor at
a **separate** appointment. Three commands support that model:

- **`agency plan 6 agents, 250 cases each`** projects it year by year: Medicare
  cases -> introductions (referral rate) -> new advisory clients (close rate)
  -> new assets (average account) -> the advisory book after market growth
  and outflows -> what it pays (fee x payout), plus the Medicare renewal base.
  Add any number in the same line ("10% referral rate, 30% close rate, average
  account $175,000, starting AUM $100,000, 4% growth, outflows 5%, 15 years");
  typed numbers are saved per client. Defaults come from `incomePlan.agency`
  and `incomePlan.lines.aum` in the brain file; the rest are labeled
  placeholders. It ends with the compliance rules: no product talk at a
  Medicare appointment, no paid advisory referrals without Gradient approval.
- **`Marcus wrote 22 Medicare cases in November`** records an agent's cases.
- **`referral scorecard`** (or `... this year`, `... last month`) shows, per
  agent: cases, clients referred (and the referral rate), booked, and became
  clients.

**Referral intake (`/webhook/referral`).** In GHL: an "Agency Referral" form
(client name, phone/email, referring agent, what they asked about, and a
consent line that the client agreed to be contacted), then a workflow
"Sales Agent - Agency Referral": Form Submitted -> Webhook POST to
`/webhook/referral?token=...&brand=grove-financial` with custom data
`contact_id`, `referred_by`, `interest`. The agent records the referring
agent, tags `sales-agent-agency-referral` + `sales-agent-needs-you`, adds a
note, holds the booking sequence and cancels any scheduled AI call. **It never
messages a referral** - you or your staff schedule the separate appointment
personally. Bookings and wins flow in through `/webhook/status` as usual (a
booking you make is credited `sales-agent-booked-by-you`). Test:
`node test/agencyReferrals.test.js`.

## Phase 2: AI caller (consented form leads only)

One short AI phone call to a new opted-in lead, to hear their tone and intent
and offer a free conversation with Leon. Settings: `aiCaller` in the brain
file (`src/config/aiCaller.js` lists every option); type **`show call
script`** in the command center to review the script.

**Who is called** - all must be true: the lead started the booking sequence
(Phase 1 opt-in), has **documented call consent** (tag `ai-call-consent` or a
`call_consent = yes` field - text/email opt-in alone is not enough), has a
phone number, and is **not a Medicare lead** (Medicare calls are recorded and
need the CMS disclaimer in the first minute, so Leon makes those).

**When** - only 10 AM - 6 PM, Monday - Friday, in the **lead's own time
zone** (from their state; unknown state = noon - 5 PM Central). A form filled
at 2 AM is called at the next window. Small volume: 5 calls per 24 hours, 2
tries per lead (a no-answer is retried once on another day), never for a lead
more than 3 days old. A reply, booking or opt-out cancels a scheduled call.

**Human review** - nothing dials until Leon has reviewed the script, pasted
it into the GHL Voice AI agent, and set `AI_CALLER_APPROVED=true`. Even then,
review mode only notes "AI CALL READY" on the contact; calls dial with
`AI_CALLER_LIVE=true` (calls only, emails/texts stay drafts) or
`GHL_SEND_MODE=live`.

**After the call** - GHL posts the result to `/webhook/call`; the agent
reads the summary/transcript, notes outcome, tone, timeline and next step on
the contact, and tags it (`sales-agent-call-wants-to-book`,
`-interested-later`, `-not-interested`, `-no-answer`...). "Stop calling me"
stops all calls, texts and emails. A 401(k)/IRA/pension mention is tagged
`gwm-investment-inquiry` for Leon. The booking report shows an AI calls
section.

**GoHighLevel setup for Phase 2**
1. Complete Voice AI KYC (ID verification) and create an outbound Voice AI
   agent. Paste the script's opening, questions, offer, closing and rules
   into its instructions. Set voicemail to hang up (no voicemails in Phase 2).
2. On each opt-in form, add a separate call-consent checkbox with GHL's
   required AI-call consent wording. In the form workflow: if checked, add
   tag `ai-call-consent`.
3. New workflow "Sales Agent - AI Call": trigger Contact Tag Added
   `sales-agent-ai-call` -> action **Voice AI Outbound Call** (the agent above)
   -> Webhook `POST /webhook/call?token=...` with custom data `call_status`,
   `call_summary`, `call_transcript`, `recording_url` (map the call fields
   GHL offers) -> remove tag `sales-agent-ai-call`.
4. Railway: `FOLLOWUP_SWEEP_INTERVAL_MINUTES=15` (calls go out within 15
   minutes of their time), `AUTO_FOLLOWUP=true`, then `AI_CALLER_APPROVED=true`
   after the script review, and `AI_CALLER_LIVE=true` when ready to dial.

Tests: `node test/aiCaller.test.js`.

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

This is a plain Node/Express app with a local SQLite file. It runs 24/7 on
Railway (the current host); it would also run on Render, Fly.io, or a small
VPS. It needs a persistent disk since `agent.db` holds your lead history and
login sessions.

### Railway checklist

`railway.json` in this repo already sets the start command, a health check
on `/health`, and auto-restart if the app crashes. In the Railway dashboard:

1. **Node version:** `package.json` pins Node 22 (`better-sqlite3` 13 will
   not build on anything older). Nothing to set - Railway reads it.
2. **Volume (required):** Service > Settings > Volumes > add a volume
   mounted at `/data`. Without it, every redeploy wipes the lead database
   and signs you out.
3. **Variables** (Service > Variables):
   - `DATA_DIR=/data` - puts the database on that volume
   - `NODE_ENV=production` and `TRUST_PROXY=1`
   - `SESSION_SECRET`, `AUTH_USERNAME`, `AUTH_PASSWORD_HASH`, `WEBHOOK_TOKEN`
   - `ANTHROPIC_API_KEY`, `GHL_API_KEY`, `GHL_LOCATION_ID`
   - `GHL_SEND_MODE=review` (drafts only) until you are ready to go live
   - `PUBLIC_BASE_URL` (this app's public address) so booking-sequence links and opens are tracked
   - `AUTO_FOLLOWUP=false` until you are ready for the 24/7 scheduler
   - `RETIREMENT_WORKFLOW_APPROVED=false` until Gradient approves it
   - `MEDICARE_QUOTING_APPROVED=false` until compliance clears the Medicare quoting link
   - Do NOT set `PORT` - Railway supplies it.
4. **Check it:** open `https://<your-railway-url>/health`. You should see
   `"ok": true`, both integrations configured, and the list of
   compliance-gated `workflows` with their on/off state. The same status
   shows in the command center header after you sign in.

### More than one client

Each client is one file in `config/` (Grove Financial Group is
`grove-financial.json`, Webtech Design is `webtech-design.json`). The
command center's **Client** menu switches between them; webhooks pick one
with `"brand": "<file name>"` in the body or `?brand=` in the URL, and
anything without one uses `DEFAULT_BRAIN`.

- **Separate GoHighLevel accounts.** A client file with a `"ghl"` block
  (`apiKeyEnv`, `locationIdEnv`) uses only those variables; if they're not
  set, that client runs in dry-run and never falls back to another
  client's account. A file without one uses `GHL_API_KEY` /
  `GHL_LOCATION_ID`.
- **Financial guards.** The Gradient / Grove Wealth Management investment
  guards are on for every client unless its file says
  `"compliance": { "financialAdvisoryGuards": false }` (Webtech does).
- **Follow-up scheduler.** The 24/7 sweep runs for `DEFAULT_BRAIN`, or for
  every client listed in `SCHEDULER_BRAINS` (comma-separated, e.g.
  `grove-financial,gfg-agency`).
- **Shared GoHighLevel account.** Replies and status updates for a contact
  the agent already worked use that contact's own client file, so Grove
  Financial Group and its agency can share one "Customer Replied" workflow.

### Compliance on/off switches

Offers in `config/<clientId>.json` can carry an `"approvalFlag"`. Any offer
with one stays off - the agents never see it - until that environment
variable is set to `true`. To turn the Retirement Income Conversation on
after Gradient approves it: Railway > Variables >
`RETIREMENT_WORKFLOW_APPROVED=true`. Railway restarts the service and it is
live; no code change needed. Use the same pattern for the Medicare, LTC, Principal Protection Strategies (formerly "CD")
and IUL workflows when they are added.

**Medicare quoting link** (`medicareQuoting` in `grove-financial.json`,
flag `MEDICARE_QUOTING_APPROVED`). When on, agents may give Medicare leads
one of the 2027 plan-comparison sites (SMA primary, PlanEnroll second) alongside the booking link. Code holds any
draft with the link that goes to a lead with no Medicare interest (their
message or a Medicare tag), uses a link not on file or both links at once, or names a carrier, and
the county disclaimer is always appended. Check with
`node test/medicareQuoting.test.js`.

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
