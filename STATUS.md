# Status

_Last updated: 2026-11-11. Builds landing; independent review still to come._

Everything below was built and tested without a real iPhone or Mac at hand: on Linux, and on
GitHub's macOS runners for the Apple parts. "Seen working" means it ran here, or in a CI run
that passed and whose output was looked at. Nothing is listed on a build agent's word alone.

## What works

| Piece | What has been seen working | Where |
|-------|----------------------------|-------|
| **Story** (the tap-through recap) | All 12 slides render and animate from invented data in a real browser; opened from a recap link built by the command-line tool with matching numbers; zero outside requests. Recorded as video. | `web/`, [screenshots](docs/screenshots/web/), [recording](docs/media/demo-story.mp4) |
| **Stats engines** (Python + JavaScript) | Both give byte-identical results on every invented chat, period and time zone in the conformance suite, and match a chat whose numbers were worked out by hand. On a macOS runner they decode text archived by Apple's own code. | `wrapped/`, `web/make/engine.js`, `tests/` |
| **Command-line tool** | `wrapped chats`, `wrapped stats`, `wrapped link` on the invented database. | `wrapped/cli.py` |
| **Mac helper** (`/wrapped`) | Everything up to the moment of sending: finds the command, builds the card, text and link, verifies sends against the database (with a fake Messages). The send script compiles against the real Messages scripting dictionary on macOS 26. The installer runs for real on a clean macOS runner. | `wrapped/mac/`, [guide](docs/MAC.md) |
| **iPhone app** | Builds on a macOS runner with no signing; unit and UI tests pass in the iOS Simulator; plays the real story; opens recap links. | `ios/`, [screenshots](docs/screenshots/ios/) |
| **Messages extension** | In the Simulator's real Messages app: appears in the app drawer, shows its launcher, sends a recap bubble ("Delivered"), and the bubble can be tapped. Being finished: proof that the story plays in the expanded view, and the bubble showing the recap's own numbers. | `ios/MessagesExtension/` |
| **Maker page** ("make your own" in the browser) | In progress. | `web/make/` |

CI (GitHub Actions, on this branch): `Web story`, `engine`, `Mac helper` and `iOS` workflows.
Latest results are on the [Actions page](https://github.com/averyhsu/imessage-wrap/actions).

## What does not work, or is not proven

These cannot be checked without real devices. None has been claimed as working.

1. **Sending into a real chat from the Mac helper.** On macOS 26 and 27 AppleScript sending to
   group chats is known to be fragile; the helper verifies every send and reports honestly,
   but only a real Mac can say whether your chats accept it.
2. **Reading a real Messages database.** The engines are tested against an invented
   database built to Apple's format, and against real archived text, but not against a
   database Messages itself wrote.
3. **Link behaviour inside Messages on a real phone**: whether the preview card (and its
   short video) appears, and whether the part of the link after `#` survives delivery.
4. **The Messages extension between two real phones**, in a group, and for people without
   the app.
5. **The iPhone-only Shortcut route** ([docs/SHORTCUT.md](docs/SHORTCUT.md)): a recipe, never
   run.
6. **Encrypted iPhone backups** are detected and explained, not read.
7. **AI-written awards** (`--ai`, optional, off by default): tested with a fake API; the
   real API has never been called (that would spend money).

## Your two-minute checks

Each is independent. Do them in any order; skip what you do not have.

**A. Mac, reading only (2 minutes, sends nothing)**
1. Install: see [docs/MAC.md](docs/MAC.md) (one line in Terminal).
2. Give Terminal Full Disk Access, reopen it, run `threadback doctor` then `threadback chats`.
   Do your group chats appear, with names and plausible counts?
3. `threadback preview --chat "<part of a chat name>" --open`. Do the card and the numbers
   look right?

**B. Mac, one real send (2 minutes, needs your yes below)**
1. `threadback doctor --automation` and allow the prompt.
2. `threadback send-test --chat "<a chat you choose>" --with-image`, type `send`.
   Did it say DELIVERED, and did the message arrive on your phone?

**C. iPhone, links (2 minutes, after the public site is on)**
1. Text yourself the site link on its own line. Does a preview card appear? Does it move?
2. On the maker page, tap "Try it with sample data", copy the link, text it to yourself,
   tap it. Does the story open with the sample chat's numbers? (This proves the link
   survives Messages.)
3. On the last slide, tap **Share card**. Does the share sheet offer the image?

**D. iPhone app on your own phone (about 10 minutes, free)**
Follow "Run it on your own iPhone" in [ios/README.md](ios/README.md), then its checklist.

**E. The Shortcut experiment (about 10 minutes, iOS 26.4 or later)**
[docs/SHORTCUT.md](docs/SHORTCUT.md), "The 10-minute device test".

## Decisions waiting for you

Nothing below has been done. Each needs your yes.

| Decision | What happens if yes | Cost |
|----------|--------------------|------|
| **Turn on the public site** (GitHub Pages) | The demo, the maker page and recap links work at `https://averyhsu.github.io/imessage-wrap/`. You switch it on in the repo's Settings → Pages → Source: "GitHub Actions", then run the "Publish site" workflow. | Free. The site is public. |
| **Merge this branch into `main`** | CI runs on `main`; the one-line installer works from `main`. | Free |
| **Send into a real group chat** | Check B above, then the Mac helper can answer `/wrapped` in chats you name. | Free. Messages come from your Apple ID. |
| **Apple Developer Program** | TestFlight for the iPhone app so other people can install it; later the App Store. | $99 a year |
| **Real AI awards** | `--ai` calls the Anthropic API with counts and first names only (no message text unless you add `--ai-quotes`). | A small API charge per recap; needs an API key |

## What's next

1. Finish the maker page and the two extension fixes; independent review; fix what it finds.
2. With your yes: public site on, then checks C and B.
3. With the developer program: TestFlight build, then real-phone checks of the extension.
4. If the Shortcut test (E) shows senders in group chats: make it the main iPhone route.

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
- Message text never leaves the device unless asked for, and unnamed members are shown as
  `…1234`, never as a phone number (D11, D12).
- No licence file has been added; choosing one is yours.
