# Status

_Last updated: 2026-11-15._

**In one paragraph.** The recap story, the browser maker, the command-line tool, the Mac
helper and the iPhone app with its Messages extension are all built and pass their tests.
The code is on `main` and the public site is live at
https://averyhsu.github.io/imessage-wrap/ (since 2026-11-15; the demo, a recap link, the
maker and the Mac page were driven there in a real browser the same day). A Mac app that
answers `/wrapped` is the main way to use it: it has been proven on the owner's own Mac and
is a public download on the Releases page.
Everything else was built without a real iPhone or Mac, so the things only a device can
prove are listed below as unproven, each with a short check you can run.

"Seen working" below means it ran here, or in a CI run that passed and whose output was
looked at. Nothing is listed on a build agent's word alone.

## How the result measures against the goal

| Goal | Where it stands |
|------|-----------------|
| 1. Lives inside Messages | **Partly.** The recap arrives in the thread as a link; with the iPhone app it is a card in the Messages app drawer that plays the story inside Messages (seen in the Simulator, one-to-one chat). The app cannot be installed by other people until TestFlight. The typed `/wrapped` command needs one person's Mac to be running the helper. |
| 2. Works on iPhone, no Mac | **Watching: yes. Making: unproven.** Apple gives apps no way to read message history. The only iPhone-only route is Apple's Shortcuts app plus the maker's paste box; it has never been run on a real phone (check E). Otherwise making a recap needs a Mac, or an iPhone backup on any computer. |
| 3. Works for everyone in the chat | **Yes for watching**, in any browser, iPhone or Android. Unproven: how the link looks in a real thread. Where Messages shows no preview it is a long plain link. |
| 4. Almost no setup | **None for viewers.** The maker of the recap has real setup: finding two files in a hidden folder (browser route), or Terminal and a permission (Mac helper). |
| 5. Usable by strangers today | **Not yet: two owner switches away** (public site, merge to `main`). After that: demo and maker for anyone with a browser; installer for Mac owners. |
| 6. Privacy | **Yes.** Counted on the device; no server; the recap travels in the part of the link that is never sent to a website; message text only if switched on; no phone numbers or addresses in a recap. Two independent reviews attacked this; what they found was fixed (see [DECISIONS](docs/DECISIONS.md) D13, D14). |
| 7. LinkedIn-worthy | **The demo is.** A real recap made with the defaults is plainer: first names, `…1234` for people who are not in your contacts until you name them, and no message text. |

Every required part of the recap is there: totals; activity by hour, weekday and month; the
chat's personality; late-night messages; top senders; message of the year by tapbacks; a
shareable summary card; and optional AI-written awards (Mac helper only, never run against
the real API).

## What works

| Piece | What has been seen working | Where |
|-------|----------------------------|-------|
| **Story** (the tap-through recap) | All 12 slides from invented data in a real browser (Chromium), 2,465 automated checks including 18 different recaps at 6 screen sizes; opened from a link built by the command-line tool with matching numbers; zero outside requests; hostile links do nothing. | `web/`, [screenshots](docs/screenshots/web/), [recording](docs/media/demo-story.mp4) |
| **Maker page** | In Chromium, 399 checks: the invented Mac database with its write-ahead log, an iPhone backup folder, pasted exports and the sample chat all go from file to chat list to link; the numbers match the Python engine byte for byte; quotes off by default; the preview holds exactly what the link holds. | `web/make/`, [screenshots](docs/screenshots/web/) |
| **Stats engines** (Python + JavaScript) | Byte-identical results on every invented chat, period and time zone in the conformance suite; match a chat whose numbers were worked out by hand and an independent recount by a reviewer. On a macOS runner they decode text archived by Apple's own code. | `wrapped/`, `web/make/engine.js`, `tests/` |
| **Command-line tool** | `wrapped chats`, `stats`, `link` on the invented database; one plain sentence instead of an error trace on damaged files. | `wrapped/cli.py` |
| **Mac helper** (`/wrapped`) | Everything up to the moment of sending, against a fake Messages: finds the command, replies only in chats approved by id, builds card, text and link, verifies sends. The send script compiles against the real Messages scripting dictionary on macOS 26; the installer runs for real on a clean macOS runner. | `wrapped/mac/`, [guide](docs/MAC.md) |
| **Mac app** | A double-clickable app that replaces the Terminal helper. In CI: builds on a macOS 26 runner; numbers and text reply byte-identical to the command-line tool on five invented chats; the download is fetched and opened the way a browser and a double-click would. **On the owner's own Mac (macOS 26.7.1, 2026-11-15): set up by clicking only, read the real Messages history after one folder pick with no Full Disk Access, and answered a real `/wrapped` in a group chat with image and text, both confirmed delivered.** Details in [MAC-APP.md](docs/MAC-APP.md). | `mac/`, [screenshots](docs/screenshots/mac/) |
| **iPhone app** | Builds on a macOS runner with no signing; unit and UI tests pass in the iOS Simulator; plays the real story; opens recap links. | `ios/`, [screenshots](docs/screenshots/ios/) |
| **Messages extension** | In the Simulator's real Messages app, driven by UI tests: appears in the app drawer, sends a recap card ("Delivered"), a tap plays the story inside Messages, close returns to the launcher; also from the receiving side of the simulated chat. | `ios/MessagesExtension/` |

CI on this branch: `Web story`, `Make page`, `engine`, `Mac helper`, `iOS`, `Mac app`. Results:
[Actions](https://github.com/averyhsu/imessage-wrap/actions).

## What is not proven

None of this has been claimed as working. It needs real devices, or your yes.

1. **The maker page on a real Mac.** Whether Safari and Chrome let you pick or drag
   `chat.db` out of `~/Library/Messages` without extra permissions is unknown (check A). The
   page and the story have only been driven in Chromium, never Safari.
2. **Reading a real Messages database.** The engines are tested against an invented
   database built to Apple's format and against real archived text, not against a database
   Messages itself wrote.
3. **Sending from the Mac helper.** On macOS 26 and 27 scripted sending to group chats is
   known to be fragile. The helper checks every send and reports honestly; only your Mac can
   say whether your chats accept it (check C).
4. **The link inside Messages on a real phone**: whether a preview card (and its short
   video) appears, whether the part after `#` survives delivery, and how a long link looks
   in a group with Android phones (check B).
5. **The Messages extension between two real phones**, in a group, and for people without
   the app. In the Simulator a *received* live bubble gets no data from Messages, so the app
   sends a plain card instead; real phones may differ (check D).
6. **Making a recap with only an iPhone.** The Shortcut recipe has never been run; nobody
   knows yet whether it reports who sent each message in a group (check E). The iPhone app
   itself only shows and sends recaps; it does not make them.
7. **Encrypted iPhone backups** are detected and explained, not read.
8. **AI-written awards** (`--ai`, off by default): tested with a fake API only.
9. **Large histories.** The biggest database tried is the invented one (thousands of
   messages) plus synthetic runs of 500,000 rows in the engines; a real multi-year,
   multi-hundred-megabyte database has not been through the browser.

## Your checks

Each is independent and takes about two minutes unless it says otherwise.

**A. The maker on your Mac (sends nothing)**
1. Get the pages running locally (README, "Try it"), open `http://127.0.0.1:4173/make/` in
   Safari, then again in Chrome.
2. In Finder: Go → Go to Folder… → `~/Library/Messages`. Drag `chat.db` and `chat.db-wal`
   onto the page. Does your chat list appear? If the browser refuses, copy both files to
   the Desktop and drag those.
3. Pick a chat, name anyone shown as `…1234`, create the recap. Do the numbers look right
   against what you know of the chat?

**B. Links on your iPhone (after the public site is on)**
1. Text yourself the site link on its own line. Does a preview card appear? Does it move?
2. Text yourself the link from check A (or the maker's sample-data link) and tap it. Does
   the story open with the right numbers? That proves the link survives Messages.
3. On the last slide tap **Share card**. Does the share sheet offer the image?

**C. The Mac helper (reading: free; one real send: needs your yes)**
1. Install it ([docs/MAC.md](docs/MAC.md)), give Terminal Full Disk Access, run
   `threadback doctor`, then `threadback chats`, then
   `threadback preview --chat "<part of a chat name>" --open`. Card and numbers right?
2. `threadback doctor --automation`, allow the prompt, then
   `threadback send-test --chat "<a chat you choose>" --with-image` and type `send`. Did it
   say DELIVERED, and did the message arrive on your phone?

**F. The Mac app prototype (two tests, about two minutes each)**
[docs/MAC-APP.md](docs/MAC-APP.md), "Two tests on your Mac": does one folder pick let it
read your messages, and does a reply to `/wrapped` arrive. These decide whether the
few-click setup is real on your Mac.

**D. The iPhone app on your own phone (about 10 minutes, free)**
"Run it on your own iPhone" in [ios/README.md](ios/README.md), then the checklist there.

**E. The Shortcut experiment (about 10 minutes, iOS 26.4 or later)**
[docs/SHORTCUT.md](docs/SHORTCUT.md), "The 10-minute device test". If it reports senders in
group chats, making a recap with only an iPhone becomes real.

## Decisions waiting for you

Nothing below has been done. Each needs your yes.

| Decision | What happens if yes | Cost |
|----------|--------------------|------|
| **Turn on the public site** (GitHub Pages) | **Done on 2026-11-15.** The site is published from the `gh-pages` branch, which a workflow refreshes whenever `web/` changes on `main`. Keep the address: links already shared would stop working if the repo were renamed. | Free. The site is public. |
| **Merging follow-ups** | **Standing yes from the owner (2026-11-15):** changes are merged into `main` once their tests pass, without asking each time. | – |
| **Merge into `main`** | **Done on 2026-11-15** at the owner's request. CI runs on `main`; the one-line installer and a plain `git clone` work. | Free |
| **Send into a real group chat** | Check C step 2, then the Mac helper can answer `/wrapped` in the chats you name. | Free. Messages come from your Apple ID. |
| **Apple Developer Program** | **Declined for now (owner, 2026-11-12).** It would give TestFlight for the iPhone app and a Mac app that opens with one click. Without it the Mac app ships by the free route (see [MAC-APP.md](docs/MAC-APP.md)). | $99 a year |
| **Finish the Mac app** | **Yes (owner, 2026-11-12):** the Mac app is the direction for `/wrapped`. Next: your two tests (check F), which decide how it is finished. | – |
| **Real AI awards** | `--ai` calls the Anthropic API with counts and first names only (no message text unless you add `--ai-quotes`). | A small API charge per recap; needs an API key |
| **A licence** | People may reuse the code on stated terms. Until then it is public but not open-source. | Free |

## What's next

1. The story link in the Mac app's replies (the site is live, so it can be switched on), then an independent review of the Mac app.
2. Check E. If the Shortcut reports senders in group chats, build the last link for an
   iPhone-only path: the app takes the Shortcut's output and makes the recap itself, so it
   can be sent from the Messages drawer without a browser.
3. With the developer program: a TestFlight build, then check D between two phones.
4. Safari and Firefox runs of the story and the maker in CI.
5. Reading encrypted iPhone backups in the browser (feasible; not built).

## Assumptions made along the way

- The brief names the repo `imessage-wrapped`; the repo this session was given is
  `averyhsu/imessage-wrap`, so all work is there, on branch
  `claude/imessage-wrapped-build-84gdoo` (the only branch this session may push to).
- No `imessage-wrapped.zip` was attached, so the prototype was recreated from its
  description.
- The repo is public, so nothing private is ever committed; all fixtures, screenshots and
  sample cards are invented.
- Public name "Threadback", to stay clear of the "iMessage" and "Wrapped" trademarks; code
  and the `/wrapped` command keep the working name ([DECISIONS](docs/DECISIONS.md) D4).
- Message text never leaves the device unless asked for; people are shown by first name,
  and anyone without a contact name as `…1234`, never as a phone number (D11, D12).
