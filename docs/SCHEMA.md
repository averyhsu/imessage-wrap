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
  The target is `associated_message_guid` with everything up to and including the last `/`
  or, if there is no `/`, the first `:` stripped (`p:0/GUID`, `bp:GUID` → `GUID`).
  Process tapback rows in chronological order (ties by ROWID): an *add* sets
  `state[(target, reactor)] = kind`, a *remove* deletes it. What is left at the end of the
  period is "standing". Tapback rows are never counted as messages.
- **Countable message**: `item_type = 0` (or NULL), `associated_message_type` NULL or
  < 1000, and it has text or an attachment (`cache_has_attachments = 1`). Rows with no text
  and no attachment (unsent/empty) are skipped.
- **Text**: `message.text` when non-empty, otherwise the string decoded from
  `attributedBody` (typedstream). Remove U+FFFC and U+FFFD, then trim. **Words** = number of
  whitespace-separated tokens.
- **Sender**: `is_from_me = 1` → the owner (display name supplied by the user, default
  `"Me"`). Otherwise `handle.id` via `message.handle_id`, mapped through the contact-name
  table when one is available (phones compared on their last 10 digits, e-mails
  case-insensitively), else the **masked** handle (below). Senders that resolve to the same
  display name are merged. `chat.members` = number of distinct senders seen plus members in
  `chat_handle_join` that never spoke (owner included).
- **Masking**: a recap is made to be shared, so a raw phone number or e-mail address never
  goes into the stats, the link, the card or a chat's fallback name. For a trimmed handle
  with no contact name:
  - a phone number (only digits, spaces and `+ - ( ) . /`, with at least 7 digits) is shown
    as `…` plus its last four digits (`+1 (555) 010-0001` → `…0001`);
  - an e-mail address (no whitespace, something before the `@`, a dot after it) is shown as
    the part before the `@`, cut to 16 characters plus `…` when longer;
  - anything else (a name from an imported export, a short code) is kept as it is.
  Two unnamed people whose numbers end in the same four digits are merged; the maker page
  lets the user rename people, which avoids that.
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
  without the bubble text. The low-level builders (`build_link`, `fitLink`) take a `quotes`
  argument; every user-facing entry point passes `false` unless asked.

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

Native may call `window.WrappedStory.pause()`, `.resume()` and `.goTo(i)`.

## 7. Naming

Code, file names and the typed command stay `wrapped` (`/wrapped`, with `/recap` accepted as
an alias). The **public product name is a single constant, currently `Threadback`**, with
the descriptor "your group chat's year in review". User-visible copy must not use
"iMessage" or "Wrapped" as part of the product name: both are other companies' trademarks
(see `docs/research/06-distribution-and-links.md` §3). Describing compatibility ("works with
iMessage") and comparing ("like Spotify Wrapped, for your group chat") in prose is fine.
Story copy uses "<label> in review" (e.g. "2026 in review") rather than "Wrapped <label>".
