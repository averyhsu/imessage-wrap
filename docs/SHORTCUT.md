# iPhone-only route (experimental): a Shortcut that reads the chat

**Status: experimental and unverified.** This route cannot be tested without a real iPhone
on iOS 26.4 or later, and none was available during the build. Everything below is a
recipe plus the 10-minute test that tells us whether it works for group chats. Until the
owner has run that test, nothing in the product claims this route works.

## Why it might work

iOS gives apps no API to read Messages, but iOS 26 added two actions to the **Shortcuts**
app — **Find Conversations** and **Find Messages** — and iOS 27 added filtering by sender
and group-chat support for **Send Message**
([research note 02](research/02-ios-history-apis.md)). A shortcut the user runs themselves
can therefore read message rows on the phone and hand them to our web page, which computes
the recap locally in Safari. No computer, no app install, nothing uploaded.

What we do not know yet:

| Question | Why it matters |
|----------|----------------|
| Does Find Messages return the **sender of each message in a group chat**? | Without it there are no top senders or awards. |
| What does it return for **your own** messages (empty, "Me", your name)? | Needed to label the owner. |
| How long does a year of a busy group chat take? | One export app quotes ~20 minutes per chat-year. |
| Are tapbacks exposed at all? | Probably not; "message of the year" would be missing in this mode. |
| Does it return everything, or only what iOS has on the device? | With Messages in iCloud, older messages may not be local. |

## What the web page accepts

`make/` has an "From an iPhone Shortcut or export app" input. It accepts pasted text or a
file in any of these shapes (see `web/make/import-rows.js`):

1. **Columnar** (fastest for a shortcut — no loop needed):
   ```
   #dates
   2026-03-14T21:41:07-07:00
   2026-03-14T21:41:30-07:00
   #senders
   Maya
                     ← an empty line means "sent by me"
   ```
   The two lists must have the same number of lines. No message text ever leaves Messages
   in this mode, so word counts are zero and there is no "message of the year".
2. **JSON Lines** — one object per line: `{"date": "...", "sender": "...", "text": "..."}`.
3. **JSON array** of the same objects.
4. **CSV / TSV with a header row** — columns are detected by name (`date`/`timestamp`,
   `sender`/`from`, `text`/`message`/`body`, optional `direction`/`is_from_me`). This is the
   shape third-party export apps produce.

## The shortcut recipe (columnar mode)

Build it once in the Shortcuts app; action names are as Apple lists them for iOS 26/27 and
may differ slightly on your version.

1. **Find Conversations** → then **Choose from List** (prompt: "Which group chat?").
2. **Find Messages** where *Conversation* **is** *Chosen Item* and *Date* **is in the last**
   *1 year*. Sort by *Date*, oldest first. No limit.
3. **Text** action, containing exactly:
   ```
   #dates
   [Messages ▸ Date ▸ Date Format: ISO 8601, include time]
   #senders
   [Messages ▸ Sender ▸ Name]
   ```
   (Tap the *Messages* variable, choose the property, and Shortcuts inserts one line per
   message.)
4. **Copy to Clipboard** (the Text).
5. **Open URL** → `https://averyhsu.github.io/imessage-wrap/make/#paste`
6. On the page, tap **Paste**, check the diagnostics line (message count, first and last
   date), then **Create recap**. The page gives you the story and a link to send to the chat.

If step 3 cannot produce one line per message for *Sender*, fall back to a loop: **Repeat
with Each** message → **Dictionary** {`date`: Date (ISO 8601), `sender`: Sender,
`text`: Content} → **Add to Variable**; after the loop put the variable in a Text action
(one JSON object per line) and continue from step 4. Slower, but it also carries the text.

## The 10-minute device test (owner)

On an iPhone running iOS 26.4+ (ideally 27):

1. In Shortcuts, add **Find Messages** filtered to one *group* conversation, limit 20, then
   **Quick Look**. Note which properties each result offers: Date, Sender, Content, anything
   about tapbacks or attachments.
2. Check a message *you* sent: what is its Sender?
3. Remove the limit, run it on a chat with a few thousand messages, and time it.
4. Build the recipe above and paste into the page. Does the diagnostics line match what you
   see in Messages (count, first date, last date)?
5. Report back the four answers (sender in groups? own-message sender? seconds per 1,000
   messages? count matches?). If sender works, this becomes the headline iPhone path and
   the recipe can be shared as a one-tap iCloud link.

## A bonus the same building blocks allow: `/wrapped` on an iPhone

Shortcuts' personal automation "When I get a message containing `/wrapped`" can run without
confirmation (iOS 17+), and on iOS 27 **Send Message** can target a group chat. So one phone
can answer `/wrapped` in one chosen chat by sending a recap link that was prepared earlier.
It is a demo flourish for a single chat, not a general product: the trigger does not tell
the shortcut which group the message came from (**unverified**), and the link is whatever
was computed last.
