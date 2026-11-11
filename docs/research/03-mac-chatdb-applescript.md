# 03 — Mac path: chat.db + AppleScript + native app + Mac distribution

Researched 2026-11-11. Current macOS is **27 "Golden Gate"** (shipped 2026-09-14, Apple silicon only — [MacRumors](https://www.macrumors.com/2026/09/14/apple-releases-macos-golden-gate/)).

## Verdict

- **Reading is solved.** Schema, tapback codes and the `attributedBody` decode are confirmed from source; the decode recipe ran clean on 18 real fixtures.
- **Sending into a group is the weak link.** On macOS 26 `chat.db` stores `any;+;chat…`, AppleScript may expose `any;-;chat…`, and a send can report success while delivering nothing. Verify every send in `chat.db`.
- **No public way** to send an interactive bubble or a GUID-targeted tapback from a Mac.
- **Strangers:** a CLI from a personal Homebrew tap or `curl | bash` costs $0 but puts Full Disk Access on Terminal; a double-clickable app realistically needs the $99/yr Developer ID plus notarization.
- Mac-only, awake-only, and every reply comes from the owner's Apple ID.

## Answers

### 1. chat.db schema

```sql
SELECT c.ROWID, c.guid, c.chat_identifier, c.display_name
FROM chat c WHERE c.style = 43;              -- 43 = group, 45 = 1:1

SELECT m.ROWID, m.guid, m.date, m.is_from_me, h.id AS sender,
       m.text, m.attributedBody, m.item_type, m.group_action_type, m.other_handle,
       m.associated_message_type, m.associated_message_guid, m.associated_message_emoji,
       m.thread_originator_guid, m.date_edited, m.message_summary_info
FROM chat_message_join cmj
JOIN message m     ON m.ROWID = cmj.message_id
LEFT JOIN handle h ON h.ROWID = m.handle_id   -- can be empty when is_from_me = 1
WHERE cmj.chat_id = :chat ORDER BY m.date;

SELECT h.id FROM chat_handle_join j JOIN handle h ON h.ROWID = j.handle_id
WHERE j.chat_id = :chat;                      -- external members only, never "me"

SELECT a.filename, a.mime_type, a.is_sticker
FROM message_attachment_join j JOIN attachment a ON a.ROWID = j.attachment_id
WHERE j.message_id = :msg;
```

- **Joins** follow imessage-exporter's default query ([message.rs](https://github.com/ReagentX/imessage-exporter/blob/develop/imessage-database/src/tables/messages/message.rs)).
- **Dates:** nanoseconds since 2001-01-01 UTC; values below `1_000_000_000_000` are seconds. Unix time = `date/1e9 + 978307200` ([dates.rs](https://github.com/ReagentX/imessage-exporter/blob/develop/imessage-database/src/util/dates.rs)).
- **Groups:** `style = 43` ([BlueBubbles Chat.ts](https://github.com/BlueBubblesApp/bluebubbles-server/blob/master/packages/server/src/server/databases/imessage/entity/Chat.ts)); 43/45 are ASCII `+`/`-`, the marker in `chat.guid`. `chat_identifier` is `chat<digits>`; `display_name` is empty for unnamed groups. `room_name` and `cache_roomnames` exist ([schema](https://github.com/ReagentX/imessage-exporter/blob/develop/docs/tables/messages.md)) but their contents are **UNVERIFIED** (test: `SELECT DISTINCT cache_roomnames FROM message LIMIT 20`); use the join table.
- **Non-message rows** ([group_action.rs](https://github.com/ReagentX/imessage-exporter/blob/develop/imessage-database/src/tables/messages/models/group_action.rs)): `(item_type, group_action_type)` = `(1,0)` added, `(1,1)` removed (target in `other_handle`); `(2,_)` rename (`group_title`); `(3,0)` left, `(3,1)` icon changed, `(3,2)` icon removed, `(3,4..7)` chat background. Types 4–8 are location, kept message, FaceTime/SharePlay, SOS.
- **Tapbacks** (`get_tapback()` in message.rs): 2000 love, 2001 like, 2002 dislike, 2003 laugh, 2004 emphasize, 2005 question, **2006 emoji** (in `associated_message_emoji`), **2007 sticker**; 3000–3007 remove; **1000** is a placed sticker; **4000** is a poll vote. Only the latest state is stored: the "add" row is deleted when its removal arrives ([variants.rs](https://github.com/ReagentX/imessage-exporter/blob/develop/imessage-database/src/message_types/variants.rs)).
- **`associated_message_guid`:** `p:<part>/<GUID>` for text and attachments, `bp:<GUID>` for URL-preview and app bubbles, or a bare GUID. Take the 36 characters after the prefix (`clean_associated_guid()`).
- **`thread_originator_guid`:** bare GUID of the thread root.
- **Edited/unsent:** `date_edited != 0`. `date_retracted` usually stays 0; unsends are part indexes under `rp` in the `message_summary_info` plist ([imsg json.md](https://github.com/steipete/imsg/blob/main/docs/json.md)).
- **Version drift:** emoji tapbacks need the `associated_message_emoji` column (macOS 15, from memory); the `any;` GUID prefix arrived with macOS 26; exporter 4.3.0 "macOS Golden Gate and iOS 27 Support" added `filter_action`/`filter_sub_action` ([releases](https://github.com/ReagentX/imessage-exporter/releases)). Schemas vary: "even on a single macOS build, two machines can carry different `message` columns" ([capabilities.rs](https://github.com/ReagentX/imessage-exporter/blob/develop/imessage-database/src/tables/capabilities.rs)). Probe `PRAGMA table_info(message)`, never the OS version.

### 2. attributedBody

- **When `text` is NULL:** the exporter decodes `attributedBody` first and falls back to `text` ("Older message rows may already have the plain text field populated"). Do the same. Exactly which rows have NULL `text` is **UNVERIFIED**. Test: `SELECT is_from_me, COUNT(*) FROM message WHERE text IS NULL AND attributedBody IS NOT NULL GROUP BY 1`.
- **Layout**, from the exporter's [fixtures](https://github.com/ReagentX/imessage-exporter/tree/develop/imessage-database/test_data/typedstream):

```
04 0B "streamtyped" 81 E8 03      version 4, 11-byte signature (little-endian), system 1000
84 01 40 84 84 84 .. "NSAttributedString" / "NSMutableAttributedString" .. "NSObject" 00 85 92
84 84 84 .. "NSString"  01 (94|95) 84 01 2B   <length>  <UTF-8 bytes>  86 84 ...
```

- **Length:** one byte for 0–127; `0x81` + uint16 LE (seen: `81 9D 00` = 157, `81 37 09` = 2359); `0x82` + uint32 LE (from the decoders, no fixture). It counts **bytes**, not characters.
- **Constants:** `I_16 = 0x81`, `I_32 = 0x82`, `START = 0x84`, `EMPTY = 0x85`, `END = 0x86`, `REFERENCE_TAG = 0x92` ([parser.rs, 2.4.0](https://github.com/ReagentX/imessage-exporter/blob/2.4.0/imessage-database/src/util/typedstream/parser.rs)). python-typedstream agrees: `_TAG_INTEGER_2 = -127`, `_TAG_INTEGER_4 = -126`, byte order from the signature ([stream.py](https://github.com/dgelessus/python-typedstream/blob/main/src/typedstream/stream.py)). The exporter's fallback uses `START_PATTERN = [0x01, 0x2B]`, `END_PATTERN = [0x86, 0x84]` ([streamtyped.rs](https://github.com/ReagentX/imessage-exporter/blob/develop/imessage-database/src/util/streamtyped.rs)).
- **Recipe:** find `NSString`, find the next `01 2B`, read the length, slice, decode UTF-8; if the length overruns, cut at `86 84`. `U+FFFC` marks an attachment.

### 3. Full Disk Access

- **Who needs it:** the responsible process — for a CLI, the terminal app or whichever parent launched it (editor, SSH, automation gateway); for a native app, the app itself. Relaunch after granting ([imsg permissions.md](https://github.com/steipete/imsg/blob/main/docs/permissions.md)).
- **Error without it:** `unable to open database file` (imsg), or `NSPOSIXErrorDomain Code=1 "Operation not permitted"` (reported for `~/Library/Mail`, the same protection class — [Apple forum](https://developer.apple.com/forums/thread/799832)).
- **No API** tests for or requests FDA: "do what you're really trying to do and then handle errors" ([Apple DTS](https://developer.apple.com/forums/thread/114452)).
- **Finder:** yes. Finder "always has Full Disk Access but never appears in the Full Disk Access pane" ([SentinelOne](https://www.sentinelone.com/labs/bypassing-macos-tcc-user-privacy-protections-by-accident-and-design/), search snippet only). Go to Folder → `~/Library/Messages` → copy `chat.db`, `chat.db-wal`, `chat.db-shm`.
- **Browser picker: probably yes, UNVERIFIED.** Apple DTS: "When a user selects a 'protected' file or folder in an NSOpenPanel in a non-sandboxed app on Catalina, consent is inferred and the app can access it" ([thread 124121](https://developer.apple.com/forums/thread/124121)). I found no web analyzer relying on this, and one blog (search snippet) has users copy `chat.db` to the Desktop first. Test: browser without FDA, `<input type=file>`, ⌘⇧G to `~/Library/Messages/chat.db`, read the bytes; repeat with drag-from-Finder, in Safari, Chrome and Firefox on 15/26/27. A lone `chat.db` omits whatever is still in the WAL.

### 4. Contact names

- **SQLite:** `~/Library/Application Support/AddressBook/Sources/*/AddressBook-v22.abcddb` plus the top-level copy. `ZABCDRECORD(Z_PK, ZFIRSTNAME, ZLASTNAME)`, `ZABCDPHONENUMBER(ZOWNER, ZFULLNUMBER)`, `ZABCDEMAILADDRESS(ZOWNER, ZADDRESSNORMALIZED)`, with `ZOWNER` = `Z_PK` ([contacts.rs](https://github.com/ReagentX/imessage-exporter/blob/develop/imessage-exporter/src/app/contacts.rs)). `ZFULLNUMBER` is free-form, so match on digits. The FDA grant covers it; no Contacts prompt.
- **CNContactStore:** needs [`NSContactsUsageDescription`](https://developer.apple.com/documentation/bundleresources/information-property-list/nscontactsusagedescription) and its own prompt. "Full Disk Access does not grant access through Contacts.framework" (imsg).

### 5. Sending into a group

```applescript
on run argv   -- osascript send.applescript "<chat.guid>" "<text>" "<file or empty>"
  tell application "Messages"
    set targetChat to chat id (item 1 of argv)
    if (item 2 of argv) is not "" then send (item 2 of argv) to targetChat
    if (item 3 of argv) is not "" then send (POSIX file (item 3 of argv) as alias) to targetChat
  end tell
end run
```

- **Source:** [imsg MessageSender.swift](https://github.com/steipete/imsg/blob/main/Sources/IMsgCore/MessageSender.swift), [BlueBubbles scripts.ts](https://github.com/BlueBubblesApp/bluebubbles-server/blob/master/packages/server/src/server/api/apple/scripts.ts).
- **GUID format:** `iMessage;+;chat…` through macOS 15, `any;+;chat…` from macOS 26 ([imessage-kit platform.ts](https://github.com/photon-hq/imessage-kit/blob/main/src/infra/platform.ts)).
- **Tahoe failure:** on 26.3.1, `chat.db` held `any;+;chat…` while AppleScript exposed `any;-;chat…`; the `+` form returned `-1728`, the `-` form reported success but wrote an empty SMS row joined to no chat ([imsg #90](https://github.com/steipete/imsg/issues/90)). imsg now checks `chat.db` for up to eight seconds after every send ([send.md](https://github.com/steipete/imsg/blob/main/docs/send.md)); imessage-kit ships `any;+;` as working. Whether group sends work on a given 26/27 Mac is **UNVERIFIED**. Test: `osascript -e 'tell application "Messages" to get id of every chat'`, send, confirm on a second device.
- **Files:** the two projects disagree. imessage-kit treats `~/Pictures`, `~/Downloads`, `~/Documents` as readable by Messages and copies everything else into `~/Pictures` ([source](https://github.com/photon-hq/imessage-kit/blob/main/src/domain/messages-app.ts)); imsg says `~/Desktop` and `~/Downloads` "can hit sandbox-related send failures" and stages under `~/Library/Messages/Attachments/imsg/`.
- **Automation prompt:** "'Terminal' wants to control 'Messages'"; denied sends fail with `not authorized to send Apple events`. An app needs [`NSAppleEventsUsageDescription`](https://developer.apple.com/documentation/bundleresources/information-property-list/nsappleeventsusagedescription).
- **Also:** `-1728` when the chat is missing from Messages' live `chats` collection; `osascript` can hang.
- **Link previews: UNVERIFIED.** AppleScript sends plain text; Messages may later add a `com.apple.messages.URLBalloonProvider` row. A guaranteed card needs imsg's injected bridge. Test: send a URL, check a second device.
- **MSMessage:** none. The class exists only for iOS, iPadOS and Mac Catalyst, and "If the message is selected on macOS, the system loads the URL in a web browser" ([Apple](https://developer.apple.com/documentation/messages/msmessage/url)).
- **Tapbacks:** only UI scripting of the six classics on the last message. GUID targeting needs IMCore: SIP disabled, a dylib injected into Messages, library validation off; macOS 26 adds `imagent` entitlement checks ([advanced-imcore.md](https://github.com/steipete/imsg/blob/main/docs/advanced-imcore.md)).

### 6. Polling vs watching

- Polling `WHERE ROWID > :cursor` every 2 s is fine. Open read-only (`file:…/chat.db?mode=ro`), never `immutable=1`, which "can miss WAL-backed updates" (imsg).
- imsg watches `chat.db`, `-wal`, `-shm` and the directory with kqueue, debounces 250 ms, and keeps a poll fallback because events drop after sleep/wake ([watch.md](https://github.com/steipete/imsg/blob/main/docs/watch.md)).
- A row can appear before its `chat_message_join` row; retry briefly.

### 7. Native menu-bar app

- [`MenuBarExtra`](https://developer.apple.com/documentation/swiftui/menubarextra) (macOS 13+) with `LSUIElement`; [`SMAppService`](https://developer.apple.com/documentation/servicemanagement/smappservice) (macOS 13+) for launch at login.
- Non-sandboxed (my reasoning: the sandbox blocks `~/Library/Messages`).
- FDA onboarding is manual: try the open, explain, link to Settings, relaunch.
- TCC grants rely on "a stable code signing identity" ([Apple DTS](https://developer.apple.com/forums/thread/678819)), so ad-hoc builds lose FDA and Automation on every update.

### 8. Distribution

- **No paid account:** ad-hoc signing only. Since Sequoia "users will no longer be able to Control-click to override Gatekeeper" ([Apple, 2024-08-06](https://developer.apple.com/news/?id=saqachfa)). The user must attempt to open it, then use System Settings → Privacy & Security → **Open Anyway** (shown for about an hour, per Apple Support via search snippet) and authenticate. No macOS 27 change found (**UNVERIFIED**; test: download an ad-hoc-signed app with a browser on 27 and open it).
- **Paid ($99/yr, from memory):** Developer ID certificate, hardened runtime, `notarytool`, `stapler` ([Apple](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)). Notarization is automated, not App Review.
- **Homebrew official taps:** casks must pass Gatekeeper ([Acceptable Casks](https://github.com/Homebrew/brew/blob/main/docs/Acceptable-Casks.md)); failing casks were deprecated in [5.0.0](https://brew.sh/2025/11/12/homebrew-5.0.0/) with disabling set for September 2026, and `--no-quarantine` was deprecated. New packages need 75 stars or 30 forks, tripled if self-submitted ([policy](https://github.com/Homebrew/brew/blob/main/docs/Package-Acceptance-Policy.md)).
- **Personal tap:** allowed; since 6.0.0 it needs explicit trust, and `brew install user/tap/formula` trusts just that item ([Tap Trust](https://github.com/Homebrew/brew/blob/main/docs/Tap-Trust.md)). Homebrew quarantines cask downloads ([security doc](https://github.com/Homebrew/brew/blob/main/docs/Homebrew-Security-and-Supply-Chain.md)), so a formula should avoid Gatekeeper (inference). imsg ships a notarized binary this way.
- **`curl | bash` Python CLI:** `/usr/bin/python3` belongs to "Xcode or the Command Line Tools" ([CPython docs](https://github.com/python/cpython/blob/main/Doc/using/mac.rst)); without them the first run opens the tools-install dialog (**UNVERIFIED**; test on a clean Mac). Bundle an interpreter.

### 9. Awake-only

- `caffeinate -i` blocks idle sleep; `-s` is "valid only when system is running on AC power" ([man page](https://github.com/apple-oss-distributions/PowerManagement/blob/main/caffeinate/caffeinate.8)). I found no source that a closed lid or Power Nap keeps a user agent running; assume not (**UNVERIFIED**; test: sleep the Mac, send `/wrapped` from a phone, see when the reply lands).
- After wake, catch up from the ROWID cursor and ignore stale commands.
- Replies come from the owner's Apple ID: AppleScript `send` "has no `from` or account selector" (imsg).

## Scores (0–5)

| Criterion | Score | Reason |
|---|---|---|
| In-Messages | 3 | Typed trigger and image reply; no interactive bubble |
| iPhone-only | 0 | Needs a Mac signed in to iMessage |
| Works for everyone | 2 | One Mac owner serves the group; others cannot run it |
| Low setup | 1 | Install, FDA, Automation prompt, keep the Mac awake |
| Usable by strangers today | 2 | CLI yes for technical users; an app needs notarization |
| Privacy | 4 | Fully local, but FDA is a broad grant |
| Wow factor | 3 | Auto-reply in the thread, but a static image |
| Feasibility | 3 | Reading proven; group send on 26/27 unproven |
| Cost | 4 | $0 as a CLI, $99/yr for a signed app |
| Time to demo | 5 | Hours on the owner's Mac |
| App Store/ToS risk | 3 | No App Store path; undocumented schema and automation |

## Implications for the build

- Decode `attributedBody` for every new row; `WHERE text = '/wrapped'` can miss commands.
- Pass `chat.guid` verbatim to `chat id`; on `-1728` try the `;+;`/`;-;` swap; then require a joined outgoing row before reporting success. Never blind-retry.
- Stage the card under `~/Pictures` or `~/Library/Messages/Attachments/<app>/` before sending; never send from a temp directory.
- Count tapbacks from 2000–2007 rows; exclude `item_type != 0` and `associated_message_type >= 1000` from message totals (0, 2 and 3 are ordinary or app messages).
- Ignore the bot's own rows, or it answers itself.
- First real-Mac test: the group send on macOS 26 and 27. If it fails, this path is read-only.

## Sources

All links are inline. The ones the answers lean on most:

- [ReagentX/imessage-exporter](https://github.com/ReagentX/imessage-exporter) — schema, tapback codes, typedstream parser and fixtures, AddressBook queries.
- [dgelessus/python-typedstream](https://github.com/dgelessus/python-typedstream) — typedstream constants.
- [steipete/imsg](https://github.com/steipete/imsg) docs and issues #90, #311 — AppleScript sending, permissions, watching, macOS 26/27 breakage.
- [photon-hq/imessage-kit](https://github.com/photon-hq/imessage-kit) — `any;` prefix, attachment directories.
- Apple: developer news, documentation and DTS forum threads 114452, 124121, 678819, 799832.
- [Homebrew/brew docs](https://github.com/Homebrew/brew/tree/main/docs) and the 5.0.0 / [6.0.0](https://brew.sh/2026/06/11/homebrew-6.0.0/) release posts.

Unreachable from this session, so quoted from search snippets or GitHub mirrors: support.apple.com, brew.sh, docs.brew.sh, sqlite.org, docs.bluebubbles.app, sentinelone.com. The shared web-search budget ran out before I could look for group-send reports on macOS 27.
