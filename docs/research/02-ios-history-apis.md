# 02 — Can an iPhone alone get iMessage history or metadata?

Researched 2026-11-11. Covers iOS 18, iOS 26, iOS 27 (27.2 current).

## Verdict

- **Yes, since iOS 26 — through Shortcuts, not through an API.** iOS 26 added the Messages actions **Find Messages** and **Find Conversations**; a shortcut can read message rows and hand them to any app or web page. Two App Store apps already ship on this (Unbubble, TextPort).
- No framework, App Intent, SiriKit intent, iMessage-extension API or Apple Intelligence hook exposes the system Messages store. On **iOS 18 there is no route** except screen-recording + OCR.
- Group fidelity is the open risk: per-message sender in groups, tapbacks and speed on large chats are **UNVERIFIED** and need one real-device test.
- On-device "chat awards" with the Foundation Models framework are feasible (iOS 26+, Apple Intelligence devices).
- Against our starting hypotheses: "no Shortcuts action exposes history" is **wrong** from iOS 26. The API, SiriKit, App Intents, Apple Intelligence, trigger and Foundation Models hypotheses hold.

Research limits: only developer.apple.com was fetchable here; support.apple.com, 9to5Mac, MacRumors, App Store and GitHub pages were read through search extracts only (marked †). The search budget ran out before the Find Messages property list could be confirmed.

## Answers

**1. Shortcuts**

- *Find Messages / Find Conversations (iOS 26+).* Listed in Apple's iOS 26 Shortcuts notes† ([Apple 125148](https://support.apple.com/125148), [9to5Mac](https://9to5mac.com/2025/12/09/ios-26s-shortcuts-app-adds-25-new-actions-heres-everything-new/), [Cassinelli](https://matthewcassinelli.com/ios-26-public-beta-shortcuts-actions-apple-intelligence-messages-notes-checklists/)). Unbubble's listing† says "Apple lets Shortcuts read Messages, so Unbubble uses a Shortcut"; its CSV has timestamp, sender and direction per message, but it covers **one-to-one chats only** and "the messages iOS makes available, which may not be every message ever sent" ([App Store](https://apps.apple.com/us/app/unbubble-imessage-exporter/id6829522001)). TextPort† requires **iOS 26.4+**, says to keep Shortcuts open and the phone unlocked, quotes about 20 minutes per year of one chat, and claims group chats work (its own pages conflict) ([TextPort](https://textport.com/articles/how-to-export-text-messages-from-iphone)).
- *iOS 27* adds Send Tapback, Mark as Read, Delete Messages, Delete Conversations, Open Inbox and Search in Messages; **Send Message now supports group chats** and **Find Message can filter by sender**† ([Apple 149045](https://support.apple.com/en-us/149045), [9to5Mac](https://9to5mac.com/2026/09/29/ios-27s-shortcuts-app-adds-35-new-improved-actions-heres-whats-new/), [MacStories](https://www.macstories.net/stories/ios-and-ipados-27-review/12/)). Automations gained screenshot, keyboard and **notification** triggers, plus Storage and an upgraded Use Model action ([WWDC26 310](https://developer.apple.com/videos/play/wwdc2026/310/)). Whether the notification trigger accepts Messages as the app is **UNVERIFIED**.
- *"When I get a message" trigger.* Options are Sender and Message Contains† ([Apple guide](https://support.apple.com/guide/shortcuts/apdd711f9dff/ios)). It can run without confirmation since iOS 17† ([Cassinelli](https://matthewcassinelli.com/automations-run-immediately-shortcuts-notifications/)); a banner always shows. At least one field must be filled; a single space in Message Contains is a near catch-all; it fires for iMessage and SMS with the screen off; Send Message with Recipients set to Shortcut Input replies to the sender unprompted† ([tinyapps](https://tinyapps.org/blog/ios-autoreply-text.html)). SMS-forwarding guides read the message content and a sender property from Shortcut Input†. It receives only the triggering message, never history.
- *Group chats.* **UNVERIFIED**. A widget developer reports "no easy way to detect group messages"† ([Widget for Messages](https://apps.apple.com/us/app/-/id6748969237)); community advice for replying to a group is to list every recipient by hand. No source shows the input exposing the conversation, and it presumably does not fire on your own sent messages.
- *A `/wrapped` bot?* Plausible as a hard-wired demo on the owner's phone: Message Contains `/wrapped` → Run Immediately → Send Message to one fixed group (iOS 27) with precomputed text or image. It cannot generalise across chats and depends on the unverified points above. Test: another member types `/wrapped` in a group while the phone is locked; inspect Shortcut Input and whether the reply lands in the group.

**2. App Intents / SiriKit.** Own-content only. `INSearchForMessagesIntent` is handled by *your* Intents extension, for messages sent "with your service" ([docs](https://developer.apple.com/documentation/intents/insearchformessagesintent), [SiriKit Messaging](https://developer.apple.com/documentation/sirikit/messaging)). The App Intents messages domain (`.messages.message`, `.messages.sendMessage`, `draftMessage`; iOS 27 sample) describes your app's entities ([WWDC26 240](https://developer.apple.com/videos/play/wwdc2026/240/)); Apple's sample states "App data is private to the app" ([docs](https://developer.apple.com/documentation/appintents/integrating-your-messaging-app-with-apple-intelligence)). `MSConversation` in an iMessage extension exposes only participant UUIDs and the one selected message ([docs](https://developer.apple.com/documentation/messages/msconversation)).

**3. Apple Intelligence.** No API exposes Messages content, summaries or Smart Reply data to other apps. For awards from our own stats: `SystemLanguageModel.default`, check `.availability` (`deviceNotEligible`, `appleIntelligenceNotEnabled`, `modelNotReady`), `LanguageModelSession` with `Instructions`, `@Generable` + `@Guide`, `session.respond(to:generating:)` ([framework](https://developer.apple.com/documentation/foundationmodels), [SystemLanguageModel](https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel), [guided generation](https://developer.apple.com/documentation/foundationmodels/generating-swift-data-structures-with-guided-generation)). iOS 26.0+, Apple Intelligence devices and regions only; on-device context is **4096 tokens**, so pass aggregates, not transcripts ([context window](https://developer.apple.com/documentation/foundationmodels/managing-the-context-window)). iOS 27 adds `PrivateCloudComputeLanguageModel`, which needs a managed entitlement ([docs](https://developer.apple.com/documentation/foundationmodels/privatecloudcomputelanguagemodel)).

**4. New in iOS 26 / 27; export.** The Messages framework page shows nothing new for polls, backgrounds or history ([docs](https://developer.apple.com/documentation/messages)). iOS 27 Messages changes are user features (suggested actions, Drawing)†. There is still no "Export chat". iOS 26.3 "Transfer to Android" includes messages but only into an Android phone† ([AppleInsider](https://appleinsider.com/articles/26/02/11/ios-263-arrives-with-a-simpler-way-to-transfer-from-iphone-to-android)). Whether a privacy.apple.com export contains message content is **UNVERIFIED** (check the category list there). DMA data-portability APIs cover account and App Store data ([Apple DMA page](https://developer.apple.com/support/dma-and-apps-in-the-eu/)).

**5. Other surfaces.** All dead ends for history:

- DeviceActivity: app and web time only ([docs](https://developer.apple.com/documentation/deviceactivity)). CoreSpotlight: your app's own index ([docs](https://developer.apple.com/documentation/corespotlight/cssearchquery)). Notification service extensions: your own pushes. Contacts: names only.
- SMS filter extensions see SMS/MMS from unknown senders, never iMessage, and cannot export ([docs](https://developer.apple.com/documentation/identitylookup/sms-and-mms-message-filtering)).
- Share sheet and copy: Messages forwards selected bubbles as new text; no whole-conversation share (sender and time loss **UNVERIFIED**). Files app: nothing.
- iCloud: no Messages app on icloud.com and no API†. Backups cannot be read on-device. No third-party accessibility or MDM access to message content.
- EU: alternative distribution keeps notarization and forbids apps that "read outside of the container" ([Apple](https://developer.apple.com/support/dma-and-apps-in-the-eu/)). EU-only Accessory Notifications forwards new notifications to a paired accessory's companion app (iOS 26.5+ per docs), not history ([docs](https://developer.apple.com/documentation/accessorynotifications)).

**6. Hacks.** Screen-record + OCR is real: TextPort uses it below iOS 26.4, with a review reporting wrong senders on long chats†. Usable for short chats, not a year of group history. Jailbreak: Dopamine 3.0 covers only iOS 26.0–26.0.1†; not a product route ([MacRumors](https://www.macrumors.com/2026/08/07/ios-26-dopamine-jailbreak/)). Developer mode unlocks nothing.

**7. Bottom line.** iOS 26.4+/27: yes, no computer needed, with the fidelity caveats above. iOS 18: no. Least-painful no-Mac fallback: a Windows PC over USB — Unbubble for Windows (open source; pulls only Messages and Contacts through the backup service)† ([GitHub](https://github.com/justlayme/unbubble)), or an Apple Devices/iTunes local backup parsed for `sms.db`.

## Routes

| Route | Exposes | Verdict |
|---|---|---|
| Shortcuts Find Messages (iOS 26+) | Message rows: text, time, sender, direction | **Viable**; groups and tapbacks unverified |
| Message automation trigger | One incoming message: text, sender | Bot demo only |
| iOS 27 notification trigger | Notification title and body | Unverified for Messages |
| SiriKit / App Intents schemas | Your own app's messages | No |
| iMessage extension | Participant UUIDs, selected message | No (good for the share card) |
| Apple Intelligence | Nothing to third parties | No (use for awards) |
| Share, copy, Files, iCloud web, privacy export | Fragments or nothing | No |
| Screen recording + OCR | What is on screen | Fallback for iOS 18, lossy |
| EU sideloading, MDM, accessibility | Nothing extra | No |
| Jailbreak | Full `sms.db` | Not for strangers |
| Windows USB extraction | Full `sms.db` | Best non-Mac fallback |

## Scores (Shortcut export → our app or web page)

- In-Messages: **2** — extraction runs in Shortcuts; only the result returns to the thread.
- iPhone-only: **4** — needs iOS 26.4+; nothing on iOS 18.
- Works for everyone: **3** — one member exports; others open a card or link.
- Low setup: **3** — add Shortcut, tap Always Allow, wait unlocked for minutes.
- Usable by strangers today: **4** — an iCloud Shortcut link needs no review.
- Privacy: **4** — on device unless we upload; other members' messages are involved.
- Wow factor: **3** — the export step is slow and plain; the recap can shine.
- Feasibility: **3** — proven for 1:1; group details untested.
- Cost: **5** — free apart from a developer account.
- Time to demo: **4** — a shortcut plus a web renderer is days, given a test phone.
- App Store/ToS risk: **3** — public action with live precedents, but Apple can change it, and [guidelines](https://developer.apple.com/app-store/review/guidelines/) 5.1.1(viii) and 5.1.2(i) bite once third-party messages leave the device.

## Implications for the build

1. Run a one-hour spike on an iOS 26.4+/27 phone first: Find Messages on a group chat; record the properties returned (sender per message, tapbacks, attachments), the count against reality, and the time per 10k messages.
2. If sender is present, the iPhone-only product is: iCloud Shortcut link → Find Messages for a chosen chat and year → hand rows to our app (App Intent) or a local web page → animated recap → share card back into the thread.
3. Treat "most-reacted message" as optional until tapbacks are confirmed; keep the Mac/Windows `sms.db` path as the full-fidelity mode.
4. Awards: Foundation Models with `@Generable` on aggregates, template fallback when unavailable; any server AI needs explicit consent.
5. The `/wrapped` bot is a demo flourish for one phone and one chat, not the product.

## Sources

Read directly: developer.apple.com pages linked above (Intents, SiriKit, Messages, App Intents, Foundation Models, Accessory Notifications, IdentityLookup, CoreSpotlight, DeviceActivity, DMA support, Review Guidelines, WWDC26 sessions 240 and 310).

Via search extracts (†): Apple Support [125148](https://support.apple.com/125148), [149045](https://support.apple.com/en-us/149045), [Shortcuts communication triggers](https://support.apple.com/guide/shortcuts/apdd711f9dff/ios); 9to5Mac [iOS 26](https://9to5mac.com/2025/12/09/ios-26s-shortcuts-app-adds-25-new-actions-heres-everything-new/) and [iOS 27](https://9to5mac.com/2026/09/29/ios-27s-shortcuts-app-adds-35-new-improved-actions-heres-whats-new/) Shortcuts lists; [MacStories iOS 27 review](https://www.macstories.net/stories/ios-and-ipados-27-review/12/); [APPDOOK](https://appdook.com/news/ios-27-shortcuts-new-actions); Matthew Cassinelli ([actions](https://matthewcassinelli.com/ios-26-public-beta-shortcuts-actions-apple-intelligence-messages-notes-checklists/), [run immediately](https://matthewcassinelli.com/automations-run-immediately-shortcuts-notifications/)); [tinyapps](https://tinyapps.org/blog/ios-autoreply-text.html); [Unbubble App Store](https://apps.apple.com/us/app/unbubble-imessage-exporter/id6829522001) and [GitHub](https://github.com/justlayme/unbubble); [TextPort](https://textport.com/articles/how-to-export-text-messages-from-iphone); [Widget for Messages](https://apps.apple.com/us/app/-/id6748969237); [AppleInsider](https://appleinsider.com/articles/26/02/11/ios-263-arrives-with-a-simpler-way-to-transfer-from-iphone-to-android); [MacRumors jailbreak](https://www.macrumors.com/2026/08/07/ios-26-dopamine-jailbreak/); [iCloud web apps](https://support.apple.com/guide/icloud/mm281e3e7d).
