# iOS app + iMessage app extension

A thin native shell around the web story. The animated recap is one web implementation
(`../web/`, bundled into the app); Swift adds the Messages integration, haptics and sharing.
The public product name is a single build setting (`PRODUCT_DISPLAY_NAME` in `project.yml`,
currently **Threadback**); target, module and file names keep the working name `Wrapped`.

Nothing here can be built in the Linux development sandbox. Everything is compiled and run
by the `iOS` workflow (`.github/workflows/ios.yml`) on a GitHub Actions macOS runner, which
publishes its Simulator screenshots and test results to
[`docs/screenshots/ios/`](../docs/screenshots/ios/).

## Layout

| Path | What |
|------|------|
| `project.yml` | XcodeGen spec. The `.xcodeproj` is generated and gitignored. |
| `App/` | Containing app (SwiftUI): home, full-screen story, link handling, debug gallery. |
| `MessagesExtension/` | `MessagesViewController` (compact launcher, expanded story, live bubble) and the iMessage app icon. |
| `Shared/` | Compiled into both targets: payload codec, link builder and length budget, `StoryViewController` (WKWebView + embed bridge), share-card renderer, live bubble view, launcher view, message composer, design tokens. |
| `PlaceholderWeb/` | Small stand-in story that implements the embed bridge; bundled only if `../web/index.html` does not exist. |
| `Tests/Unit/` | Codec against `tests/vectors/payload-v1.json`, link parsing, trim ladder, `MSMessage` round trips, offscreen renders. |
| `Tests/UI/` | App UI tests with screenshots, and the walkthrough inside the Simulator's Messages app. |
| `scripts/` | `sync-web.sh` (bundle the story), icon and demo-payload generators, CI helpers. |

How the pieces talk (contract: [`docs/SCHEMA.md`](../docs/SCHEMA.md)):

- A recap is a payload string (`base64url(raw DEFLATE(JSON))`) carried in a link,
  `https://averyhsu.github.io/imessage-wrap/#w1=<payload>`. `WrappedConfig.linkForm` is the
  one switch between the `#w1=` and `?w1=` forms; parsing always accepts both.
- A message bubble is an `MSMessage` whose `url` is that https link, so people without the
  app (and Macs) still get the web story. Links over 4,800 characters are trimmed with the
  ladder in SCHEMA §5 before they are sent.
- The bubble is an `MSMessageTemplateLayout`: a natively rendered share card (chat name,
  "2026 in review", message count) with a caption and subcaption. Everyone sees it,
  with or without the app. `WrappedConfig.useLiveLayout = true` wraps it in an
  `MSMessageLiveLayout`, which draws a native bubble view instead for people who have the
  app; it is off by default for the reason given under "What CI has shown".
- The story page talks to Swift through `window.webkit.messageHandlers.wrapped` (SCHEMA §6).

## Build locally (a Mac with Xcode 26 or later)

```sh
brew install xcodegen
cd ios && ./scripts/sync-web.sh && xcodegen && open Wrapped.xcodeproj
```

Pick the `Wrapped` scheme and an iPhone simulator, then Run. No signing team is needed for
the Simulator. Rerun `./scripts/sync-web.sh && xcodegen` after `../web/` changes.

To try the extension in the Simulator: run the app once, open Messages, open one of the two
simulated conversations, tap **+**, scroll the list and choose **Threadback**. What you
send in one conversation arrives in the other.

Launch arguments: `--autoplay-demo` (start the demo story), `--gallery` (debug gallery of
the extension's native views, hosted in the app), `--open-url <link>`, `--ui-testing`.

## Run it on your own iPhone (free, no paid program)

A free Apple ID ("Personal Team") can install the app and its Messages extension on your
own phone for 7 days at a time. This is the first real-device test to do.

1. Xcode → Settings → Accounts → add your Apple ID.
2. Select the project → for the `Wrapped` **and** `WrappedMessages` targets, Signing &
   Capabilities → Team: your Personal Team. If the bundle identifier is taken, change the
   prefix `io.github.averyhsu.wrapped` in `project.yml` (keep the extension's
   `<app id>.MessagesExtension` suffix).
3. Connect the iPhone, enable Developer Mode on it (Settings → Privacy & Security), Run.
4. On the phone: Settings → General → VPN & Device Management → trust your developer
   certificate, then open the app once.

## What needs a paid Apple Developer membership (99 USD a year)

- TestFlight and the App Store, which is the only way anyone else can install it.
- Builds that last longer than 7 days, or more than a few apps per free account.
- App Review (guidelines that apply are listed in `docs/research/`).

## What CI has shown, and what it has not

Everything below ran on a GitHub-hosted macOS runner: Xcode 26.6, iPhone 17 Pro simulator,
iOS 26.5. The run behind the current screenshots, with its complete list of test cases and
the notes the tests print, is linked from
[`docs/screenshots/ios/README.md`](../docs/screenshots/ios/README.md).

| Shown | How | First run |
|-------|-----|-----------|
| The project generates and builds with no signing team; `WrappedMessages.appex` is embedded in the app and registered with the system (`pluginkit`). | build log | [43030079757](https://github.com/averyhsu/imessage-wrap/actions/runs/43030079757) |
| Codec against the shared vector, both link forms, the trim ladder (a 7,625-character link fits after one step), recents store. | unit tests on the Simulator | [43042222401](https://github.com/averyhsu/imessage-wrap/actions/runs/43042222401) |
| `MSMessage` keeps a `#fragment` URL unchanged in memory, through `copy()` and through `NSKeyedArchiver`. | unit tests on the Simulator | 43042222401 |
| The app plays the real web story in a `WKWebView`; the bridge reports `ready` and `slide`; taps advance; a link passed at launch and an `imessagewrapped://` link opened by the system both play. | UI tests, screenshots `app-*` | 43042222401 |
| Inside the Simulator's **Messages** app: the extension is in the app drawer, opens in compact style, stages a bubble, sends it ("Delivered"); tapping the bubble plays the story in the expanded style (the bridge reports `ready`, taps advance); the story's close control returns to compact. | UI tests, screenshots `messages-*` | [43047037123](https://github.com/averyhsu/imessage-wrap/actions/runs/43047037123) |
| The same message at the other end of the Simulator's simulated chat (a received bubble): it arrives, the conversation list shows its summary text, and tapping it plays the sender's recap. | UI test, screenshots `messages-live-9*` | [43050898939](https://github.com/averyhsu/imessage-wrap/actions/runs/43050898939) |

Found along the way, in the Simulator:

- **Live layout cannot show the recap to a recipient.** A live bubble's view controller
  (transcript style) is never given its conversation: `willBecomeActive` does not run and
  `activeConversation` stays nil, on the sending and on the receiving end. The bubble
  cannot read its own message, so a received live bubble shows a generic "Open to play
  this recap" state (tapping it still plays the right story, because the expanded instance
  does get the message). That is why bubbles are template cards by default. Whether a real
  iPhone behaves the same is unknown.
- Messages covers the top-left corner of a live bubble with the app icon; the live bubble
  layout keeps that area clear.
- On the CI simulator the story is on screen about 4 s after it is opened in the app and
  6 to 10 s in the extension (the first web view of a process is slow to start there). A
  real phone should be much faster; that is unmeasured.

Not shown by CI, because it needs real devices (checklist):

- [ ] The extension appears under **+** in Messages on a phone and opens in compact style.
- [ ] Sending works in a 1:1 chat and in a group; the recipient **with** the app sees the
      card and can tap it to play the story. Try iOS 17, 18, 26 and 27.
- [ ] The recipient **without** the app sees the same card; note what a tap does
      (browser or App Store).
- [ ] With `WrappedConfig.useLiveLayout = true`: does a recipient's live bubble show the
      recap (chat name and count), or the generic state seen in the Simulator, or
      "Loading…"? Only turn live layout on for good if it shows the recap.
- [ ] The `#w1=` fragment survives delivery: on the receiving phone the story plays the
      sender's recap. If not, set `WrappedConfig.linkForm = .query`.
- [ ] A Mac in the conversation shows the card and opens the https link in a browser.
- [ ] A group with an SMS/RCS member: what arrives (image plus link is the documented fallback).
- [ ] The story's WKWebView runs inside the extension without being killed for memory;
      haptics fire; the share sheet opens from the extension; "Send to this chat" works.
- [ ] "Paste a recap link" in the extension (expect the system paste permission prompt).
- [ ] In the app, "Send to this chat" opens the system composer with the bubble attached.
- [ ] `imessagewrapped://recap#w1=…` links open the app from Safari and Notes.
