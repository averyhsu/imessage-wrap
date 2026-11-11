# Shared contract: stats schema, link payload, embed bridge

Every component (Python engine, in-browser engine, web story, iOS extension) speaks this
contract. If you change it, bump `v` and update every consumer in the same commit.

## 1. Stats JSON (`v: 1`)

```jsonc
{
  "v": 1,
  "chat":   { "name": "Sunday Dinner Club", "members": 7 },
  "period": { "label": "2026", "start": "2026-01-01", "end": "2026-11-10" },

  "totals": {
    "messages": 48213,        // countable messages (see §2), never tapbacks or system events
    "words": 251034,
    "attachments": 3120,      // countable messages that carry at least one attachment
    "reactions": 9120,        // tapbacks still standing at the end of the period
    "days_active": 301,       // distinct local calendar days with >= 1 message
    "longest_streak": 87      // longest run of consecutive active days
  },

  "by_hour":    [/* 24 ints, index = local hour 0..23 */],
  "by_weekday": [/* 7 ints, index 0 = Monday .. 6 = Sunday */],
  "by_month":   [/* 12 ints, index 0 = January .. 11 = December, summed over the period */],

  "busiest_day": { "date": "2026-07-04", "messages": 612 },

  "personality": {
    "id": "night_owls",               // see §3
    "title": "The Night Owls",
    "blurb": "Peak hour: 11 PM. Sleep is a suggestion.",
    "peak_hour": 23
  },

  "late_night": {                     // local hours 0..4 inclusive (midnight to 4:59 AM)
    "messages": 4012,
    "share": 0.0832,                  // of totals.messages, rounded to 4 decimals
    "top": { "name": "Sam", "messages": 1201 }   // null if no late-night messages
  },

  "senders": [                        // sorted by messages desc, then name asc; max 12 entries
    {
      "name": "Sam",
      "messages": 12004,
      "share": 0.249,                 // of totals.messages, rounded to 4 decimals
      "words": 61200,
      "attachments": 410,
      "late_night": 1201,
      "reactions_given": 2100,
      "reactions_received": 1850
    }
  ],

  "most_reacted": [                   // top 3 by standing tapbacks; ties: earlier date first
    {
      "sender": "Maya",
      "reactions": 14,
      "date": "2026-03-14",
      "text": "…",                    // truncated to 180 characters (plus "…")
      "kinds": { "laugh": 7, "love": 5, "emphasize": 2 }
    }
  ],

  "reactions": {
    "by_kind": { "love": 0, "like": 0, "dislike": 0, "laugh": 0, "emphasize": 0, "question": 0, "emoji": 0 },
    "top_giver":    { "name": "Priya", "count": 2100 },   // null if no reactions
    "top_receiver": { "name": "Sam",   "count": 1850 }    // null if no reactions
  },

  "awards": [                         // 0..6 entries, see §4
    { "id": "yapper", "emoji": "🗣️", "title": "The Yapper", "winner": "Sam", "detail": "12,004 messages. Nobody asked." }
  ],

  "meta": { "generator": "wrapped/1", "source": "chat.db", "generated": "2026-11-11" }
}
```

Consumers must tolerate missing optional sections (`awards`, `reactions`, `late_night.top`,
`most_reacted` may be empty or absent) and must ignore unknown keys.

### Legacy input
The original prototype emitted `messages_by_hour` (`{"0": 1268, …}`), `messages_by_weekday`,
`messages_by_month`, and `most_reacted: [{sender, reactions, date, text}]`. The web story's
`normalize()` accepts those keys and maps them onto `by_hour` / `by_weekday` / `by_month`.

## 2. Counting rules (both engines must agree exactly)

Input is the Messages SQLite schema (`chat.db` on a Mac, `sms.db` in an iPhone backup).

- **Group chats** are `chat` rows with `style = 43`. Chat name = `display_name` if non-empty,
  else the first three first-names of members joined with `, ` plus ` & N more` when needed.
- **Messages of a chat** come from `chat_message_join`. Several `chat` rows can share the
  same `chat_identifier`/group (iMessage + SMS variants); rows with the same non-empty
  `chat_identifier` are merged into one logical chat.
- **Timestamp**: `message.date` is time since 2001-01-01 UTC, in nanoseconds when the value
  is larger than 10^11, otherwise in seconds. Unix seconds = value / 10^9 + 978307200.
  All bucketing uses the **local time zone of the computing device** (overridable by an
  explicit IANA zone for tests).
- **Period**: `[start, end]` local dates, inclusive. Default: the current calendar year, or
  the previous calendar year when run in January.
- **Tapback rows** have `associated_message_type` in 2000..2007 (added) or 3000..3007
  (removed). Kinds: 2000 love, 2001 like, 2002 dislike, 2003 laugh, 2004 emphasize,
  2005 question, 2006 emoji, 2007 sticker (reported as `emoji`). Removal = kind + 1000.
  The message a tapback belongs to is `associated_message_guid` with everything up to and
  including the last `/` or, if there is no `/`, the first `:` stripped (`p:0/GUID`,
  `bp:GUID` → `GUID`). The state, however, is kept **per message part**: its key is the
  whole unstripped value, so a tapback on the photo (`p:0/GUID`) and one on the caption
  (`p:1/GUID`) of the same message are two tapbacks. Process tapback rows in chronological
  order (ties by ROWID): an *add* sets `state[(part, reactor)] = kind`, a *remove* deletes
  it. What is left at the end of the period is "standing"; a message's count is the sum
  over its parts. Only tapbacks on countable messages inside the period count. Tapback rows
  are never counted as messages.
- **Countable message**: `item_type = 0` (or NULL), `associated_message_type` NULL or
  < 1000, and it has text or an attachment (`cache_has_attachments = 1`). Rows with no text
  and no attachment (unsent/empty) are skipped.
- **Text**: `message.text` when non-empty, otherwise the string decoded from
  `attributedBody` (typedstream). Remove U+FFFC and U+FFFD, then trim. **Words** = number of
  whitespace-separated tokens.
- **Sender**: `is_from_me = 1` → the owner (display name supplied by the user, default
  `"Me"`; the command-line tool and the Mac helper default to the first word of the Mac
  account's full name, `id -F`, and say so). Otherwise `handle.id` via `message.handle_id`,
  mapped through the contact-name table when one is available (phones compared on their last
  10 digits, e-mails case-insensitively), else the handle itself. Either way the result is a
  **sender label**: cleaned, capped and masked (below). Senders that resolve to the same
  display name are merged. `chat.members` = number of distinct senders seen plus members in
  `chat_handle_join` that never spoke (owner included).
- **Clean names**: every name that reaches the stats (chat name, contact name, handle,
  imported sender, the owner's name) is cleaned first: `\t`, `\n`, `\r` become a space; the
  characters U+0000–001F, U+007F–009F, U+200E, U+200F, U+202A–202E, U+2066–2069, U+FEFF,
  U+FFFC and U+FFFD are removed; runs of spaces collapse to one; the result is trimmed.
  (Zero-width joiners, non-joiners and variation selectors stay: emoji and several scripts
  need them.) A name that is empty afterwards is `Unknown` (`Unnamed group` for a chat).
  **Length**: only the first 1,024 characters (Unicode code points) of a name are looked at.
  After cleaning, a chat name longer than 80 characters is cut to 80 plus `…`, and a
  person's name longer than 40 to 40 plus `…` (never inside a surrogate pair). The cut comes
  before masking, so a masked label is never cut. A chat name built from its members and
  `period.label` are held to 80 as well, `meta.source` to 40.
- **Masking**: a recap is made to be shared, so a raw phone number or e-mail address never
  goes into the stats, the link, the card, a log or a chat's name. The rule applies to every
  sender label: a handle, an imported sender, the owner's name, and a name from the contact
  table too, because people do save contacts under a number or an address
  (`Dr. Okafor 555-010-0403` → `…0403`, a card named `jane.doe@example.com` → `jane.doe`):
  1. **E-mail**: if the label contains an address, meaning a run of characters around an
     `@` with at least one character on each side, where a run ends at whitespace or any of
     `< > ( ) [ ] " ' , ; :`, the label becomes the part of that run before the `@`, cut to
     16 characters plus `…` when longer (`Jane Doe <jane.doe@example.com>` → `jane.doe`,
     `mailto:jane@localhost` → `jane`). `Maya @ work` has no such run and is kept.
  2. **Phone**: otherwise, if the label contains 7 or more decimal digits in total (any
     Unicode decimal digit, so full-width digits count), whatever stands between or around
     them, the label becomes `…` plus its last four digits as written
     (`tel:+1 555-010-0123 (mobile)` → `…0123`, `Maya +15550100123` → `…0123`).
  3. Anything else (a name from an imported export, a short code) is kept.
  A **chat's own name** is masked too, so a group somebody named after a phone number does
  not publish it, but with a stricter test for step 2, because people put years and counts
  in chat names on purpose ("Class of 2026-2027"): the name is masked only when one stretch
  of digits joined by spaces, `+ - ( ) .` or dashes holds 10 or more digits, or 7 or more
  after a `+`. Step 1 (e-mail) is the same. Two unnamed people whose numbers end in the
  same four digits are merged; the maker page lets the user rename people, which avoids
  that.
- **Short names**: contact names are the owner's private labels ("Dave plumber"), so what
  users see by default is the short form. `shortNames(stats)` / `short_names(stats)` returns
  a copy of a finished stats object in which every person's name (in `senders`,
  `late_night.top`, `most_reacted[].sender`, `reactions.top_giver`, `reactions.top_receiver`
  and `awards[].winner`) is replaced consistently:
  - the owner's own name and masked labels (starting with `…`) are unchanged;
  - otherwise the short form is the first whitespace-separated word;
  - if two different people in the recap would get the same short form, each of them gets
    the first word, a space, the first character of their last word and a `.` (`Sam R.`);
    if that still collides, those people keep their full names.
  The rule works on sender labels: every name is cleaned, capped and masked again first
  (which changes nothing for names `computeStats` produced), so a short form never brings
  back a number or an address that a stats object from somewhere else still holds.
  The command-line tool (`stats`, `link`), the Mac helper and the maker page apply it unless
  asked not to (`--full-names`; an editable list on the maker page). `computeStats` itself
  returns full names, so merging by display name and the conformance suite are unaffected.
- `senders` keeps the top 12; the rest are dropped from the list (totals still include them).
- Rounding: shares are rounded to 4 decimals, half up: `Math.round(x * 10000) / 10000` in
  JS and `math.floor(x * 10000 + 0.5) / 10000` in Python, so both engines agree.

## 3. Personality (deterministic)

Let `H` = `by_hour`, `T` = total messages, `peak_hour` = index of max(H) (lowest index wins
ties), `weekend_share` = (Sat + Sun) / T, `night_share` = sum(H[0..4]) / T.
First rule that matches wins:

| # | Rule | id | title | line |
|---|------|----|-------|------|
| 1 | T < 50 | `quiet_ones` | The Quiet Ones | Few words. All of them count. |
| 2 | night_share >= 0.12 or peak_hour in 0..4 | `night_owls` | The Night Owls | Sleep is a suggestion. |
| 3 | weekend_share >= 0.42 | `weekend_warriors` | The Weekend Warriors | Weekdays are for recovering. |
| 4 | max(H) / T < 0.065 | `always_on` | The Always-On Group Chat | There is no off switch. |
| 5 | peak_hour in 5..8 | `early_birds` | The Early Birds | Texting before coffee is a choice. |
| 6 | peak_hour in 9..11 | `morning_meeting` | The Morning Meeting | This could not have been an email. |
| 7 | peak_hour in 12..13 | `lunch_break` | The Lunch Break Legends | Eating with one hand, typing with the other. |
| 8 | peak_hour in 14..17 | `afternoon_slackers` | The Afternoon Slackers | Peak productivity, just not at work. |
| 9 | peak_hour in 18..20 | `dinner_table` | The Dinner Table | Phones out, forks down. |
| 10 | peak_hour in 21..23 | `after_hours` | The After-Hours Crew | The day ends. The chat begins. |

`blurb` is `"Peak hour: {h12}. {line}"` where `{h12}` is the peak hour as `11 PM` / `12 AM` /
`12 PM`, and `{line}` is the fixed sentence from the table.

## 4. Awards (deterministic, playful)

Candidates are computed per sender (only senders with >= 5 messages qualify; the chat needs
>= 3 qualifying senders or no awards are produced). Ties break by more messages, then name.

| order | id | emoji | title | winner | detail template |
|-------|----|-------|-------|--------|-----------------|
| 1 | `yapper` | 🗣️ | The Yapper | most messages | `{n} messages. Nobody asked.` |
| 2 | `lurker` | 👻 | The Lurker | fewest messages among qualifying senders | `{n} messages. Reads everything, says little.` |
| 3 | `night_owl` | 🦉 | The Night Owl | most late-night messages (>= 3) | `{n} messages after midnight.` |
| 4 | `comedian` | 😂 | The Comedian | most standing "laugh" tapbacks received (>= 3) | `Made the chat laugh {n} times.` |
| 5 | `hype` | 📣 | The Hype Machine | most tapbacks given (>= 3) | `Handed out {n} tapbacks.` |
| 6 | `novelist` | 📚 | The Novelist | highest words per message (>= 20 messages) | `{x} words per message. A paragraph person.` |
| 7 | `paparazzi` | 📸 | The Paparazzi | most attachment messages (>= 3) | `{n} photos, videos and memes.` |
| 8 | `favorite` | ⭐ | The Crowd Favorite | most standing tapbacks received (>= 3) | `{n} tapbacks received.` |

Selection: walk the table in order; an award whose winner already holds an award is
deferred. Take up to 6 non-deferred awards, then fill remaining slots (up to 6 total) with
deferred ones in table order. `{n}` is formatted with thousands separators (`,`), `{x}` with
one decimal place.

Optional AI-written awards (`--ai`, opt-in, sends the stats JSON off device) replace this
list and set `"ai": true` on each entry.

## 5. Link payload

A recap travels as a URL whose **fragment** carries the stats, so it never reaches any server:

```
https://averyhsu.github.io/imessage-wrap/#w1=<payload>
payload = base64url( raw-DEFLATE( UTF-8( JSON.stringify(stats) ) ) )   // no padding
```

- raw DEFLATE = RFC 1951, no zlib/gzip header (`zlib.compressobj(9, DEFLATED, -15)` in
  Python, `deflate-raw` in JS, `NSData.compressed(using: .zlib)` on Apple platforms).
- The story also accepts `?w1=<payload>` (query form) as a fallback for transports that drop
  fragments, and `?demo=1` for the built-in invented demo.
- The base URL is a single configurable constant in each component.
- **Length budget.** The whole URL must be at most **4,800 characters** (`MSMessage.url`
  rejects anything over 5,000). If a link would be longer, the builder re-encodes a trimmed
  copy of the stats, applying these steps in order and stopping as soon as it fits:
  1. delete `awards[].detail`;
  2. truncate every `most_reacted[].text` to 60 characters (plus `…`);
  3. keep only the first 8 `senders`;
  4. keep only the first `most_reacted` entry;
  5. delete `awards`;
  6. keep only the first 5 `senders`.
  If it still does not fit, building the link fails with a clear error.
- **Quotes are opt-in.** Message text is the only message *content* a recap can carry, so a
  link never includes it unless the person making the recap asks: `--quotes` in the
  command-line tool and the Mac helper, a switch on the maker page (off by default, shown
  next to the exact text it would add). Without it every `most_reacted[].text` is replaced
  with `""` before encoding, and the story shows who wrote the message and its tapbacks
  without the bubble text. Every link builder in every engine (`build_link`, `fit_link`,
  `fitLink`, `buildLink`) takes a `quotes` argument that **defaults to off**; nothing puts
  message text into a link by default. A page that previews a recap must not be able to
  emit a link with more in it than the link it offers to share.

## 6. Embed bridge (web story inside the iOS app / iMessage extension)

The native shell loads the bundled `web/index.html?embed=ios#w1=<payload>` from the app
bundle in a `WKWebView` (classic scripts only, no ES modules, no network requests).

In embed mode the page starts the story immediately, hides web-only chrome, and talks to
native through `window.webkit.messageHandlers.wrapped.postMessage(obj)`:

| message | meaning |
|---------|---------|
| `{type: "ready", slides: N}` | story is on screen |
| `{type: "slide", index: i, total: N}` | slide changed |
| `{type: "haptic", style: "light" \| "medium" \| "success"}` | play a haptic |
| `{type: "share", png: "data:image/png;base64,…", text: "…"}` | open the share sheet with the summary card |
| `{type: "send"}` | "Send to this chat" tapped: native inserts the recap bubble |
| `{type: "close"}` | story dismissed |
| `{type: "error", message: "…"}` | the recap could not be read or shown; native shows its own notice |

Native may call `window.WrappedStory.pause()`, `.resume()` and `.goTo(i)`, and may hand a
recap over directly with `window.WrappedApp.load(statsOrJson)` instead of putting it in the
URL.

## 7. Naming

Code, file names and the typed command stay `wrapped` (`/wrapped`, with `/recap` accepted as
an alias). The **public product name is a single constant, currently `Threadback`**, with
the descriptor "your group chat's year in review". User-visible copy must not use
"iMessage" or "Wrapped" as part of the product name: both are other companies' trademarks
(see `docs/research/06-distribution-and-links.md` §3). Describing compatibility ("works with
iMessage") and comparing ("like Spotify Wrapped, for your group chat") in prose is fine.
Story copy uses "<label> in review" (e.g. "2026 in review") rather than "Wrapped <label>".
