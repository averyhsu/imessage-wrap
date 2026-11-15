# Decisions

A running log of what was considered, what was found, and what was chosen. Research notes
with full sources live in [`docs/research/`](research/); this file is the synthesis.

> Research caveat: the build sandbox could reach `developer.apple.com`, GitHub and package
> registries, but not `support.apple.com`, news sites or vendor sites. Facts that rest on a
> search-result snippet rather than the page itself are marked **UNVERIFIED** in the notes,
> and every claim that needs a real device is listed in [`STATUS.md`](../STATUS.md).

## The short version

**The ideal — a recap that lives inside Messages, is created on an iPhone with no setup, and
plays for every member — is not reachable through any single path today.** The reason is
structural, not a matter of effort:

- The only sanctioned way to put UI *inside* a thread is an iMessage app extension, and an
  extension is **blind**: no history, no message counts, no names, no chat name, no
  tapbacks. That has not changed from iOS 10 to iOS 27
  ([note 01](research/01-messages-framework.md)).
- No framework, App Intent, SiriKit intent or Apple Intelligence hook exposes the Messages
  store to another app ([note 02](research/02-ios-history-apis.md)).
- A cloud "bot" number can live in the thread and answer `/wrapped` on any iPhone, but it
  sees nothing sent before it joined, costs $40–290 per line per month, and routes every
  later message through a third party ([note 05](research/05-bridges-and-business-apis.md)).
- A native no-install viewer (App Clip) needs a *published* App Store app first
  ([note 06](research/06-distribution-and-links.md)).

So the product is a **hybrid that keeps as much of the ideal as each member's situation
allows**:

1. **Compute once, on one member's own device** — whichever they have:
   a Mac (`chat.db`, in the browser with nothing installed, or via the CLI),
   an iPhone + any computer (local backup, in the browser),
   or an iPhone alone on iOS 26.4+ (a Shortcut using Apple's "Find Messages" action —
   experimental, see D7).
2. **Deliver into the thread** as a link whose `#fragment` *is* the recap. The link opens a
   full-screen animated story for **every** member — iPhone, Android or Mac — with nothing
   to install and no server ever seeing the data. Per Apple's documentation the link should
   show as a card with a short looping video in the conversation; that has not been seen on
   a real phone yet.
3. **Upgrade paths that feel native**: an iOS iMessage app that sends the same recap as an
   interactive bubble and plays it inside Messages; and a Mac helper that answers a typed
   `/wrapped` in any group chat.

**Update, 2026-11-15.** The last of these became the front door. A Mac app that answers a
typed `/wrapped` is now the main way to use Threadback, and the browser maker is the
alternative for people without it (D15, D17).

## Every path, scored

Scores are 0–5, higher is better (Cost: 5 = free. Risk: 5 = low App Store / terms risk).
"Today" means usable by strangers today without spending money.

| # | Path | In Messages | iPhone only | Everyone in chat | Low setup | Strangers today | Privacy | Wow | Feasible | Cost | Time to demo | Risk | Verdict |
|---|------|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|---------|
| 1 | iMessage app extension, alone | 5 | 5 | 2 | 2 | 1 | 4 | 4 | **1** | 4 | 2 | 3 | Cannot compute anything. **Kept as viewer + share surface.** |
| 2 | On-iPhone history via Shortcuts "Find Messages" (iOS 26+) | 2 | 4 | 3 | 3 | 2 | 4 | 3 | 2 | 5 | 4 | 3 | **Built as experimental input**, never run on a phone; the scores assume it reports senders in group chats, which is unverified. |
| 3 | Link with `#fragment` payload → static web story | 2 | 3 | **5** | 4 | 4 | 4 | 3 | **5** | 5 | 5 | 4 | **Chosen as the universal delivery.** |
| 4 | Mac helper: `chat.db` + AppleScript reply to `/wrapped` | 3 | 0 | 2 | 1 | 2 | 4 | 3 | 3 | 4 | 5 | 3 | **Built** (the original prototype, hardened). |
| 5 | Native Mac menu-bar app, signed + notarized | 3 | 0 | 2 | 2 | 1 | 4 | 3 | 3 | 3 | 3 | 3 | Deferred: needs $99/yr; adds polish, not reach. |
| 6 | iPhone backup (`sms.db`) parsed in the browser | 0 | 2 | 3 | 1 | 2 | 4 | 3 | 4 | 5 | 4 | 5 | **Built** as the full-fidelity no-Mac input. |
| 7 | Cloud bot line (Sendblue, LoopMessage, Linq, Blooio, Photon) | 5 | 5 | 3 | 4 | 2 | **1** | 3 | 3 | 2 | 4 | **1** | Rejected as the product; possible opt-in extra later. |
| 8 | BlueBubbles / Beeper on the user's Mac | 3 | 0 | 2 | 0 | 1 | 4 | 3 | 2 | 5 | 3 | 2 | Rejected: Private API needs SIP disabled. |
| 9 | Apple Messages for Business | 0 | – | 0 | – | 0 | – | – | **0** | – | – | – | Rejected: 1:1 only, no group chats. |
| 10 | App Clip (native, no install, from a link) | 4 | 5 | 4 | 5 | **0** | 4 | 5 | 3 | 4 | 1 | 3 | Deferred: needs a published App Store app. |
| 11 | Direct API access (SiriKit / App Intents / Apple Intelligence) | – | – | – | – | – | – | – | **0** | – | – | – | Does not exist. |
| — | **Chosen hybrid (2 + 3 + 4 + 6, with 1 as the native upgrade)** | 4 | 3 | 5 | 4 | 4 | 4 | 4 | 4 | 5 | 5 | 4 | |

How the hybrid does against each of the seven goals:

| Goal | Where the hybrid lands | What is missing from the ideal |
|------|------------------------|--------------------------------|
| 1. Lives inside Messages | A link in the thread (a card with a looping video, if Messages renders the preview as documented) → one tap → story. With the iOS app: an interactive bubble that plays inside Messages. On a Mac running the helper: typing `/wrapped` gets a reply in the thread. | Without the app, the story plays in Safari, not in the Messages sheet. |
| 2. Works on iPhone, no Mac | Viewing: yes, always. Creating: iPhone alone via Shortcuts on iOS 26.4+ (experimental), or iPhone + Windows PC via a local backup. | No verified, effortless, iPhone-only creation path. |
| 3. Works for everyone | Yes for watching: any device with a browser, including Android and Mac members. | Where no preview renders (groups with Android phones, SMS) the link is a long plain URL of up to 4,800 characters. Shortening it would need a server, which D2 rules out. |
| 4. Almost no setup | Viewers: none. Creator: find two files in a hidden folder and drop them on a web page (Mac), or make an unencrypted backup first (iPhone + computer), or one install command plus a permission (Mac helper). | The creator has real setup; only viewers have none. |
| 5. Usable by strangers today | Yes, the moment GitHub Pages is switched on (owner's call). | The iOS app needs the $99 Apple Developer Program for TestFlight. |
| 6. Privacy | Stats are computed on the member's own device. The recap travels inside the URL `#fragment`, which browsers never send to a server. No analytics, no third-party scripts, no backend. AI awards are off unless explicitly enabled. | The link *is* the data: anyone it is forwarded to can open it. A "no quotes" switch keeps message text out. |
| 7. LinkedIn-worthy | A real animated story and a share card. | An in-Messages native sheet for everyone would be stronger; that is the App Clip step. A recap made with the defaults (first names, no quotes) is plainer than the demo. |

## Path findings in brief

### 1. iMessage app extension ([note 01](research/01-messages-framework.md))
- Reads only `localParticipantIdentifier`, `remoteParticipantIdentifiers` (opaque per-device
  UUIDs) and `selectedMessage`. Apple at WWDC16: "we don't expose contact information at all
  to iMessage apps".
- `MSMessage.url` carries state: http/https/data only, **at most 5,000 characters**.
- With the app: template card, or a live view in the bubble (live layout has open "stuck on
  Loading…" reports on iOS 17–27). Without the app: a static card and a "Get the app" link;
  on a Mac, clicking opens the `url` in a browser. No slash-command trigger exists.
- Distribution is App Store / TestFlight only ($99/yr). Extensions do not run on macOS.
- **Decision:** the extension is the native *viewer and share surface*; the template card
  must be good on its own; live layout is optional polish behind one switch.

### 2. On-iPhone history ([note 02](research/02-ios-history-apis.md))
- Every API route is a dead end (SiriKit and App Intents message schemas cover only an
  app's own content; Apple Intelligence exposes nothing; Screen Time, Spotlight,
  notification extensions, the share sheet and iCloud web all give nothing).
- **But** iOS 26 added the Shortcuts actions **Find Messages** and **Find Conversations**,
  and iOS 27 added sender filtering and group support for Send Message. Third-party export
  apps already ship on this. A shortcut can hand message rows to a web page or app.
- **UNVERIFIED** (needs a real iOS 26.4+/27 phone): per-message sender in group chats,
  speed on large chats, and tapbacks (probably not exposed).
- The Foundation Models framework (iOS 26+) could write the playful awards fully on device.
- **Decision:** accept Shortcut/CSV exports as an input (D7). Do not claim it works until
  the owner runs the 10-minute device spike in `STATUS.md`.

### 3. Link + static web story ([note 06](research/06-distribution-and-links.md))
- URL fragments are never sent over HTTP (RFC 3986 §3.5), so a static host never sees the
  recap. Apple's TN3156: Messages builds the preview from `og:` tags with no JavaScript,
  and an `og:video` pointing at an MP4 **downloads and autoplays in the bubble**.
- The preview card cannot be personalised (the fragment is invisible to the preview fetch).
- Everything the story needs (inflate, Web Share with files, `100dvh`, safe areas) has
  shipped in Safari since 16.4 or earlier.
- **Decision:** this is the universal delivery. One payload format, capped at 4,800
  characters so the same link fits `MSMessage.url`.

### 4. Mac helper ([note 03](research/03-mac-chatdb-applescript.md))
- Reading is solved: schema, tapback codes (2000–2007 add, 3000–3007 remove, 1000 sticker,
  4000 poll vote) and the `attributedBody` typedstream layout are confirmed from source.
- **Sending into a group is the weak link.** On macOS 26 `chat.db` stores `any;+;chat…`
  while AppleScript may expose `any;-;chat…`, and a send can report success while
  delivering nothing. Every send must be verified against `chat.db`.
- Messages can only attach files from `~/Pictures`, `~/Downloads` or `~/Documents`.
- Needs Full Disk Access for the terminal, an Automation prompt, and an awake Mac; replies
  come from the owner's Apple ID.
- **Decision:** keep it as the "type `/wrapped` in the thread" experience for people with a
  Mac; verify every send; never blind-retry.

### 5. Native Mac app
- A SwiftUI `MenuBarExtra` app is feasible, but without a Developer ID it cannot pass
  Gatekeeper (since macOS 15 there is no right-click override; users must dig through
  System Settings), and ad-hoc builds lose their Full Disk Access grant on every update.
- **Decision:** deferred until the owner approves the $99 program. The CLI covers the
  function; the web analyzer covers people who will not open a terminal.

### 6. iPhone backup ([note 04](research/04-iphone-backup-smsdb.md))
- `sms.db` sits at `3d/3d0d7e5fb2ce288813306e4d4636395e047a3d28` in a local backup, contact
  names at `31/31bb7ba8914766d4ba40d6dfb6113c8b614be442`; the schema matches the Mac's.
- **UNVERIFIED:** whether a local backup still contains message text when Messages in
  iCloud is on (Apple's page says no; two forensic vendors say yes).
- Encrypted backups can be decrypted with WebCrypto (PBKDF2 10,000,000 rounds ≈ 2–15 s),
  not built yet; the analyzer detects them and says so.
- Chromium blocks `~/Library` and `%APPDATA%` in the directory picker, so input is
  drag-and-drop or a plain file input.
- **Decision:** built as the full-fidelity path for people without a Mac. Honest about the
  cost: a full phone backup takes 20–90 minutes.

### 7. Cloud bot ([note 05](research/05-bridges-and-business-apis.md))
- Works only in all-iMessage groups of 3+; **no history before joining**; all later content
  flows through the provider; Apple has blocked such lines before (Beeper Mini, 2023–24).
- Three providers (Linq, Blooio, Photon) can now send iMessage-app bubbles from the cloud.
- **Decision:** rejected as the product (fails privacy and history). Noted as a possible
  opt-in "count from today" extra; would need owner approval for an account and spend.

### 8–11. BlueBubbles, Messages for Business, App Clips, direct APIs
- BlueBubbles' useful extras need SIP disabled — not something to ask of strangers.
- Messages for Business is strictly one customer ↔ one business; no group chats.
- App Clips launch from a Messages link with no install, but "testing and using default and
  demo links requires your app and App Clip to pass App Store review". This is the best
  next step after the App Store.
- Direct APIs do not exist.

## Decision log

### D0 — Ground rules (2026-11-11)
- Work in `averyhsu/imessage-wrap` on `claude/imessage-wrapped-build-84gdoo` (the only
  branch this session may push to). The brief says `imessage-wrapped`; the repo that was
  actually provided is `imessage-wrap`.
- The repo is public, so no real chat data, names or secrets are ever committed. All demo
  data is invented. `.gitignore` blocks databases and generated stats.
- Apple-native code is compiled and exercised on GitHub Actions `macos-26` runners; the
  Linux sandbox cannot run Xcode or download a Swift toolchain.
- No prototype zip was attached, so the Mac prototype was rebuilt from its description.

### D1 — One story implementation, in web technology
The animated story is a single vanilla HTML/CSS/JS bundle (`web/`), used three ways:
opened from the link in Safari, hosted as the public demo, and bundled inside the iOS app
in a `WKWebView`. Reasons: it must exist as a web page anyway (it is the only thing that
reaches every member); it can be fully tested here with Playwright; and SwiftUI written
blind, compiled only in CI, is the riskiest way to hit an Apple-level design bar. The native
shell adds what the web cannot: the Messages bubble, haptics, the share sheet.

### D2 — The recap travels in the URL fragment; there is no backend
`https://<site>/#w1=<base64url(raw-deflate(JSON))>`. Nothing to host, nothing to breach,
nothing to pay for, and the privacy claim is checkable by anyone (static page, strict CSP,
zero third-party requests — enforced by a test). Trade-offs accepted: the preview card is
generic; a forwarded link exposes the recap; links are permanent, so the base URL must be
settled before sharing widely. See [`SCHEMA.md`](SCHEMA.md) §5.

### D3 — Two engines, forced to agree
Stats are computed by a Python engine (CLI + Mac helper) and a JavaScript engine (browser).
A conformance suite runs both over generated fixtures and requires identical JSON, and a
macOS CI job validates the `attributedBody` decoder against blobs produced by Apple's real
`NSArchiver`. A single Swift or WASM engine was considered and rejected: Python is what the
Mac helper needs with no build step, and the browser is what "no install" needs.

### D4 — Public name: "Threadback"; never "iMessage" or "Wrapped" in the product name
"iMessage" is Apple's mark (App Review has rejected apps for using it in a name; guideline
5.2.5) and "Wrapped" is registered to Spotify, which challenged the "Unwrapped" project in
2025. The public name is one constant, currently **Threadback** ("your group chat's year in
review"); the owner can change it in one place. Code, the repo and the typed `/wrapped`
command keep the working name. Prose may say "works with iMessage" and "like Spotify
Wrapped, for your group chat".

### D5 — The iOS extension is a viewer and share surface, template-first
It sends one `MSMessage` whose `url` is the same https link (so Macs and people without the
app still get the story), with a natively rendered template card, and plays the story in
the expanded view. Live layout is behind a switch because of its open reliability reports.

**Update after testing in the Simulator's Messages app.** Both bubble styles were sent,
received and tapped by the UI tests. The live layout works on the sender's side, but a
*received* live bubble is handed no conversation and no message by Messages (seen in the
Simulator: `activeConversation` is nil and `willBecomeActive` is never called for a
transcript-style controller), so it can only show a generic "open to play" face. The
template card always shows the chat's name and count, for people with and without the app.
So `WrappedConfig.useLiveLayout` is **off**; tapping either bubble plays the same story.
Whether real phones behave like the Simulator here is on the device checklist.

### D6 — Never silently undercount
A Mac's live `chat.db` keeps recent rows in `chat.db-wal`. The browser analyzer either
merges the sidecar or warns; the CLI opens read-only (never `immutable`). Every analysis
shows a diagnostics line (messages, chats, first and last date) so a partial database is
visible to the user.

### D7 — The Shortcuts route is shipped as "experimental", not as a promise
The analyzer accepts a CSV/TSV/JSON export (from our documented shortcut recipe or from a
third-party export app). Stats that need tapbacks are simply absent in that mode. It cannot
be tested without a real iPhone on iOS 26.4+, so it is labelled experimental everywhere
until the owner's device spike confirms group-chat sender fidelity.

### D8 — Not built (and why)
- Cloud bot: privacy and history (path 7). Needs spend + accounts.
- BlueBubbles Private API: requires disabling SIP.
- Notarized Mac app, TestFlight build, App Clip: each needs the $99 Apple Developer Program,
  which is the owner's decision. Everything up to that line is prepared.
- Encrypted iPhone backups: feasible with WebCrypto; next step.
- AI awards in the browser: would need each user's own API key; kept to the CLI behind
  `--ai` with an explicit consent prompt.

### D9 — Riskiest assumption, tested first
"An iOS app containing an iMessage extension can be built, run in the Simulator and
screenshotted on a GitHub Actions macOS runner with no local Xcode."

**Result: true.** The first run
([43030079757](https://github.com/averyhsu/imessage-wrap/actions/runs/43030079757), on a
`macos-26` runner) generated the project with XcodeGen, built the app with the extension
embedded, ran the tests in the iOS Simulator and captured a screenshot, about 17 minutes end
to end. That made the native shell worth building. What the Simulator cannot show (a real group chat, a
second device receiving the bubble) is listed in [`STATUS.md`](../STATUS.md).

### D10 — CI lives on the working branch until the owner merges
This session may only push to its own branch and may not open a pull request unasked, so
"green on main" is one owner action away: merge the branch (or ask for a PR). All workflows
trigger on both `main` and `claude/**`.

### D11 — A recap never carries a raw phone number or e-mail address
Found while testing the finished engines end to end: a member who is not in the owner's
contacts appeared as their full phone number, so a link dropped into a chat (and forwarded
from there) could publish other people's numbers. Both engines now mask at the source: a
phone number becomes `…` plus its last four digits, an e-mail address the part before the
`@` (rule and edge cases in [`SCHEMA.md`](SCHEMA.md) §2). Masking in the engine, rather than
in each surface, means the link, the story, the card and the text recap cannot disagree. The
maker page lets people replace `…1234` with a name.

### D12 — Message text is opt-in everywhere
The brief's privacy rule is "message content stays on device, or the user explicitly agrees
before anything leaves it". The only message content a recap can contain is the text of the
up to three most-reacted messages. The first builds included it by default with a way to
switch it off; that is consent by not objecting, which is not the rule. Now nothing carries
message text unless the person making the recap asks: `--quotes` in the command-line tool
and the Mac helper, a switch on the maker page that sits next to the exact text it would
add. The on-device preview may show the quotes, because nothing has left the device yet.
Cost: the "message of the year" slide is less striking by default (it shows who wrote it and
the tapbacks, not the words). Accepted; it is one deliberate tap away.

### D13 — What the first independent review found, and what was done
A reviewer that had not seen the build was told to break the finished parts. What held:
89 hostile recap links (nothing ran, nothing left the page, no crash), the pages' content
security policy at the network level, parameterised SQL, and the counting, which matched
the reviewer's own recount from SQLite on 12 chat, time-zone and period combinations.

What did not hold, and the fix:

| Finding | Fix |
|---------|-----|
| **Critical.** The maker's phone preview could copy a link containing message text while the quotes switch was off. | The preview is built from exactly the link that would be shared. A test presses the story's own Copy link inside the preview, with the switch off and on. |
| **High.** The Mac helper matched chats by name while running, so a new or renamed group could get a reply it was never approved for. | Approved chats are fixed by id when the helper starts; a rename keeps an approved chat approved and never adds one. |
| **High.** Masking could be defeated by formatting (`tel:` prefixes, labels, full-width digits, `Name <address>`). | Any label with an address or 7+ digits is masked, in both engines, checked against one shared table. Chat names use a stricter test so that years survive (see `SCHEMA.md` §2). |
| Full contact labels ("Dave plumber") went into links; the owner showed as "Me". | Short names by default (`--full-names` to keep them); the Mac helper takes the owner's first name from the Mac account. |
| The installer's uninstall could delete a folder it had not created. | It removes only what it wrote, refuses `/`, the home folder and its parents, and never follows links. |
| A long unbroken chat name stalled the card renderer for minutes. | Every string is capped before fitting; a 100,000-character name costs the same as a short one. |
| Damaged or odd databases produced raw error traces. | One sentence and exit status 1 in the command-line tool; coded errors in the browser. |
| Control characters in chat names reached the terminal, the log and the sent text. | Names are cleaned at the source and again wherever they are printed. |
| Link builders defaulted to including message text. | Every builder defaults to none. |
| AI-award checks let through bare domains, numbers and invisible characters; an API error could echo the key into the log. | Stricter validation; errors log status and type only, with key-shaped text scrubbed. |
| Running the tests rewrote tracked screenshots. | Tests write to a temporary folder; CI fails if a run leaves anything in the checkout. |

Smaller items (a personality id that named a built-in property, numbers above 10^21, the
embed mode opened in a normal browser, right-to-left names, focus order, reduced motion) were
fixed in the story with tests. Not changed: `wrapped chats --json` still lists members' raw
identifiers, because it is the owner's own local output and never part of a recap.

### D14 — The second independent review: goal fit, the maker, the iPhone code
A second reviewer scored the build against the seven goals, attacked the maker page, read
the Swift, and re-checked the first review's fixes (all five held). Its scorecard is the
basis of the table at the top of [`STATUS.md`](../STATUS.md); it judged the central argument
(no single path can do the whole job) sound and sourced, and called out where this document
had stated hopes as facts. Those passages are corrected above.

| Finding | What was done |
|---------|---------------|
| A contact saved under an e-mail address or a number went into the link unmasked. | Names from the contact table go through the same mask as every other label, in both engines. |
| The maker's background worker was not bound by the page's security policy and could have reached the network. Nothing did, but the promise was not enforced. | The worker is started from a blob so it inherits the page's policy; its network functions are also removed. A test proves requests from inside it are blocked. |
| The maker hung when someone's name was a JavaScript built-in such as `constructor`. | Names never key plain objects; errors in a step are shown, not swallowed. |
| Names had no length limit (a 100,000-character chat name made a 300,000-pixel page). | Capped in both engines: 80 characters for a chat, 40 for a person. |
| Everyone read "Me 20.3%". | The maker asks for the owner's name; the command-line tool and the Mac helper take it from the Mac account. |
| The iPhone app decompressed a recap before checking its size, accepted any link scheme, and remembered every recap it displayed. | Size is limited before and during decompression; only its own link forms are accepted; only recaps the person sent or pasted are remembered, with a Clear control. |
| The extension's main button sent the invented demo into a real chat. | The main action is the person's own recap; the sample only plays. |
| README's "try it" assumed the code was on `main`; STATUS had no check for the maker on a real Mac; the LinkedIn draft led with the unproven `/wrapped` flow and the demo's invented numbers. | All three rewritten. |

**Leads not investigated.** (1) Apple's Shortcuts app has the same "Find Messages" action on
macOS; if it reports senders there, a Mac owner could make a recap with no Terminal and no
Full Disk Access by running the same shortcut and pasting into the maker. (2) Apple's
privacy data export (privacy.apple.com) was not checked for message history. (3) Handing the
Shortcut's output straight to the iPhone app (an App Intent) so that a recap could be made
and sent from the Messages drawer with no browser: worth building only once the device test
in [`SHORTCUT.md`](SHORTCUT.md) shows that the Shortcut reports senders in group chats.

### D15 — The Mac helper should become a native app; a prototype says it can be a few clicks
The owner asked whether `/wrapped` could be set up by someone with no technical knowledge in
one click or a few. Two research passes and a prototype answered it
([note 07](research/07-mac-app-permission-floor.md),
[note 08](research/08-mac-one-click-distribution.md), [`mac/`](../mac/), summary in
[`MAC-APP.md`](MAC-APP.md)):

- **Yes, about ten clicks and no typing**, with a native menu-bar app. The step that made
  the command-line helper painful, Full Disk Access, is not needed: picking the Messages
  folder once in the standard Open window is consent for that folder. Four of the ten clicks
  are macOS's own prompts and cannot be designed away.
- **Native Swift, not the Python helper in a wrapper.** The app is under 3 MB, shows its own
  name in every prompt, and runs the existing JavaScript engine unchanged, so the
  conformance suite still covers it (five chats byte-identical to the Python tool on a
  macOS 26 runner).
- **For strangers it needs the Apple Developer Program** ($99 a year, the same membership
  as TestFlight). Without notarization macOS blocks a downloaded app behind a ten-step
  detour and forgets its permissions on every update. The Mac App Store is not a route:
  the sandbox it requires rarely gets the exception needed to control Messages.
- **Not decided by this work:** whether to spend the $99 and finish the app. Both are the
  owner's call.
- **Not proven:** the folder pick on a real Mac (GitHub's runners have file protection
  switched off, so the experiment there shows nothing), and group sends on macOS 26 and 27,
  which is the one risk no setup flow can remove. The fallback is a ready-to-send message
  the owner sends by hand.

**Owner's decision, 2026-11-12:** the Mac app is the direction; no Apple Developer Program
for now. So the app ships ad-hoc signed by the free route, and the two real-Mac tests in
[`MAC-APP.md`](MAC-APP.md) come before finishing it.

**Result of the owner's two tests, 2026-11-15 (macOS 26.7.1, unsigned build `9872b81`):**
both passed. A direct read of the Messages database was refused before the folder pick and
worked after it, so the pick does replace Full Disk Access on a real, protected Mac; and a
`/wrapped` typed in a real group chat was answered with image and text, verified as
delivered. The two risks D15 left open are therefore settled for this Mac. Still open:
whether access survives a restart and an update, and how other macOS versions behave.

### D16 — Publishing without build artifacts (2026-11-15)
After four days of heavy CI the account's artifact storage filled up and GitHub refused new
artifacts, which broke three things at once: runs failed at their upload step, the Mac app
could no longer be handed to the owner as an artifact, and the site could not be published,
because the standard Pages workflow uploads the site as an artifact. With the owner's
approval:

- **The site is published from a `gh-pages` branch.** A workflow copies `web/` there on
  every change that reaches `main`; Pages serves the branch. No artifact is involved.
- **Mac app builds go to the Releases page**, which has no such quota and needs no sign-in:
  a rolling preview build from the working branch for the owner to test, and the public
  download from `main`.
- **Old artifacts are deleted daily** and new ones are kept three days. Uploads are
  best-effort everywhere, so a full store can no longer turn a good run red.


### D17 — The Mac app becomes the front door, after a third review (2026-11-15)
Once the owner's two tests had passed (D15), the Mac app stopped being an experiment.

- **The site leads with it.** The front page now says "Type `/wrapped`. A Mac answers.", the
  browser maker is the alternative for people without the app, and the last slide of every
  story points there.
- **Replies carry the link.** It was off while the site was not live. Turning it on changes
  what leaves the Mac, so the app now stores, with each chat's approval, what a reply
  carried when the owner agreed. When that changes, the chat is not answered until the owner
  agrees again.
- **A third independent review, before the public download was linked from the site.** A
  reviewer who had not seen the app being written was asked to make it send to the wrong
  chat, reply twice, or leak something. What it found and what was done:

  | Finding | What was done |
  |---------|---------------|
  | **Pause did not pause**: a `/wrapped` was still answered while the window said "Paused", and a relaunch quietly resumed. | Pause is checked before every send, saved across launches, and nothing typed during a pause is answered later. |
  | Two open copies of the app both answered. | A lock file: a second copy shows the first one's window and quits. |
  | Turning a chat off did not stop a reply already in progress, and changing settings mid-reply could cause a second reply. | The live list of chats is checked before each of the three messages; one agent, changed on one queue. |
  | What a reply contains was shown after the click that turned a chat on. | A confirmation sheet states it first; approvals record what was agreed to (above). |
  | Two chats with similar names shared one picture file, so one chat's picture could reach the other. | Each send writes its own uniquely named file and deletes it afterwards. |
  | A chat was looked up by row number with a fall-back to matching by name. | Id only; no fall-back. |
  | "Delivered" could rest on some other message in the same chat. | A send counts only when the app finds its own exact message; it reports delivered, sent, or written but not yet sent. |
  | No limit beyond one reply every two minutes. | 20 replies per chat per day, and a ten-minute wait after three in an hour. |
  | The picture could fail for good after a crash in the web view that draws it. | The view is rebuilt after a crash or a stalled load; a natively drawn card is the fall-back. |
  | The build job could publish, and its tools were not pinned. | The build job is read-only; a separate job that only handles the finished disk image may publish; tools are pinned by checksum; the unit tests also run against the release build. |
  | Only twelve chats could be chosen; chat names reached the system log; the card's footer overprinted. | All chats, with search; nothing is logged in release builds; fixed, with a check in CI. |
  | The guide page and release notes left out the link and what it carries. | Both now say that a reply is three messages, what the link holds and that anyone it is passed to can open it. |

  What it could not break is listed in [`MAC-APP.md`](MAC-APP.md).
- **The merge waited for the fixes.** The pull request was green when the review came back.
  It was held anyway, because merging is what links the download from the public guide page,
  and a build whose Pause button does nothing should not be the first one strangers get.
- **The web pages are now tested in Safari's engine too.** Everyone who gets a recap on an
  iPhone opens it in Safari, and until now every browser test had run in Chromium. The
  story, the maker and the Mac guide suites now also run in WebKit (on Linux and macOS) and
  in Firefox on every push. Almost everything that failed at first was a test leaning on
  Chromium's automation. One real fault turned up, in the maker under WebKit: pressing
  Create without a name could scroll the name field out of view. This is the engine in a
  test harness, not the Safari app on a phone, which stays on the list of things to check
  on a real device.
- **A failed test after the merge was treated as a possible fault, not as a flaky test.**
  One run failed on a commit that changed only wording: the one-time menu-bar message
  appeared twice and covered the buttons the test needed. The follow-up was not merged on
  the strength of "the app code is unchanged". Four likely causes were tested in CI and
  ruled out, and the failure never came back, so the cause is recorded as unknown. What was
  done instead: the message's bookkeeping was made stricter in the app, the tests now
  assert that it appears exactly once (after OK, after a double close request, and after
  its Quit button), the two-chat sequence runs seven times per CI run, and test builds log
  every window event. The temporary code used to replay the old behaviour was removed
  before merging. No test was skipped or loosened.
- **Accepted, not changed.** A person without a contact name whose handle is an e-mail
  address shows as the part before the `@` (up to 16 characters), which can be a full name;
  and two people who share a first name and an initial are shown with their full contact
  names. Both follow [`SCHEMA.md`](SCHEMA.md) §2 and are what makes people recognisable to
  their own chat; the confirmation sheet says first names "and counts", which is the usual
  case, not a guarantee.

### D18 — Results that match the chat (2026-11-15)
The owner ran it on a real chat and said the results read like boilerplate: it called the
chat "The Night Owls" while most of its messages were sent at 11 AM. They asked for
pattern matching: a set of lines for each part of the recap, picked by how the chat behaves.

- **The cause of the Night Owls case.** The old rule gave that title to any chat with 12% of
  its messages after midnight, checked it before anything else, and then printed the peak
  hour next to it ("Peak hour: 11 AM. Sleep is a suggestion."). Two of the invented test
  chats had the same fault in some time zones.
- **Personality: the trait a chat is most extreme in.** Both engines now measure eighteen
  traits: one person or two carrying the chat, everyone talking about equally, nights,
  weekends, weekdays only, no quiet hour, activity on nearly every day, one huge day, one
  huge month, sheer volume, a slow trickle, mostly photos, tapbacks on everything, mostly
  laughs, mostly hearts, long messages and very short ones. Each has a bar a chat must pass
  and a point where it counts as extreme. The trait furthest past its bar wins. When
  nothing stands out, the peak hour decides, as before.
- **Every title states the number that earned it.** "52% of messages on Saturday and
  Sunday", "Active on 301 of 314 days", "Peak hour: 11 AM". The text reply uses the same
  sentence. Night Owls now needs a quarter of all messages after midnight, or a peak hour
  between midnight and 5 AM.
- **No names in the title's sentence.** It is not rewritten when names are shortened, so a
  name there could have leaked a full contact name.
- **Each slide picks its headline from a set of patterns**, first match wins, and the old
  line is always the last one, so a slide can never be left without a headline. A headline
  may only claim what a number on the same slide shows. Patterns that need a full week or a
  full year are skipped on thin data, and months after the end of the period never count as
  quiet months.
- **Seven new awards** from things already in the messages: who sends the first and the
  last message of the day, who asks the most questions, who shares the most links, who
  writes before 9 AM, who sends the longest run in a row, and who uses the fewest words.
  The Lurker moved to the end of the list so the quietest person gets something more
  specific when they earned it.
- **The bars are first guesses.** There is no real chat data to tune them on, by design.
  Four were raised as soon as the invented test chats showed them to be too easy: The Daily
  Ritual (from 92% of days to 97%), The Hype Squad (to a tapback for every other message),
  and the Novelist and Minimalist awards, which went to somebody in nearly every chat
  ("A paragraph person." for someone averaging five words). The rest wait for feedback on
  real recaps. All of them are one table in [`SCHEMA.md`](SCHEMA.md) §3 and §4.
- **The typing-dots waits are gone.** The cover and the personality slide held their
  content back for about two seconds behind a typing bubble. The owner found it pointless,
  and it was. Content now starts at once.
- **Old links keep what they say.** A recap is whatever its link holds, so a link made by an
  older build still shows the personality that build gave it. A new `/wrapped` gives the
  new one.
- **The demo follows its own numbers.** The invented demo chat used to be "The Night Owls"
  with 13% of its messages after midnight. Under the new rule it is "The Firehose" (154
  messages a day), and the pictures made from it were redone.
- **The iPhone app's sample had been left behind.** It was a separate copy of the old demo
  and would have gone on saying "The Night Owls. Peak hour: 11 PM." It is now built from
  the site's demo by a script, and a test fails if the two ever differ. The old-shape test
  recap that every engine reads stays as it is: it proves that links made by older builds
  still open.
