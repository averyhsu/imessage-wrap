# iMessage app extensions (Messages framework)

Researched 2026-11-11; iOS 27 is released and its SDK docs were checked.

**Verdict.** An iMessage app extension is the only sanctioned way to put custom UI inside a Messages thread, but it is blind: it cannot read history, counts, names, the chat name or tapbacks, and that is unchanged from iOS 10 through iOS 27. Alone it cannot compute a recap. It works as a *viewer and share surface* for a recap computed elsewhere: up to 5,000 characters of state travel in `MSMessage.url`, shown as a static card to everyone and as native animated UI to members who installed the app. Every viewer needs an App Store or TestFlight install, and the in-bubble "live layout" has open bugs on iOS 17 to 27.

Only developer.apple.com and GitHub were reachable from this workspace. Facts from Stack Overflow, support.apple.com and news sites are marked "search snippet".

## Answers

**1. What can it read?** Three properties on [`MSConversation`](https://developer.apple.com/documentation/messages/msconversation): `localParticipantIdentifier`, `remoteParticipantIdentifiers`, `selectedMessage`. No history, counts, handles, chat name, chat ID or tapbacks.
- The UUIDs are "scoped to this device", change on reinstall ([docs](https://developer.apple.com/documentation/messages/msconversation/localparticipantidentifier)), and differ on every device for the same person ([docs](https://developer.apple.com/documentation/messages/msmessage/senderparticipantidentifier)).
- Apple: "we don't expose contact information at all to iMessage apps" and "only the tapped message is available to your iMessage app" ([WWDC16 224](https://raw.githubusercontent.com/ASCIIwwdc/wwdc-session-transcripts/master/en/2016/224.vtt)).
- `didReceive` fires only while the extension is active, for its own messages: "You cannot interact with messages from other extensions" ([docs](https://developer.apple.com/documentation/messages/msmessagesappviewcontroller/didreceive%28_:conversation:%29)).
- Writing `$<uuid>` in template text makes Messages draw that contact's name; the extension never sees it (WWDC16 224). **UNVERIFIED** on iOS 26/27; test with a caption containing `$` + `localParticipantIdentifier.uuidString`.
- Changes: none to the read surface; every member of `MSConversation`, `MSMessage` and `MSMessagesAppViewController` dates from iOS 10 to 12. iOS 17 added drag-to-resize ([framework page](https://developer.apple.com/documentation/messages)). iOS 26 added only bubble styling (`messageTintColor`, `messageCornerRadius`; [docs](https://developer.apple.com/documentation/messages/msmessagesapptranscriptpresentation)). iOS 27 added only [`MSUPIRequest`](https://developer.apple.com/documentation/messages/msupirequest), an unrelated SMS payment check.

**2. `MSMessage.url` and `MSSession`.** "The URL property must use an HTTP, HTTPS, or data scheme. Custom app schemes are not supported. Additionally, the URL cannot be longer than 5,000 characters." ([docs](https://developer.apple.com/documentation/messages/msmessage/url); error `urlExceedsMaxSize`). A 2016 test found 5,114 worked and 5,115 failed ([forum 52504](https://developer.apple.com/forums/thread/52504)).
- Fragment (`#...`) preservation is not documented. **UNVERIFIED**; send `https://host/v#payload` between two iPhones and a Mac and read `selectedMessage.url`.
- No documented whole-message limit. Template images are recommended at about 300 x 300 pt at 3x and are transcoded (WWDC16 224).
- [`MSSession`](https://developer.apple.com/documentation/messages/mssession) has no properties. A new message with the same session replaces the earlier bubble, which collapses to its `summaryText`.

**3. Template vs live layout.** [`MSMessageTemplateLayout`](https://developer.apple.com/documentation/messages/msmessagetemplatelayout) is an image or media file, six text fields and the app icon. [`MSMessageLiveLayout`](https://developer.apple.com/documentation/messages/msmessagelivelayout) renders your view controller in the bubble only on iOS 11+ with the app installed; everyone else gets the mandatory `alternateLayout`, "including devices that do not support iMessage apps (macOS, iOS 9 and earlier, and SMS devices)" ([docs](https://developer.apple.com/documentation/messages/msmessagelivelayout/alternatelayout)). Per-platform detail is in the table.
- No app: the "Get <App>" line under the bubble opens the App Store ([WWDC16 204](https://raw.githubusercontent.com/ASCIIwwdc/wwdc-session-transcripts/master/en/2016/204.vtt), [forum 66643](https://developer.apple.com/forums/thread/66643)). Tapping the bubble itself is **UNVERIFIED**: the SDK header says an HTTP(S) URL "will be loaded in a web browser" when no app can consume it ([MSMessage.h](https://raw.githubusercontent.com/xybp888/iOS-SDKs/master/iPhoneOS18.0.sdk/System/Library/Frameworks/Messages.framework/Headers/MSMessage.h)); Stack Overflow reports (search snippet) say the App Store opens. Test on an iOS 27 phone that never had the app.
- macOS: yes. "If the message is selected on macOS, the system loads the URL in a web browser." HTTP(S) only.

**4. Live layout constraints.**
- Size: [`contentSizeThatFits(_:)`](https://developer.apple.com/documentation/messages/msmessagesapptranscriptpresentation/contentsizethatfits%28_:%29) must not exceed the offered maximum.
- Input: "Stick to simple button taps and tap gestures"; "there's no keyboard input allowed" ([WWDC17 234](https://raw.githubusercontent.com/ASCIIwwdc/wwdc-session-transcripts/master/en/2017/234.vtt)). Animation is allowed.
- Lifecycle: one controller per bubble, torn down on leaving the conversation, "not an appropriate place to put something like a 3D game engine". [`requestPresentationStyle`](https://developer.apple.com/documentation/messages/msmessagesappviewcontroller/requestpresentationstyle%28_:%29) from a bubble opens a *new* expanded instance.
- Memory: no documented limit. Controllers reportedly never deallocate on scroll ([forum 102828](https://developer.apple.com/forums/thread/102828)).
- Reliability: bubbles stuck on "Loading..." since iOS 17, re-reported in July 2026 for iOS 26 and 27, no fix ([forum 742268](https://developer.apple.com/forums/thread/742268)). Cancelling a Tapback kills touches ([forum 715455](https://developer.apple.com/forums/thread/715455)).
- `WKWebView`: not forbidden, and used in other extension types ([forum 805658](https://developer.apple.com/forums/thread/805658)). Inside Messages it is **UNVERIFIED**; load bundled HTML in compact, expanded and transcript styles on a device and watch for memory kills.

**5. Groups.** Supported: "iMessage apps are going to be used in group conversations" (WWDC16 224). Limits: per-device UUIDs, only a member count, racing session updates. Groups with SMS/RCS members are **UNVERIFIED** (see table).

**6. Sending without the arrow.** [`insert`](https://developer.apple.com/documentation/messages/msconversation/insert%28_:completionhandler:%29-3g248) stages the message; the user taps Send. [`send`](https://developer.apple.com/documentation/messages/msconversation/send%28_:completionhandler:%29-9krz) (iOS 11+) sends at once, but only while the extension is visible and just after a touch, else `sendWhileNotVisible` or `sendWithoutRecentInteraction`. One send per touch (WWDC17 234).

**7. Text triggers and deep links.** None. The extension activates only "when the user selects the extension from the app drawer, and when the user selects a message in the transcript" that it created ([docs](https://developer.apple.com/documentation/messages/msmessagesappviewcontroller/willbecomeactive%28with:%29)). It cannot see typed text. Ordinary links open Safari or the containing app. The extension can open only its parent app, and only if that app has a Home Screen icon ([docs](https://developer.apple.com/documentation/foundation/nsextensioncontext/open%28_:completionhandler:%29)).

**8. Finding it.** Apple: "the list of iMessage apps that appears when you press the plus button" ([docs](https://developer.apple.com/documentation/messages/msmessagesapppresentationcontext/messages)). In iOS 17 third-party apps sit under "More" ([forum 748073](https://developer.apple.com/forums/thread/748073)); iOS 26 redesigned the list, scroll for all apps (search snippet). Installed apps are on by default since iOS 11. Discoverability is poor: several taps, and nothing prompts members to look.

**9. Testing.** Simulator Messages shows "two ends of a simulated conversation" (WWDC16 224): one fake 1:1 chat, no group.
- Automation: Apple documents none. The community route is XCUITest against `com.apple.MobileSMS` (2017 Stack Overflow, search snippet). **UNVERIFIED** on Xcode 26/27.
- Pitfalls: Xcode 15.3 to 16 beta would not install the template extension until the container scheme ran once, and ran stale builds (forum 748073); erasing the simulator and opening Messages once helps ([forum 758827](https://developer.apple.com/forums/thread/758827)). A missing iMessage App Icon gives "unknown to FrontBoard" ([forum 797781](https://developer.apple.com/forums/thread/797781)). Sent messages vanished in iOS 17 simulators ([forum 740873](https://developer.apple.com/forums/thread/740873)). `didSelect` is reported unreliable on iPad ([forum 816190](https://developer.apple.com/forums/thread/816190)). Xcode 26 and 27 release notes mention none of this.

**10. Distribution.** App Store or TestFlight (10,000 external testers, public link, first build needs beta review; [Apple](https://developer.apple.com/testflight/)). Ad hoc and development builds reach registered devices only. Membership is 99 USD a year. Both shapes exist: iMessage-only app with no Home Screen icon, or extension inside an iOS app ([Apple](https://developer.apple.com/imessage/)). [Guidelines](https://developer.apple.com/app-store/review/guidelines/) that bite: 4.4 ("the extensions may not include marketing, advertising, or in-app purchases"), 2.5.18 (no ads), 4.2 (minimum functionality), 4.2.3(i) (must work without another app), 5.1.2 (consent), 5.2.5 (must not resemble Messages).

**11. macOS.** No. Docs list Mac Catalyst availability, but Xcode refuses: "iMessage Applications are not available when building for Mac Catalyst." ([forum 731364](https://developer.apple.com/forums/thread/731364)). Apple staff: "iMessage stickers are not supported by Mac Catalyst." ([forum 650119](https://developer.apple.com/forums/thread/650119)).

## What every participant sees

| Platform | App installed | App not installed |
|---|---|---|
| iPhone, iPad (iMessage) | Live view in the bubble, or the template card. Tap opens the extension. | Template card plus "Get <App>" link. Bubble tap **UNVERIFIED** (browser or App Store). |
| Mac | Cannot install. | Template card; click opens an HTTP(S) `url` in the browser; `data:` does nothing. |
| Apple Watch | No extensions. | Card delivered since watchOS 3 (WWDC16 224). Today **UNVERIFIED**. |
| Vision Pro | No visionOS support listed. | Presumably the card. **UNVERIFIED**. |
| SMS/RCS/Android member | n/a | Documented fallback: the image, then the HTTP(S) URL as a second message; `data:` URLs are dropped (WWDC16 224). Probably applies to every member of a mixed group. **UNVERIFIED** on iOS 27. |

## Scores (this path alone)

| Criterion | Score | Reason |
|---|---|---|
| In-Messages | 5 | Bubble and UI live in the thread. |
| iPhone-only | 5 | Runs entirely on iPhone and iPad. |
| Works for everyone | 2 | Full experience only with the app; Mac gets a web page, Android an image and link. |
| Low setup | 2 | Every viewer installs an app, then finds it under "+". |
| Usable by strangers today | 1 | Needs App Review or TestFlight beta review first. |
| Privacy | 4 | Extension sees nothing; an HTTPS query string leaks to the web host on Mac click. |
| Wow factor | 4 | Native animated story in expanded view; the in-bubble view is flaky. |
| Feasibility | 1 | Cannot obtain any chat data. |
| Cost | 4 | 99 USD a year, no servers. |
| Time to demo | 2 | Needs a Mac with Xcode (this workspace is Linux) and real devices for group tests. |
| App Store/ToS risk | 3 | Public API only; risks are 4.2, iPad review and the "Wrapped" name. |

## Implications for the build

- Use the extension as viewer and share surface only. Another path must supply the numbers and the names; the extension cannot identify the chat or its members.
- Pack the recap into 5,000 characters or fewer, send one `MSMessage` with a template share card, and play the animated story in the expanded view on tap.
- Make the template card good on its own: it is what most members see.
- Use an `https` URL to a static web viewer so Mac users get the story. Put the payload in the fragment if it survives; otherwise the host sees the stats and consent is needed.
- Treat live layout as optional polish. Avoid a `WKWebView` per bubble.
- Send with `insert`, or `send` from one explicit button tap.
- Ship app plus extension, not iMessage-only, and make iPad work.
- Keep UI in a framework testable from a host app in CI; treat Messages-hosted runs as manual smoke tests.
- Run the **UNVERIFIED** device tests first: fragments, no-app tap, mixed-group fallback, `WKWebView` memory, `$uuid` names.

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
- Search snippets only, pages not opened: Stack Overflow questions 44150764, 43282363, 53383948; support.apple.com/104969; igeeksblog.com iOS 26 iMessage app guide
