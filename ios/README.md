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
| `MessagesExtension/` | `MessagesViewController` (the launcher: paste a recap link, your recaps, see a sample; the story in the expanded style) and the iMessage app icon. |
| `Shared/` | Compiled into both targets: payload codec with its size caps, link rules, link builder and length budget, `StoryWebView` (a web view locked to the bundled story, warmed up early) and `StoryViewController` (loading cover + embed bridge), share-card renderer, launcher view, message composer, design tokens, the brand mark (`Brand.xcassets`). |
| `PlaceholderWeb/` | Small stand-in story that implements the embed bridge; bundled only if `../web/index.html` does not exist. |
| `Tests/Unit/` | Codec against `tests/vectors/payload-v1.json`, hostile payloads (overlong, deflate bomb, truncated), which links are accepted, trim ladder, `MSMessage` round trips, what is kept, the web view's rules, offscreen renders of the card. |
| `Tests/UI/` | App UI tests with screenshots, and the walkthrough inside the Simulator's Messages app. |
| `scripts/` | `sync-web.sh` (bundle the story, without the recap maker), icon / sample-payload / test-recap generators, CI helpers. |

How the pieces talk (contract: [`docs/SCHEMA.md`](../docs/SCHEMA.md)):

- A recap is a payload string (`base64url(raw DEFLATE(JSON))`) carried in a link,
  `https://averyhsu.github.io/imessage-wrap/#w1=<payload>`. `WrappedConfig.linkForm` is the
  one switch between the `#w1=` and `?w1=` forms; parsing always accepts both.
- A message bubble is an `MSMessage` whose `url` is that https link, so people without the
  app (and Macs) still get the web story. Links over 4,800 characters are trimmed with the
  ladder in SCHEMA §5 before they are sent.
- The bubble is a card (`MSMessageTemplateLayout`): a natively rendered image (chat name,
  "2026 in review", message count) with a caption and subcaption. Everyone sees it, with
  or without the app. The built-in sample says "Sample" on the card and in the caption.
- The story page talks to Swift through `window.webkit.messageHandlers.wrapped` (SCHEMA §6).

Input is treated as hostile (links, the clipboard and other people's messages all end up
in the same decoder):

- **Which links are opened.** Only `threadback://recap#w1=…` (the app's own scheme, host
  `recap`) and the https story page (`https://averyhsu.github.io/imessage-wrap/`, also with
  `index.html`, with `#w1=` or `?w1=`). Any other scheme, host or path is refused, by the
  app (`AppModel.open`), by Paste and for the message a bubble carries (`RecapLink.isRecapLink`).
  The scheme is one build setting, `APP_URL_SCHEME` in `project.yml`.
- **Size caps.** A payload longer than 8,000 characters is refused before it is decoded,
  and inflating stops at 256 KB of output (`RecapPayload`), so a small link cannot balloon
  in memory inside the extension. Truncated or damaged DEFLATE is refused.
- **The web view stays on the bundled story.** `StoryWebView` cancels every navigation
  that is not the bundled `web/index.html` (a tapped http(s) link is handed to the app to
  open outside; the extension ignores it), loads nothing into frames, and only listens to
  bridge messages from the main frame of that page.
- **Debug hooks are debug only.** The launch arguments below and the two invisible test
  controls in the launcher are compiled out of release builds.

What is kept on the device: only recaps the person pasted or sent themselves, as payload
strings in `UserDefaults` (the app and the extension each keep their own short list, shown
as "Your recaps" with a **Clear** control). A recap that arrived in a conversation, or was
opened from a link, is played and not kept; the sample is never kept.

While a story gets ready the screen is never black: the recap's own cover (brand gradient,
chat name, "2026 in review", message count) is drawn natively at once and cross-fades into
the story when the page reports `ready`. The web view is created early (when the home
screen or the launcher appears), loads the story page and waits; opening a story hands it
the recap through the page's `#w1=` fragment, and closing it returns the web view to the
pool (`StoryWebViewPool`).

One brand mark everywhere: the purple speech bubble with three bars of the app icon, the
iMessage app icon, the home screen and the launcher (`scripts/make-icons.py` draws them all).

Experimental and **off by default**: `WrappedConfig.useLiveLayout = true` wraps the card
in an `MSMessageLiveLayout`, which draws a native view in the bubble for people who have
the app. It is not part of the product (see "Found along the way").

## Build locally (a Mac with Xcode 26 or later)

```sh
brew install xcodegen
cd ios && ./scripts/sync-web.sh && xcodegen && open Wrapped.xcodeproj
```

Pick the `Wrapped` scheme and an iPhone simulator, then Run. No signing team is needed for
the Simulator. Rerun `./scripts/sync-web.sh && xcodegen` after `../web/` changes.

To try the extension in the Simulator: run the app once, open Messages, open one of the two
simulated conversations, tap **+**, scroll the list and choose **Threadback**. Copy a recap
link first (any `https://averyhsu.github.io/imessage-wrap/#w1=…` link) and tap **Paste a
recap link**, or tap **See a sample**. What you send in one conversation arrives in the other.

Launch arguments, debug builds only: `--autoplay-demo` (start the sample story), `--gallery`
(debug gallery of the extension's native views, hosted in the app), `--open-url <link>`
(goes through the same link check as a link opened by the system), `--ui-testing`.

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
[`docs/screenshots/ios/README.md`](../docs/screenshots/ios/README.md) ("current run" below).

| Shown | How | Run |
|-------|-----|-----|
| The project generates and builds with no signing team; `WrappedMessages.appex` is embedded in the app and registered with the system (`pluginkit`). | build log | first in [43030079757](https://github.com/averyhsu/imessage-wrap/actions/runs/43030079757) |
| Codec against the shared vector, both link forms, the trim ladder (a 7,625-character link fits after one step). | unit tests on the Simulator | first in [43042222401](https://github.com/averyhsu/imessage-wrap/actions/runs/43042222401) |
| Hostile input: a payload over 8,000 characters is refused before decoding; a 1,378-character deflate bomb (1 MB of zeros) stops at the 256 KB cap; truncated DEFLATE is refused. | unit tests | current run |
| Only `threadback://recap` and the https story page are accepted as recap links (other hosts, paths, schemes, ports and user-info tricks are refused); the app registers exactly that scheme. | unit tests, UI test | current run |
| `MSMessage` keeps a `#fragment` URL unchanged in memory, through `copy()` and through `NSKeyedArchiver`. | unit tests on the Simulator | first in 43042222401 |
| The web view only hears the main frame of the bundled page, refuses script-driven navigation to the web or to other files, and plays again after being recycled without loading the page a second time. | unit tests with a real `WKWebView` | current run |
| The app plays the real web story; the bridge reports `ready` and `slide`; taps advance; a link passed at launch and a `threadback://` link opened by the system both play; links from elsewhere stay on Home. | UI tests, screenshots `app-*` | current run |
| A pasted recap is kept under "Your recaps" across launches and Clear forgets it; an opened recap and the sample are not kept; dragging the story down closes it. | unit tests, UI test | current run |
| Inside the Simulator's **Messages** app, the whole card flow: the extension is in the app drawer and opens in compact style; **Paste a recap link** stages the card; it is sent; tapping the card plays the story in the expanded style (the bridge reports `ready`, taps advance); the story's close control returns to compact, where the recap is now listed; **See a sample** plays without staging anything; **Clear** empties the list. | UI test, screenshots `messages-*` | current run |

Next to the screenshots there are two short recordings (`app-demo-story.mp4`, and
`messages-card-flow-3x.mp4`: the walkthrough inside Messages at three times the speed), and
`debug/`: the accessibility hierarchy of Messages at each step, which is what the
walkthrough test was written from. Apple documents no way to automate Messages; the test
relies on the element names iOS 26.5 happens to use (`add`, `sendButton`, the app's name in
the drawer) and is expected to need care on other versions, so CI treats it as allowed to
fail and reports its outcome separately.

Found along the way, in the Simulator:

- **The live bubble layout is not usable yet, so it is off.** A live bubble's view
  controller (transcript style) is never given its conversation: `willBecomeActive` does
  not run and `activeConversation` stays nil, on the sending and on the receiving end. The
  bubble cannot read its own message, so a received live bubble can only show a generic
  state. Whether a real iPhone behaves the same is unknown. CI still exercises it in a
  separate step; those captures are named `experimental-*` and are listed apart.
- Messages covers the top-left corner of a bubble's image with the app icon; the card keeps
  that corner clear.
- iOS asks "Threadback would like to paste from …" when the link was copied in another
  app. That is the system's own question and it is asked each time unless the person
  chooses otherwise in Settings.
- How long the story takes to be on screen is printed by the tests ("ready in … s" in
  `TEST-RESULTS.txt`): with the warmed-up web view it is a fraction of a second in the
  app; the first story in the extension still waits for the extension's web process on
  the CI simulator. A real phone is unmeasured.

Not shown by CI, because it needs real devices (checklist):

- [ ] The extension appears under **+** in Messages on a phone and opens in compact style.
- [ ] **Paste a recap link** stages the card after the system's paste question; a link
      that is not a recap link gives the notice instead.
- [ ] Sending works in a 1:1 chat and in a group; the recipient **with** the app sees the
      card and can tap it to play the story. Try iOS 17, 18, 26 and 27.
- [ ] The recipient **without** the app sees the same card; note what a tap does
      (browser or App Store).
- [ ] The `#w1=` fragment survives delivery: on the receiving phone the story plays the
      sender's recap. If not, set `WrappedConfig.linkForm = .query`.
- [ ] A Mac in the conversation shows the card and opens the https link in a browser.
- [ ] A group with an SMS/RCS member: what arrives (image plus link is the documented fallback).
- [ ] Opening a story shows the cover at once and the story within a moment, also for the
      first story after the phone restarts; the extension, which now keeps one web view
      warm while its launcher is open, is not killed for memory.
- [ ] Haptics fire; the share sheet opens from the extension; "Send to this chat" works,
      and from the sample it sends a card that says "Sample".
- [ ] A recap that arrived in a chat does not show up under "Your recaps", in that chat or
      any other; **Clear** empties the list in the extension and in the app.
- [ ] In the app, "Send to this chat" opens the system composer with the card attached.
- [ ] `threadback://recap#w1=…` links open the app from Safari and Notes; any other
      `threadback://` link opens the app on Home with the notice.
- [ ] Only as an experiment (`WrappedConfig.useLiveLayout = true`): does a recipient's live
      bubble show the recap, the generic state seen in the Simulator, or "Loading…"?
