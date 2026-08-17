# CLAUDE.md

## Writing rules for all user-facing text

Applies to every Discord message, embed, button label, error message and DM the bot sends.

### Process

Before writing any code that contains user-facing text, output the copy as **plain text in chat** and wait for approval. Do not write it into files first. Do not proceed until the wording is signed off.

### The core rule

**Every line must carry information.** If a sentence doesn't contain a fact, a number, a constraint, or an instruction the reader didn't already have, delete it.

Slop is not a matter of word choice. Slop is text that occupies space without telling the reader anything. A short sentence with no content is still slop.

Bad: `Post your edit, hit Submit, paste the link. That's it.`
(Says nothing they didn't already know. "That's it" is filler.)

Good: `Submit through the panel in #submit. Views update every 12 hours, so don't worry if it shows 0 at first.`
(Two facts: where to go, and why the number looks wrong.)

### How this server actually writes

Real examples from our announcements. Match this register:

- "It's been quieter than we'd like here recently, and we know it."
- "We're very close to landing several campaigns, but won't hype specific ones until they're signed and actually get going, since we'd rather wait till that happens than make empty promises."
- "PayPal only allow $100,000 per day, so the rest will come Monday and Tuesday."
- "Some campaigns going forward will be Core only, the higher profile, higher RPM ones."
- "Open Brief Edits (All Styles of Edits, Highlights NOT Allowed)"
- "Sorry for the pings, next one will be a campaign."

What those have in common:
- Specific numbers and named constraints
- Admits problems directly instead of spinning them
- Explains the reason behind a rule, not just the rule
- Sounds like a person typing, not a brand voice

### Banned

- Em dashes. Use commas, full stops, or brackets.
- "seamless", "elevate", "unlock", "empower", "dive in", "journey", "leverage", "robust", "streamline", "game-changer", "unleash", "showcase", "effortless"
- "It's not just X, it's Y"
- "Whether you're X or Y..."
- "That's it!" / "Simply..." / "Just..." as sentence padding
- Sign-off encouragement: "Good luck!", "Let's go!", "Can't wait to see what you make!"
- Restating the button label as the description ("Submit Edit — submit your edit")
- Rule-of-three lists where two items would do
- Rhetorical questions as openers

### Required

- Lead with the fact. No warm-up sentence.
- Use exact numbers, dates and channel names. Never "soon", "shortly", "a lot".
- Explain *why* a rule exists when the reason isn't obvious. Rules with reasons get followed.
- State limitations plainly. If Instagram views are counted by hand, say so.
- Emoji only as a line-leading label, never mid-sentence.
- Second person, active voice. "You get paid per 1,000 views", not "Payment is issued on a per-view basis."

### Button and panel descriptions

One line. Say what happens when it's pressed, including anything non-obvious.

Bad: `Submit Edit — Submit a TikTok edit to a campaign.`
Good: `Submit Edit — Pick a campaign, paste your link.`

Bad: `Check Balance — View your current balance.`
Good: `Balance — Pending, cleared, and what you've been paid.`

### Error messages

Say what went wrong and what to do about it. Never apologise on behalf of the user.

Bad: `Oops! Something went wrong. Please try again later.`
Good: `TikTok didn't respond. Wait a minute and resubmit. If it keeps failing, open a ticket.`

---

## Technical rules

- Run `node --check` on every file changed before committing. Do not commit a file that fails.
- Never hardcode a Discord ID outside `config.js`.
- Never delete a submission record. Mark it rejected so the audit trail survives.
- Staff-only handlers must call `requireStaff()` at runtime. Slash command permissions are a UI hint, not a security boundary.
