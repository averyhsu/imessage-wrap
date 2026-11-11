# iOS app + iMessage app extension

A thin native shell around the web story. The animated recap is one web implementation
(`../web/`, bundled into the app); Swift adds the Messages integration, haptics and sharing.
The public product name is a single build setting (`PRODUCT_DISPLAY_NAME` in `project.yml`,
currently **Threadback**); target, module and file names keep the working name `Wrapped`.

Nothing here can be built in the Linux development sandbox. Everything is compiled and run
by the `iOS` workflow (`.github/workflows/ios.yml`) on a GitHub Actions macOS runner, which
publishes its Simulator screenshots to [`docs/screenshots/ios/`](../docs/screenshots/ios/).

## Layout

| Path | What |
|------|------|
| `project.yml` | XcodeGen spec. The `.xcodeproj` is generated and gitignored. |
| `App/` | Containing app (SwiftUI): home, full-screen story, link handling, debug gallery. |
| `MessagesExtension/` | `MessagesViewController` (compact launcher, expanded story, live bubble) and the iMessage app icon. |
| `Shared/` | Compiled into both targets: payload codec, link builder and length budget, `StoryViewController` (WKWebView + embed bridge), share-card renderer, live bubble view, launcher view, message composer. |
| `PlaceholderWeb/` | Small stand-in story that implements the embed bridge; bundled only while `../web/index.html` does not exist. |
| `Tests/Unit/` | Codec against `tests/vectors/payload-v1.json`, link parsing, trim ladder, `MSMessage` round trips, offscreen renders. |
| `Tests/UI/` | App UI tests with screenshots, plus the Messages automation attempt. |
| `scripts/` | `sync-web.sh` (bundle the story), icon and demo-payload generators, CI helpers. |

How the pieces talk (contract: [`docs/SCHEMA.md`](../docs/SCHEMA.md)):

- A recap is a payload string (`base64url(raw DEFLATE(JSON))`) carried in a link,
  `https://averyhsu.github.io/imessage-wrap/#w1=<payload>`. `WrappedConfig.linkForm` is the
  one switch between the `#w1=` and `?w1=` forms; parsing always accepts both.
- A message bubble is an `MSMessage` whose `url` is that https link, so people without the
  app (and Macs) still get the web story. Links over 4,800 characters are trimmed with the
  ladder in SCHEMA §5 before they are sent.
- The bubble uses `MSMessageLiveLayout` with an `MSMessageTemplateLayout` fallback (native
  share-card image, caption, subcaption). `WrappedConfig.useLiveLayout = false` ships
  template-only bubbles.
- The story page talks to Swift through `window.webkit.messageHandlers.wrapped` (SCHEMA §6).

## Build locally (a Mac with Xcode 26 or later)

```sh
brew install xcodegen
cd ios && ./scripts/sync-web.sh && xcodegen && open Wrapped.xcodeproj
```

Pick the `Wrapped` scheme and an iPhone simulator, then Run. No signing team is needed for
the Simulator. Rerun `./scripts/sync-web.sh && xcodegen` after `../web/` changes.

To try the extension in the Simulator: run the app once, open Messages, open a
conversation, tap **+** and choose **Threadback**.

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

## Proven on CI vs. needs a real iPhone

See the workflow run linked from [`docs/screenshots/ios/README.md`](../docs/screenshots/ios/README.md)
for the run that produced the current screenshots.

Proven on the Simulator in CI: the project generates and builds with no signing team; the
extension is embedded in the app and registered with the system (`pluginkit`); the unit
tests pass (codec vs the shared vector, both link forms, trim ladder, `MSMessage` keeping a
`#fragment` URL in memory); the app plays the bundled story in a `WKWebView` and the embed
bridge delivers `ready` / `slide` events (UI tests tap through it).

Real-iPhone checklist (none of this can be verified without devices):

- [ ] The extension appears under **+** in Messages and opens in compact style.
- [ ] "Send the demo recap" stages a bubble; sending works in a 1:1 chat and in a group.
- [ ] The recipient **with** the app sees the live bubble (not stuck on "Loading…"), and
      tapping it plays the story in the expanded style. Try iOS 17, 18, 26 and 27.
- [ ] The recipient **without** the app sees the template card; note what a tap does
      (browser or App Store).
- [ ] The `#w1=` fragment survives delivery: `selectedMessage.url` on the receiving phone
      still has it. If not, set `WrappedConfig.linkForm = .query`.
- [ ] A Mac in the conversation shows the card and opens the https link in a browser.
- [ ] A group with an SMS/RCS member: what arrives (image plus link is the documented fallback).
- [ ] The story's WKWebView runs inside the extension without being killed for memory;
      haptics fire; the share sheet opens from the extension; "Send to this chat" works.
- [ ] "Paste a recap link" in the extension (expect the system paste permission prompt).
- [ ] In the app, "Send to this chat" opens the system composer with the bubble attached.
- [ ] `imessagewrapped://recap#w1=…` links open the app from Safari and Notes.
