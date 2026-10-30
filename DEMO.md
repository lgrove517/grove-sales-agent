# Sales Demo: Magnolia Key Realty (Demo)

A made-up real estate team for showing prospects the AI Sales Agent live,
without opening Grove Financial Group or any client's real leads.

- **No real data.** Every name, email (@example.com) and phone (555-01xx) is fictional.
- **Nothing is ever sent.** The demo has no GoHighLevel connection, so it always
  runs in dry-run: the agent reads, assesses and drafts live, but no message,
  tag or note reaches anyone.
- **Can't touch real clients.** Reset and the live-lead button refuse to run on
  any client not marked `"demo": true`.

## Files

| File | What it is |
|---|---|
| `config/demo-realty.json` | The demo company's brain (offers, voice, Fair Housing guardrails) |
| `src/demo/demoData.js` | 10 sample leads in every stage, 4 ready-made live inquiries, reset |
| `server.js` | Demo routes, sample leads loaded on startup, dry-run fix |
| `public/index.html` | "Demo mode" panel, shown only when the demo client is selected |

## One-time setup (Webtech's Railway service)

1. Upload the four files to GitHub in their folders (config, src/demo, root, public).
2. In Railway, open Webtech's service (`marvelous-rejoicing`) and check **Variables**:
   - **ALLOWED_BRAINS**: if it's set, add `demo-realty` to the list (for example
     `webtech-design,demo-realty`). If it's blank, leave it.
   - Make sure **DEMO_GHL_API_KEY** and **DEMO_GHL_LOCATION_ID** do **not** exist.
   - Do **not** add `demo-realty` to **SCHEDULER_BRAINS**.
3. Let it redeploy. The 10 sample leads load automatically on first start.
4. Open the Webtech dashboard and pick **Magnolia Key Realty (Demo)** in the Client menu.
   The gold "Demo mode" panel appears at the top.

## Before each presentation

1. Select **Magnolia Key Realty (Demo)**.
2. Click **Reset demo**. This brings back the 10 sample leads and clears anything
   from the last demo.
3. Set **Package** to **Premium**.

## Talk track (about 10 minutes)

**1. Open on their pain (1 min).** "How fast do you reply to a new lead today?
What happens to the ones that come in at 9 PM?"

**2. "Since your last visit" (2 min).** This is what the agent did overnight:
new leads, good fits, follow-ups drafted. Point to **Waiting on you**:
- **Marcus Webb** wants to make an offer. The agent knows offers and
  negotiation belong to a person, so it handed him off instead of answering.
- **Denise Carter** asked which neighborhoods are "safest for families." That's
  a Fair Housing trap. The agent didn't touch it and flagged it for an agent.
  *"It knows what it's not allowed to say."*

**3. A live lead (2 min).** Click **Send a live demo lead**, or better, ask the
prospect to type an inquiry in the box (for example, "Pre-approved, want a
3 bedroom in Daphne by summer"). In a few seconds they see the assessment, the
reason and the drafted reply. Try one of the tricky ready-made inquiries too:
an offer below asking, or a "safe neighborhoods" question.

**4. Ask it to work (2 min).** In **Send an instruction**, type:
- `draft 3 Facebook posts for first-time buyers`
- `build the December social calendar` (downloads a file ready for GoHighLevel)
- `how can I get more appointments?`

**5. Show the packages (1 min).** Switch **Package** to **Growth**, then
**Starter**, so they see what each level does. Switch back to **Premium**.

**6. Close (1 min).** "Today you saw review mode: everything is a draft until
you approve it. When you're comfortable, it starts replying for you." Then book
the free systems review.

## Notes

- The demo's ready-made replies and sample leads are fixed text, so they look
  the same every time. Live leads use Claude, so they cost a few cents each.
- Live leads stay until you click **Reset demo**.
- To add another market later (CPA, dental, nonprofit), copy
  `demo-realty.json` to a new file, set `"demo": true`, and add sample leads
  for it in `src/demo/demoData.js`.
