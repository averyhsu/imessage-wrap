# iMessage app extensions (Messages framework)

Researched 2026-11-11. iOS 27 is released; its SDK docs and release notes were checked.

**Verdict.** An iMessage app extension is the only sanctioned way to put custom UI inside a Messages thread, but it is blind: it cannot read history, counts, names, the chat name or tapbacks, and that has not changed from iOS 10 through iOS 27. Used alone it cannot compute a recap. It is a good *viewer and share surface* for a recap computed elsewhere: up to 5,000 characters of state travel in `MSMessage.url`, shown as a static card to everyone and as native animated UI to members who installed the app. Every viewer needs an App Store or TestFlight install, and the in-bubble "live layout" has open bugs on iOS 17 to 27.

Reach limits of this research: only developer.apple.com and GitHub were reachable. Stack Overflow, support.apple.com and news sites were blocked, so facts from them are marked "search snippet".

## Answers

**1. What can it read?** Three things on [`MSConversation`](https://developer.apple.com/documentation/messages/msconversation): `localParticipantIdentifier`, `remoteParticipantIdentifiers`, `selectedMessage`. No history, counts, handles, chat name, chat ID or tapbacks.
- The UUIDs are "scoped to this device", stable only while the extension stays enabled, and change on reinstall ([docs](https://developer.apple.com/documentation/messages/msconversation/localparticipantidentifier)). Each device sees different UUIDs for the same person ([`senderParticipantIdentifier`](https://developer.apple.com/documentation/messages/msmessage/senderparticipantidentifier)).
- Apple: "we don't expose contact information at all to iMessage apps", and "only the tapped message is available to your iMessage app" ([WWDC16 224](https://raw.githubusercontent.com/ASCIIwwdc/wwdc-session-transcripts/master/en/2016/224.vtt)).
- `didReceive` fires only while the extension is active and only for its own messages: "You cannot interact with messages from other extensions" ([docs](https://developer.apple.com/documentation/messages/msmessagesappviewcontroller/didreceive%28_:conversation:%29)).
- Names: writing `$<uuid>` in template text makes Messages draw the contact name; the extension never sees it (WWDC16 224). **UNVERIFIED** on iOS 26/27; settle by sending a caption containing `$` + `localParticipantIdentifier.uuidString`.
- Changes: none to the read surface. Every member of `MSConversation`, `MSMessage` and `MSMessagesAppViewController` dates from iOS 10 to 12. iOS 17 added drag-to-resize ([framework page](https://developer.apple.com/documentation/messages)). iOS 26 added only `messageTintColor`, `messageCornerRadius` and `invalidateMessageTintColor()` ([docs](https://developer.apple.com/documentation/messages/msmessagesapptranscriptpresentation)). iOS 27 added only [`MSUPIRequest`](https://developer.apple.com/documentation/messages/msupirequest), an unrelated SMS payment check. The [iOS 26](https://developer.apple.com/documentation/ios-ipados-release-notes/ios-ipados-26-release-notes) and [iOS 27](https://developer.apple.com/documentation/ios-ipados-release-notes/ios-ipados-27-release-notes) release notes list no extension API changes.

**2. `MSMessage.url` and `MSSession`.** "The URL property must use an HTTP, HTTPS, or data scheme. Custom app schemes are not supported. Additionally, the URL cannot be longer than 5,000 characters." ([docs](https://developer.apple.com/documentation/messages/msmessage/url); error `urlExceedsMaxSize` in [`MSMessageErrorCode`](https://developer.apple.com/documentation/messages/msmessageerrorcode)). A 2016 test found 5,114 worked and 5,115 failed, and Apple staff confirmed a limit exists ([forum 52504](https://developer.apple.com/forums/thread/52504)).
- Fragment (`#...`) preservation: not documented. **UNVERIFIED**; settle by sending `https://host/v#payload` between two iPhones and a Mac and reading `selectedMessage.url`.
- Whole-message size: no documented limit. Template images are recommended at about 300 x 300 pt at 3x and are transcoded on send (WWDC16 224).
- [`MSSession`](https://developer.apple.com/documentation/messages/mssession) has no properties. A new message with the same session replaces the earlier bubble, which collapses to its `summaryText`.

**3. Template vs live layout.** [`MSMessageTemplateLayout`](https://developer.apple.com/documentation/messages/msmessagetemplatelayout) is image or media plus six text fields and the app icon. [`MSMessageLiveLayout`](https://developer.apple.com/documentation/messages/msmessagelivelayout) renders your view controller in the bubble only on iOS 11+ with the app installed; all other devices get the mandatory `alternateLayout`, "including devices that do not support iMessage apps (macOS, iOS 9 and earlier, and SMS devices)" ([docs](https://developer.apple.com/documentation/messages/msmessagelivelayout/alternatelayout)). See the table for each platform.
- No app, tap: the "Get <App>" attribution under the bubble opens the App Store ([WWDC16 204](https://raw.githubusercontent.com/ASCIIwwdc/wwdc-session-transcripts/master/en/2016/204.vtt), [forum 66643](https://developer.apple.com/forums/thread/66643)). Tapping the bubble itself is **UNVERIFIED**: the SDK header says an HTTP(S) URL "will be loaded in a web browser" when no app can consume it ([MSMessage.h](https://raw.githubusercontent.com/xybp888/iOS-SDKs/master/iPhoneOS18.0.sdk/System/Library/Frameworks/Messages.framework/Headers/MSMessage.h)), while Stack Overflow reports (search snippet) say the App Store opens. Settle on an iOS 27 phone that never had the app.
- macOS: yes. "If the message is selected on macOS, the system loads the URL in a web browser." HTTP(S) only (WWDC16 224).

**4. Live layout constraints.**
- Size: [`contentSizeThatFits(_:)`](https://developer.apple.com/documentation/messages/msmessagesapptranscriptpresentation/contentsizethatfits%28_:%29) must return no more than the offered maximum.
- Input: "Stick to simple button taps and tap gestures"; "there's no keyboard input allowed" ([WWDC17 234](https://raw.githubusercontent.com/ASCIIwwdc/wwdc-session-transcripts/master/en/2017/234.vtt)). Animation is allowed; the session demo shows a live countdown.
- Lifecycle: one controller per bubble, created on entering the conversation and torn down on leaving, "not an appropriate place to put something like a 3D game engine" (WWDC17 234). `didReceive`, `didSelect` and `willTransition` are not called in `.transcript`. [`requestPresentationStyle`](https://developer.apple.com/documentation/messages/msmessagesappviewcontroller/requestpresentationstyle%28_:%29) from a bubble opens a *new* compact or expanded instance.
- Memory: no documented limit. Controllers were reported never deallocated on scroll ([forum 102828](https://developer.apple.com/forums/thread/102828)).
- Reliability: bubbles stuck on "Loading..." since iOS 17, re-reported in July 2026 "in iOS 26 and 27", no fix posted ([forum 742268](https://developer.apple.com/forums/thread/742268)). Cancelling a Tapback kills touches ([forum 715455](https://developer.apple.com/forums/thread/715455)).
- `WKWebView`: nothing forbids it and it runs in other extension types ([forum 805658](https://developer.apple.com/forums/thread/805658)). Inside Messages it is **UNVERIFIED**; settle by loading bundled HTML in compact, expanded and transcript styles on a device and watching for memory kills.

**5. Groups.** Supported: "iMessage apps are going to be used in group conversations" (WWDC16 224). Restrictions: per-device UUIDs, no member list beyond a count, session updates race, and Apple recommends server state. A group with SMS/RCS members: **UNVERIFIED** (see table).

**6. Sending without the arrow.** `insert` stages the message and the user taps Send ([docs](https://developer.apple.com/documentation/messages/msconversation/insert%28_:completionhandler:%29-3g248)). [`send`](https://developer.apple.com/documentation/messages/msconversation/send%28_:completionhandler:%29-9krz) (iOS 11+) sends at once, but only when the extension is visible and has a recent touch; otherwise it fails with `sendWhileNotVisible` or `sendWithoutRecentInteraction`. One send per touch: "Subsequent direct send calls will fail until we detect another user interaction" (WWDC17 234).

**7. Text triggers and deep links.** None. The extension activates only "when the user selects the extension from the app drawer, and when the user selects a message in the transcript" created by it ([docs](https://developer.apple.com/documentation/messages/msmessagesappviewcontroller/willbecomeactive%28with:%29)). It cannot see typed text. Ordinary links open Safari or the containing app. The extension can open only its parent app, and only if that app has a Home Screen icon ([`NSExtensionContext.open`](https://developer.apple.com/documentation/foundation/nsextensioncontext/open%28_:completionhandler:%29)). Tapping one of its own bubbles is the only in-thread entry.

**8. Finding it.** Apple: "the list of iMessage apps that appears when you press the plus button" ([docs](https://developer.apple.com/documentation/messages/msmessagesapppresentationcontext/messages)). In iOS 17 third-party apps sit under "More" ([forum 748073](https://developer.apple.com/forums/thread/748073)). iOS 26 redesigned the "+" list: scroll for all apps, hold to reorder (search snippet). Installed apps are enabled by default since iOS 11 (WWDC17 234). Discoverability is poor: several taps, and nothing prompts a member to look.

**9. Testing.** Simulator Messages shows "two ends of a simulated conversation" (WWDC16 224): one fake 1:1 chat, no real iMessage, no group.
- Automation: Apple documents none. The community approach is XCUITest against `XCUIApplication(bundleIdentifier: "com.apple.MobileSMS")` (2017 Stack Overflow, search snippet). **UNVERIFIED** on Xcode 26/27.
- Pitfalls: Xcode 15.3 to 16 beta would not install the template extension until the container app scheme ran once, and ran stale builds (forum 748073). Fix by erasing the simulator and opening Messages once ([forum 758827](https://developer.apple.com/forums/thread/758827)). A missing iMessage App Icon gives "unknown to FrontBoard" ([forum 797781](https://developer.apple.com/forums/thread/797781)). Sent `MSMessage`s vanished in iOS 17 simulators ([forum 740873](https://developer.apple.com/forums/thread/740873)). `didSelect` is unreliable on iPad on iOS 18 and 26 ([forum 816190](https://developer.apple.com/forums/thread/816190)). Xcode 26 and 27 release notes mention none of this.

**10. Distribution.** App Store or TestFlight: 10,000 external testers, public link, first build needs beta review ([TestFlight](https://developer.apple.com/testflight/)). Ad hoc and development builds reach registered devices only. Membership is 99 USD a year ([programs](https://developer.apple.com/programs/whats-included/)). Both shapes exist: standalone iMessage app with no Home Screen icon, or extension inside an iOS app ([Apple](https://developer.apple.com/imessage/), WWDC16 204). [Guidelines](https://developer.apple.com/app-store/review/guidelines/) that bite: 4.4 ("the extensions may not include marketing, advertising, or in-app purchases"), 2.5.16, 2.5.18 (no ads), 4.2 (minimum functionality), 4.2.3(i) (must work without another app), 5.1.1 and 5.1.2 (consent), 5.2.5 (must not resemble Messages).

**11. macOS.** No. Docs list Mac Catalyst availability, but Xcode refuses: "iMessage Applications are not available when building for Mac Catalyst." ([forum 731364](https://developer.apple.com/forums/thread/731364)). Apple staff: "iMessage stickers are not supported by Mac Catalyst." ([forum 650119](https://developer.apple.com/forums/thread/650119)).

## What every participant sees

| Platform | App installed | App not installed |
|---|---|---|
| iPhone, iPad (iMessage) | Live view in bubble if live layout, else template card. Tap opens the extension with `selectedMessage`. | Template card plus "Get <App>" link to the App Store. Bubble tap **UNVERIFIED** (browser or App Store). |
| Mac | Cannot install. | Template card; click opens an HTTP(S) `url` in the browser; `data:` does nothing. |
| Apple Watch | No extensions. | Card delivered since watchOS 3, hand off to iPhone (WWDC16 224). Today **UNVERIFIED**. |
| Vision Pro | Framework lists no visionOS support. | Presumably template card. **UNVERIFIED**. |
| SMS/RCS/Android member | n/a | Documented fallback is two messages: the image, then the HTTP(S) URL; `data:` URLs are dropped (WWDC16 224). In a mixed group this probably applies to every member. **UNVERIFIED** on iOS 27. |

## Scores (this path alone)

| Criterion | Score | Reason |
|---|---|---|
| In-Messages | 5 | Bubble and UI live in the thread. |
| iPhone-only | 5 | Runs entirely on iPhone and iPad. |
| Works for everyone | 2 | Full experience only with the app; Mac gets a web page, Android an image and link. |
| Low setup | 2 | Every viewer installs an app, then finds it under "+". |
| Usable by strangers today | 1 | Needs App Review or TestFlight beta review first. |
| Privacy | 4 | Extension sees nothing; payload rides inside iMessage. An HTTPS query string leaks to the web host on Mac click. |
| Wow factor | 4 | Native animated story in expanded view; in-bubble live view is flaky. |
| Feasibility | 1 | Cannot obtain any chat data. |
| Cost | 4 | 99 USD a year, no servers needed. |
| Time to demo | 2 | Needs a Mac with Xcode (this workspace is Linux) and real devices for group tests. |
| App Store/ToS risk | 3 | Public API only; risks are 4.2, iPad review, and the "Wrapped" name. |

## Implications for the build

- Use the extension as viewer and share surface only. Another path must produce the numbers and the names; the extension cannot identify the chat or its members.
- Pack the recap into 5,000 characters or fewer (compressed JSON, base64url), send one `MSMessage` with a template share card, and play the animated story in the expanded view on tap.
- Make the template card good on its own: it is what most members see.
- Use an `https` URL pointing at a static web viewer so Mac users get the story. Put the payload in the fragment if the test shows it survives; otherwise the host sees the stats and consent is needed.
- Treat live layout as optional polish. Avoid a `WKWebView` per bubble.
- Send with `insert`, or `send` from one explicit button tap.
- Ship app plus extension, not iMessage-only, and make iPad work.
- Keep UI in a framework testable from a host app in CI; treat Messages-hosted runs as manual smoke tests.
- Run the six **UNVERIFIED** device tests before committing: fragments, no-app tap, mixed-group fallback, `WKWebView` memory, `$uuid` names, Watch and Vision Pro.

## Sources

- https://developer.apple.com/documentation/messages
- https://developer.apple.com/documentation/messages/msconversation
- https://developer.apple.com/documentation/messages/msconversation/localparticipantidentifier
- https://developer.apple.com/documentation/messages/msconversation/remoteparticipantidentifiers
- https://developer.apple.com/documentation/messages/msconversation/selectedmessage
- https://developer.apple.com/documentation/messages/msconversation/insert(_:completionhandler:)-3g248
- https://developer.apple.com/documentation/messages/msconversation/send(_:completionhandler:)-9krz
- https://developer.apple.com/documentation/messages/msmessage
- https://developer.apple.com/documentation/messages/msmessage/url
- https://developer.apple.com/documentation/messages/msmessage/senderparticipantidentifier
- https://developer.apple.com/documentation/messages/msmessageerrorcode
- https://developer.apple.com/documentation/messages/mssession
- https://developer.apple.com/documentation/messages/msmessagetemplatelayout
- https://developer.apple.com/documentation/messages/msmessagelivelayout
- https://developer.apple.com/documentation/messages/msmessagelivelayout/alternatelayout
- https://developer.apple.com/documentation/messages/msmessagesapptranscriptpresentation
- https://developer.apple.com/documentation/messages/msmessagesapptranscriptpresentation/contentsizethatfits(_:)
- https://developer.apple.com/documentation/messages/msmessagesappviewcontroller
- https://developer.apple.com/documentation/messages/msmessagesappviewcontroller/willbecomeactive(with:)
- https://developer.apple.com/documentation/messages/msmessagesappviewcontroller/didreceive(_:conversation:)
- https://developer.apple.com/documentation/messages/msmessagesappviewcontroller/requestpresentationstyle(_:)
- https://developer.apple.com/documentation/messages/msmessagesapppresentationcontext/messages
- https://developer.apple.com/documentation/messages/msupirequest
- https://developer.apple.com/documentation/messages/icecreambuilder-building-an-imessage-extension
- https://developer.apple.com/documentation/foundation/nsextensioncontext/open(_:completionhandler:)
- https://developer.apple.com/documentation/ios-ipados-release-notes/ios-ipados-26-release-notes
- https://developer.apple.com/documentation/ios-ipados-release-notes/ios-ipados-27-release-notes
- https://developer.apple.com/documentation/xcode-release-notes/xcode-26-release-notes
- https://developer.apple.com/documentation/xcode-release-notes/xcode-27-release-notes
- https://developer.apple.com/design/human-interface-guidelines/imessage-apps-and-stickers
- https://developer.apple.com/imessage/
- https://developer.apple.com/app-store/review/guidelines/ (last updated October 16, 2026)
- https://developer.apple.com/testflight/
- https://developer.apple.com/programs/whats-included/
- WWDC16 204 transcript: https://raw.githubusercontent.com/ASCIIwwdc/wwdc-session-transcripts/master/en/2016/204.vtt
- WWDC16 224 transcript: https://raw.githubusercontent.com/ASCIIwwdc/wwdc-session-transcripts/master/en/2016/224.vtt
- WWDC17 234 transcript: https://raw.githubusercontent.com/ASCIIwwdc/wwdc-session-transcripts/master/en/2017/234.vtt
- SDK header mirror: https://raw.githubusercontent.com/xybp888/iOS-SDKs/master/iPhoneOS18.0.sdk/System/Library/Frameworks/Messages.framework/Headers/MSMessage.h
- https://developer.apple.com/forums/thread/52504 (URL length)
- https://developer.apple.com/forums/thread/66643 ("Get <App>" attribution)
- https://developer.apple.com/forums/thread/102828 (live layout controllers not released)
- https://developer.apple.com/forums/thread/650119 (Mac Catalyst, Apple staff)
- https://developer.apple.com/forums/thread/715455 (Tapback and live layout touches)
- https://developer.apple.com/forums/thread/731364 (Mac Catalyst build error)
- https://developer.apple.com/forums/thread/740873 (iOS 17 simulator send)
- https://developer.apple.com/forums/thread/742268 (live layout "Loading...", iOS 17 to 27)
- https://developer.apple.com/forums/thread/748073 (template will not install, Xcode 15.3 to 16)
- https://developer.apple.com/forums/thread/758827 (simulator workaround)
- https://developer.apple.com/forums/thread/796926 (recipient-side testing)
- https://developer.apple.com/forums/thread/797781 (missing icon, FrontBoard error)
- https://developer.apple.com/forums/thread/805658 (WKWebView in an extension, iOS 26)
- https://developer.apple.com/forums/thread/816190 (iPad `didSelect`, iOS 18 and 26)
- Search snippets only, pages not opened: Stack Overflow questions 44150764, 43282363, 53383948; support.apple.com/104969; 9to5mac.com/2026/09/17/heres-everything-new-for-messages-in-ios-27/; igeeksblog.com iOS 26 iMessage app guide
