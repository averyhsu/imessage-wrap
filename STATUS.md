# Status

_Last updated: 2026-11-15._

**In one paragraph.** Threadback is live. The site is at
https://averyhsu.github.io/imessage-wrap/ and the main way to use it is a small Mac app:
one person in a group chat turns it on for that chat, and after that anyone in the chat
types `/wrapped` and that Mac answers in the thread with a recap picture, a short text and
a link to the full story. The app was set up by clicking on the owner's own Mac and answered
a real `/wrapped` there. For people without the app there is a maker that runs in the
browser. An iPhone app with a Messages extension is built and tested in the Simulator but
cannot be installed by other people yet. Everything else was built without a real iPhone or
Mac, so the things only a device can prove are listed below as unproven, each with a short
check you can run.

"Seen working" below means it ran here, or in a CI run that passed and whose output was
looked at, or (where it says so) on the owner's Mac. Nothing is listed on a build agent's
word alone.

## How the result measures against the goal

| Goal | Where it stands |
|------|-----------------|
| 1. Lives inside Messages | **Mostly.** `/wrapped` is typed in the chat and answered in the chat (seen on the owner's Mac). The story itself opens in the browser from the link; with the iPhone app it plays inside Messages (seen in the Simulator only, and nobody else can install that app until TestFlight). |
| 2. Works on iPhone, no Mac | **Watching: yes. Making: no, not proven.** Apple gives apps no way to read message history, so somebody's Mac (or an iPhone backup on a computer) has to do the counting. The only iPhone-only route is Apple's Shortcuts app; it has never been run on a real phone (check E). |
| 3. Works for everyone in the chat | **Yes for asking and watching**: anyone in the chat can type `/wrapped`, and the link opens in any browser, iPhone or Android. Unproven: how the link looks in a real thread. Where Messages shows no preview it is a long plain link. |
| 4. Almost no setup | **None for the chat.** One person sets up the Mac app, by clicking: about ten clicks, no Terminal, no Full Disk Access. Because the app is not signed through Apple's paid program, one of those steps is a detour through System Settings that a guide page walks through. |
| 5. Usable by strangers today | **Yes, with one rough edge.** The demo, the maker and the Mac app download are public. The rough edge is macOS's "Not Opened" block on first launch; removing it costs $99 a year (see decisions). The app has been proven on one Mac. |
| 6. Privacy | **Yes.** Counted on the device; no server; the recap travels in the part of the link that is never sent to a website; message text only if switched on; no phone numbers or addresses in a recap. Three independent reviews attacked this; what they found was fixed (see [DECISIONS](docs/DECISIONS.md) D13, D14, D17). |
| 7. LinkedIn-worthy | **The demo is, and `/wrapped` is the hook.** A real recap made with the defaults is plainer than the demo: first names, `…1234` for people who are not in your contacts until Contacts is allowed, and no message text. |

Every required part of the recap is there: totals; activity by hour, weekday and month; the
chat's personality; late-night messages; top senders; message of the year by tapbacks; a
shareable summary card; and optional AI-written awards (command-line helper only, never run
against the real API).

## What works

| Piece | What has been seen working | Where |
|-------|----------------------------|-------|
| **Mac app** (`/wrapped`) | **On the owner's own Mac (macOS 26.7.1, 2026-11-15):** installed from the disk image and set up by clicking only; read the real Messages history after one folder pick with no Full Disk Access; answered a real `/wrapped` in a group chat with the picture and the text, and found both afterwards in the Messages database with no error. In CI on a macOS 26 runner: builds; numbers and text reply byte-identical to the command-line tool on five invented chats; the link it builds decodes back to the same recap and the story plays from it in the app's own window; the download is fetched and opened the way a browser and a double-click would; the sender refuses to run. An independent review then found that Pause did not pause, among other faults; all were fixed before this version was merged and are covered by tests ([DECISIONS](docs/DECISIONS.md) D17). | `mac/`, [guide page](https://averyhsu.github.io/imessage-wrap/mac/), [write-up](docs/MAC-APP.md), [screenshots](docs/screenshots/mac/) |
| **Story** (the tap-through recap) | All 12 slides from invented data in a real browser, 3,986 automated checks across more than twenty different recaps and six screen sizes; each slide's headline is picked from a set of patterns by the chat's own numbers, and a check fails if any pattern is never shown; opened from a link built by the command-line tool with matching numbers; zero outside requests; hostile links do nothing. On the live site: the demo and a recap link were driven in a browser on 2026-11-15. The suite also passes in WebKit (the engine behind Safari, on Linux and on macOS) and in Firefox. | `web/`, [screenshots](docs/screenshots/web/), [recording](docs/media/demo-story.mp4) |
| **Maker page** | 568 checks: the invented Mac database with its write-ahead log, an iPhone backup folder, pasted exports and the sample chat all go from file to chat list to link; the numbers match the Python engine byte for byte; quotes off by default; the preview holds exactly what the link holds. Passes in WebKit and Firefox too, which found one real fault (pressing Create without a name could scroll the name field out of view in WebKit; fixed). Driven on the live site with sample data. | `web/make/`, [screenshots](docs/screenshots/web/) |
| **Stats engines** (Python + JavaScript) | Byte-identical results on every invented chat, period and time zone in the conformance suite; the personality (25 kinds, each with the number that earned it) and the 15 awards are held to a shared set of cases worked out by hand; match a chat whose numbers were worked out by hand and an independent recount by a reviewer. On a macOS runner they decode text archived by Apple's own code. | `wrapped/`, `web/make/engine.js`, `tests/` |
| **Command-line tool and helper** | `wrapped chats`, `stats`, `link` on the invented database; the Terminal version of `/wrapped` up to the moment of sending, against a fake Messages; its installer runs for real on a clean macOS runner. | `wrapped/`, [guide](docs/MAC.md) |
| **iPhone app** | Builds on a macOS runner with no signing; unit and UI tests pass in the iOS Simulator; plays the real story; opens recap links. Its built-in sample is the site's current demo, and a test fails if the two ever differ. | `ios/`, [screenshots](docs/screenshots/ios/) |
| **Messages extension** | In the Simulator's real Messages app, driven by UI tests: appears in the app drawer, sends a recap card ("Delivered"), a tap plays the story inside Messages, close returns to the launcher; also from the receiving side of the simulated chat. | `ios/MessagesExtension/` |

CI runs on `main`: `Web story`, `Make page`, `engine`, `Mac helper`, `iOS`, `Mac app`, plus
`Publish site`, which copies `web/` to the `gh-pages` branch the site is served from.
Results: [Actions](https://github.com/averyhsu/imessage-wrap/actions). Mac app builds are
on the [Releases page](https://github.com/averyhsu/imessage-wrap/releases).

After the last merge (2026-11-15) the public site was driven in a browser once more: the
front page, the demo story to its last slide, the Mac guide with its Download button, the
maker with sample data, and the link the maker produced. No errors, and no requests to any
other site.

## What is not proven

None of this has been claimed as working. It needs real devices.

**The Mac app**

1. **The link in a real chat.** The owner's test used a build that sent the picture and the
   text. The link was switched on afterwards; nobody has yet seen it arrive, or seen how
   Messages shows it (check 2).
2. **Staying connected.** Whether the app can still read Messages after it is quit and
   reopened, after the Mac restarts, and after a newer build is installed. For an update,
   expect macOS to ask for the folder and for control of Messages again (check 1).
3. **Other Macs.** One Mac on macOS 26.7.1 is one data point. Scripted sending to group
   chats is reported as fragile on some versions of macOS 26 and 27; the app checks each
   send and offers "send by hand" when it cannot confirm one.
4. **What the app says after a send.** It now looks for its own exact message and reports
   what Messages recorded: delivered, sent, or written but not yet sent. That check is
   stricter than the one in the owner's test and has only run against an invented database.
   Whether it recognises its own picture on a real Mac, and whether Messages ever marks a
   group message "delivered", is not known (check 2). In no case does the app know that
   every phone received the message.
5. **Names from Contacts.** Contacts was declined in the owner's test, so people showed as
   `…1234` (check 3).
6. **The first-open detour.** macOS's "Not Opened" window was photographed on the owner's
   Mac; the "Open Anyway" row in System Settings and the guide page's button that opens
   System Settings were not (check 4).
7. **The numbers on a real chat.** The app has read one real database and produced a
   recap. Nobody has compared its numbers with a hand count of a real chat.
8. **Whether the titles fit real chats.** The personality and the headlines are now picked
   by what the chat's numbers show ([DECISIONS](docs/DECISIONS.md) D18). The bars a chat
   must pass ("a quarter of messages after midnight" for Night Owls, and so on) are first
   guesses, checked only against invented chats. Say what your chat gets and whether it
   fits (check 2).

**One failed test run whose cause was not found.** After the merge, one CI run of the Mac
app failed. The one-time message "Threadback keeps answering from the menu bar" came up a
second time, over the status window, so the test's clicks on Turn off, Pause all and Quit
never landed. The app's code was the same as in the runs that had passed. It has not
happened again: the last four runs were green, and each repeats that sequence
seven times. Four likely causes were tested and ruled out; the real one is still unknown.
The app was changed so that each way the message could come back is closed (it counts as
shown the moment it appears, a second one cannot start while one is up, and settings are
saved before the app quits), and test builds now record every window event, so a repeat
would name its cause. On a real Mac the worst case is seeing that message twice and
clicking OK twice. Nothing is sent because of it.

**One slow iPhone test run.** While this change was in CI, one run of the iPhone app's
tests failed: a test that waits up to 30 seconds for the story's very first start in the
Simulator gave up. The same recap then started in 0.3 seconds in the same test, the other
69 tests passed, and that whole run was two to five times slower than usual. The next two
runs passed, one on the working branch and one on `main`. Measured here, the story's first
start is about 18% heavier than before (five more layout passes for the new lines), which
is not enough to explain it. GitHub does not let this session re-run a job, so the failed
run itself was never repeated.

**Everything else**

9. **The link on a real phone**: whether a preview card (and its short video) appears,
   whether the part after `#` survives delivery, and how a long link looks in a group with
   Android phones (check 2).
10. **Safari itself.** The story, the maker and the Mac guide pass their suites in WebKit,
   the engine behind Safari, and in Firefox. That is the engine in a test harness, not the
   Safari app on a real iPhone or Mac; nobody has opened a recap there yet (check 2 does).
   In Firefox one layout check is relaxed for emoji in the chat's name, and nobody has
   looked at that screen by eye.
11. **The maker page on a real Mac.** Whether Safari and Chrome let you pick or drag
    `chat.db` out of `~/Library/Messages` without extra permissions (check A).
12. **The Messages extension between two real phones**, in a group, and for people without
    the app. In the Simulator a *received* live bubble gets no data from Messages, so the
    app sends a plain card instead; real phones may differ (check D).
13. **Making a recap with only an iPhone.** The Shortcut recipe has never been run (check E).
14. **Encrypted iPhone backups** are detected and explained, not read.
15. **AI-written awards** (`--ai`, off by default, command-line helper only): tested with a
    fake API only.
16. **Large histories in the browser.** The engines have been through synthetic runs of
    500,000 rows; a real multi-year database has been through the Mac app on the owner's
    Mac, but not through the browser maker.

## Your checks

The first four are about the Mac app and matter most. Each takes a couple of minutes.

**1. Does it stay connected?** Quit Threadback (its window has **Quit Threadback**), open
it again from Applications. Does it still say it is connected, without asking for the
folder? Then restart the Mac and look once more.

**2. Does the link arrive?** Download the current build from the
[guide page](https://averyhsu.github.io/imessage-wrap/mac/) and install it over the old one.
Expect macOS to ask for the Messages folder and for control of Messages again. In a chat
whose members will not mind, type `/wrapped` from your phone.
- The app first shows "Replies in … now include a link". Click **Keep on**.
- Do three messages arrive: picture, text, link?
- Open Threadback from Applications. What does it say next to each of the three: delivered,
  sent, written, or not confirmed?
- How does the link look in the thread: a card with a picture, or a long plain link?
- Tap it on your phone. Does the story open with your chat's numbers?
- Which personality does it give your chat, and does it fit? Do the headlines on the
  slides match what you know about the chat? If one is off, say which and what the chat is
  really like.
- On the last slide tap **Share card**. Does the share sheet offer the image?

**3. Names.** In the app, allow Contacts when asked (or in System Settings → Privacy &
Security → Contacts). Do people now show by first name instead of `…1234`?

**4. The guide page on a Mac.** Open the
[guide page](https://averyhsu.github.io/imessage-wrap/mac/) in Safari and in Chrome. At the
"Open Anyway" step, does its button open System Settings at Privacy & Security? Does the
row there read the way the page says? If it reads differently, send the wording.

**Then, in the app's window, click _Copy test report_ and paste it back.** It has no names,
numbers or message text: only your macOS version, whether each step worked, and error
numbers.

The older checks, for the other routes:

**A. The maker on your Mac (sends nothing).** Open
https://averyhsu.github.io/imessage-wrap/make/ in Safari, then in Chrome. In Finder: Go →
Go to Folder… → `~/Library/Messages`. Drag `chat.db` and `chat.db-wal` onto the page. Does
your chat list appear? If the browser refuses, copy both files to the Desktop and drag
those. Pick a chat, create the recap. Do the numbers match what the Mac app shows?

**D. The iPhone app on your own phone (about 10 minutes, free).** "Run it on your own
iPhone" in [ios/README.md](ios/README.md), then the checklist there.

**E. The Shortcut experiment (about 10 minutes, iOS 26.4 or later).**
[docs/SHORTCUT.md](docs/SHORTCUT.md), "The 10-minute device test". If it reports senders in
group chats, making a recap with only an iPhone becomes real.

The Terminal version of `/wrapped` has its own checklist in [docs/MAC.md](docs/MAC.md); the
Mac app replaces it, so it is only worth running if you prefer Terminal.

## Decisions

Made by the owner:

| Decision | Outcome |
|----------|---------|
| **Public site** | **On since 2026-11-15.** Published from the `gh-pages` branch, which a workflow refreshes whenever `web/` changes on `main`. Keep the address: links already shared would stop working if the repo were renamed. |
| **Merge into `main`** | **Done 2026-11-15**, with a standing yes for follow-ups: changes are merged once their tests pass. |
| **Mac app builds on the Releases page** | **Yes, 2026-11-15.** Public downloads; no sign-in needed. |
| **The Mac app is the main way** | **Yes, 2026-11-12.** |
| **Apple Developer Program** ($99 a year) | **Declined for now, 2026-11-12.** |
| **Send into a real group chat** | Done by the owner in their own test on 2026-11-15. |

Still open, each needing your yes:

| Decision | What happens if yes | Cost |
|----------|--------------------|------|
| **Apple Developer Program** | The Mac app opens with one click instead of the System Settings detour, keeps its permissions across updates, and the iPhone app can go to TestFlight so other people can install it. Your legal name appears as the developer. | $99 a year |
| **A licence** | People may reuse the code on stated terms. Until then it is public but not open-source. | Free |
| **Real AI awards** | `--ai` in the command-line helper calls the Anthropic API with counts and first names only (no message text unless you add `--ai-quotes`). | A small API charge per recap; needs an API key |
| **Posting about it** | [docs/LINKEDIN.md](docs/LINKEDIN.md) is a draft and [docs/DEMO.md](docs/DEMO.md) a recording script. Nothing has been posted anywhere. | Free |

## What's next

1. Your checks 1 to 4, then fix whatever they turn up.
2. With the developer program: sign and notarize the Mac app, and a TestFlight build of the
   iPhone app, then check D between two phones.
3. Check E. If the Shortcut reports senders in group chats, build the last link for an
   iPhone-only path: the app takes the Shortcut's output and makes the recap itself.
4. Automatic updates for the Mac app (today a new version is a new download).
5. Reading encrypted iPhone backups in the browser (feasible; not built).

## Assumptions made along the way

- The brief names the repo `imessage-wrapped`; the repo this work was given is
  `averyhsu/imessage-wrap`, so all work is there. Development happens on branch
  `claude/imessage-wrapped-build-84gdoo` and is merged into `main` by pull request.
- No `imessage-wrapped.zip` was attached, so the prototype was recreated from its
  description.
- The repo is public, so nothing private is ever committed; all fixtures, screenshots and
  sample cards are invented. The owner's own test results are recorded only as "worked" or
  "did not", never with their chats' names or numbers.
- Public name "Threadback", to stay clear of the "iMessage" and "Wrapped" trademarks; code
  and the `/wrapped` command keep the working name ([DECISIONS](docs/DECISIONS.md) D4).
- Message text never leaves the device unless asked for; people are shown by first name,
  and anyone without a contact name as `…1234`, never as a phone number (D11, D12).
