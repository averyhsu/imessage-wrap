# 06 — Distribution, and the in-thread link experience

_Researched 2026-11-11. Apple developer docs, MDN compat data, and GitHub, Homebrew and Cloudflare docs were read directly (the last three from their source repos). `www.apple.com`, `support.apple.com`, Product Hunt and most news sites were unreachable from this sandbox, and the web-search budget ran out before the last checks. Anything resting on a search snippet, or not checked, is marked **UNVERIFIED**._

## Verdict

- **Link + static web story is the only path that is free, live in hours, and reaches every member with no install**, Android and Mac included. Its limits: the preview card cannot be personalised, and the story plays in Safari rather than inside Messages.
- **Every native path costs $99/yr plus review.** App Clips also need a *published* App Store app; free provisioning reaches only the owner's own devices.
- **Cap the whole URL at 5,000 characters** so one payload fits both a link fragment and `MSMessage.url`.
- **Prior art is crowded for "my personal Wrapped on a Mac" and thin for "one tap in the thread for the whole group, no server".**
- **Ship under a name with neither "iMessage" nor "Wrapped".**

## Answers

### 1. Rich link previews in Messages

- **Who generates them.** Apple documents the tags, not the mechanism ([TN3156](https://developer.apple.com/documentation/technotes/tn3156-create-rich-previews-for-messages)). Sender-side generation comes from Mysk's 2020 research ([MacRumors](https://www.macrumors.com/2020/10/26/link-previews-may-lead-to-security-vulnerabilities/), snippet only). chat.db agrees: the preview arrives as a separate `URLBalloonProvider` row 0.8–2.0 s after the text ([imsg #141](https://github.com/openclaw/imsg/issues/141)).
- **Tags** (TN3156): `og:title`, `og:image`, `og:site_name`; `apple-touch-icon` or the favicon as the icon. An `og:video` or `twitter:player:stream` pointing at a direct MP4 **downloads and autoplays in the bubble**. `og:description` is mentioned only for social-post cards. No JavaScript or meta redirects; server redirects are followed.
- **Sizes** (TN3156): image at least 900 px wide; icon square, at least 108 px; page at most 1 MB; sub-resources at most 10 MB in total; avoid text in the image. Apple gives no aspect ratio, so the crop is **UNVERIFIED**: test 1200×630 against square.
- **Other text.** A preview appears only when the URL is first or last in the message, never mid-sentence or beside a second URL ([Twilio](https://support.twilio.com/hc/en-us/articles/360013199334-How-do-SMS-and-MMS-URL-Link-Previews-Work-on-Mobile-Devices), snippet). Send the link as its own message.
- **Fragments.** Never sent over HTTP ([RFC 3986 §3.5](https://www.rfc-editor.org/rfc/rfc3986#section-3.5), not re-fetched), so the preview fetch sees only the path. Survival on send and tap is **UNVERIFIED**: send a 2,000-character fragment between two iPhones and a Mac and compare `location.hash`. Use base64url characters only.
- **Maximum length.** None is documented for a typed link. `MSMessage.url` "cannot be longer than 5,000 characters" ([Apple](https://developer.apple.com/documentation/messages/msmessage/url), confirmed by a [2016 test](https://developer.apple.com/forums/thread/52504)). One iMessage API vendor caps link messages at 2,048 ([Linq](https://docs.linqapp.com/guides/messaging/rich-link-previews/), snippet). Target 2,000, cap 5,000, device-test 2k/5k/10k.
- **How it opens.** In the default browser, not an in-app view ([Apple](https://developer.apple.com/documentation/appclip/supporting-invocations-from-your-website-and-the-messages-app)), so full Safari APIs apply.
- **Sent by AppleScript.** **UNVERIFIED.** BlueBubbles needs an explicit `ddScan` flag on private-API sends ([source](https://github.com/BlueBubblesApp/bluebubbles-server/blob/76d2b2e786c04d7516de089f31be978a68da8083/packages/server/src/server/api/interfaces/messageInterface.ts)), which hints that scripted sends get no automatic preview. Test: `osascript` a bare URL, then look for the balloon row in chat.db and on a recipient's phone.
- **SMS/RCS.** No sender-made preview travels; the URL is plain text, and an iPhone on SMS "must opt to load the rich link" (Apple, same page). Android behaviour is **UNVERIFIED**. The story opens in any browser.

### 2. App Clips

- **Launch from a Messages link:** yes, including Apple's default link ([Apple](https://developer.apple.com/documentation/appclip/configuring-the-launch-experience-of-your-app-clip)), if the recipient has iOS 14+ **and the sender in Contacts**. Messages always shows the one default card, never a per-URL one ([Apple engineer](https://developer.apple.com/forums/thread/834811)).
- **Payload.** The default `appclip.apple.com` link (no server, iOS 16.4+) and associated-domain links both pass URL **query parameters**. Fragment delivery is undocumented: **UNVERIFIED**.
- **Size:** 10 MB (iOS 15), 15 MB (iOS 16), 100 MB on iOS 17+ for digital-only invocations ([Apple](https://developer.apple.com/documentation/appclip/choosing-the-right-functionality-for-your-app-clip)).
- **Requirements:** a full app, and "testing and using default and demo links requires your app and App Clip to pass App Store review and to be available in the App Store". Free accounts cannot enable the capability ([table](https://developer.apple.com/help/account/reference/supported-capabilities-ios)).
- **TestFlight:** yes, but testers launch from the TestFlight app with no card, and an associated domain is required ([Apple](https://developer.apple.com/documentation/appclip/testing-the-launch-experience-of-your-app-clip)).
- **Realistic?** Once an app is on the Store it is the best native no-install route for iPhone members. Not today, and Android and Mac members still need the web story.

### 3. TestFlight, App Store, naming

- **Program:** 99 USD/yr, an Apple Account with two-factor authentication, legal age ([Apple](https://developer.apple.com/support/enrollment/)). TestFlight, App Store Connect and notarization are members-only ([comparison](https://developer.apple.com/support/compare-memberships/)).
- **Testers:** 100 internal; 10,000 external by email or public link, after TestFlight App Review of the first build; builds last 90 days ([overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview), [external](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers)). Apple publishes no beta-review time; App Review overall clears 50% in under 24 h and 90% in under 48 h ([Apple](https://developer.apple.com/distribute/app-review/)).
- **Guidelines that bite** ([text](https://developer.apple.com/app-store/review/guidelines/)):
  - **4.2.3(i)** the app must work without another app; **4.2** covers a thin viewer.
  - **2.1** the reviewer must see it work, so bundle a sample recap.
  - **5.1.1 / 5.1.2** statistics about other people; a privacy policy is mandatory.
  - **5.2.5** nothing "confusingly similar" to Messages. A 2020 app was rejected for "iMessage in the app name or subtitle in an inappropriate manner" ([forum](https://developer.apple.com/forums/thread/129822)).
  - **4.1(c) / 5.2.1** another developer's product name.
- **"iMessage" in the name.** Apple allows its product names only in a referential phrase ("_app name_ for iPhone", "works with") ([Apple](https://developer.apple.com/app-store/marketing/guidelines/)). Its trademark guidelines say an Apple word mark must not be part of the product name (snippet only).
- **"Wrapped".** Trademark databases list WRAPPED registrations owned by Spotify AB since 2019 ([record](https://trademarkdir.com/trademark/wrapped-87927276), **UNVERIFIED** against USPTO). In 2025 Spotify warned the "Unwrapped" project that its name may infringe ([Ars via Slashdot](https://tech.slashdot.org/story/25/09/12/2112234/), snippet). Dozens of small "X Wrapped" projects are untouched; the risk grows with visibility.
- **Safer names:** "Chat Rewind", "Group Chat Recap", "Threadback", "GC Yearbook", with "works with iMessage" in the description only.

### 4. iOS with no paid account

- **Free Apple ID ("Personal Team"):** 10 App IDs, 3 devices, 3 apps per device, all expiring after 7 days, no distribution ([Apple](https://developer.apple.com/support/compare-memberships/)).
- **Capabilities:** **App Groups are available to free accounts**; Associated Domains, Push and App Clips are not ([table](https://developer.apple.com/help/account/reference/supported-capabilities-ios)). A Messages extension needs no listed capability, so it should run on the owner's phone for free: **UNVERIFIED** until built.
- **AltStore / SideStore:** each user re-signs with their own Apple ID under the same limits (**UNVERIFIED**, weak sources).
- **EU marketplaces:** need program membership and Apple notarization ([Apple](https://developer.apple.com/support/dma-and-apps-in-the-eu/)).
- **Viable for strangers?** None of these.

### 5. Web story APIs ([MDN compat data](https://github.com/mdn/browser-compat-data))

- **`CompressionStream` / `DecompressionStream`, including `deflate-raw`:** Safari and iOS 16.4, Chrome 103, Firefox 113. Safari 26.5 fixed a trailing-bytes bug ([notes](https://developer.apple.com/documentation/safari-release-notes/safari-26_5-release-notes)), so append nothing after the stream.
- **Web Share with files:** listed from Safari 14, though WebKit bug reports (snippets) say default-on from iOS 15. It needs a tap and HTTPS ([MDN](https://developer.mozilla.org/docs/Web/API/Navigator/share)). Firefox has no file sharing; fall back to a download.
- **Haptics:** `navigator.vibrate` is unsupported in Safari. `<input type="checkbox" switch>` gives a haptic on toggle since Safari 18 ([notes](https://developer.apple.com/documentation/safari-release-notes/safari-18-release-notes)). [ios-haptics](https://github.com/tijnjh/ios-haptics) now forwards a real tap rather than a scripted click; whether a scripted click still fires is **UNVERIFIED**. Treat haptics as a bonus.
- **Full screen:** the Fullscreen API is "Only available on iPad, not on iPhone"; standalone needs Add to Home Screen. Use `100dvh` (Safari 15.4) with `viewport-fit=cover` and `env(safe-area-inset-*)` (Safari 11).

### 6. GitHub Pages

- **Suitability:** automatic HTTPS; site at most 1 GB; soft limits of 100 GB/month and 10 builds/hour; "not intended for … commercial software as a service" ([limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)). On the Free plan the repo must be public.
- **Logs:** GitHub logs visitor IPs for security ([docs](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)); the owner sees none.
- **Fragments:** never reach the server. They can still leak through any script on the page, browser history and tab sync.
- **Alternatives:** Cloudflare Pages has free unlimited static requests, a `_headers` file for a real CSP, and private-repo deploys ([limits](https://developers.cloudflare.com/pages/platform/limits/)). That GitHub Pages cannot set headers is **UNVERIFIED** here; Vercel and Netlify were not checked. Start on GitHub Pages, and put a custom domain in front before strangers get links, because a server cannot redirect a fragment it never sees.

### 7. Mac distribution

- **Free, workable:** a script fetched with `curl` (what Wrapped 2025 does) or a formula in our own Homebrew tap. Homebrew applies quarantine to cask downloads ([docs](https://github.com/Homebrew/brew/blob/main/docs/Homebrew-Security-and-Supply-Chain.md)); that `curl` and formulae skip it is **UNVERIFIED** here. The user must still grant Terminal Full Disk Access.
- **Free, poor:** an unsigned or ad-hoc `.app` downloaded in a browser. Ad-hoc signatures "cannot pass through Gatekeeper" ([Apple](https://developer.apple.com/documentation/macos-release-notes/macos-big-sur-11_0_1-universal-apps-release-notes)), and since macOS 15 the override is in System Settings > Privacy & Security ([Apple](https://developer.apple.com/news/?id=saqachfa)).
- **Homebrew policy:** 5.0.0 deprecated `--no-quarantine` and unsigned casks; official casks that fail Gatekeeper were to be disabled in September 2026 ([release notes](https://brew.sh/2025/11/12/homebrew-5.0.0)). Official taps also want 75 stars, or 225 for a self-submission ([policy](https://github.com/Homebrew/brew/blob/main/docs/Package-Acceptance-Policy.md)).
- **Paid:** Developer ID signature, hardened runtime and secure timestamp, then `notarytool` and stapling, as DMG, pkg or zip. It "usually takes less than an hour" and is not App Review ([Apple](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)).

### 8. Prior art

See the table. Ours would differ by being group-first; needing no server, account or expiry; arriving in the thread as one tap for every member; and making privacy checkable (static page, no third-party scripts).

## Prior-art table

| Product | Gets data | Shows | In-thread / whole group | Price | Traction |
|---|---|---|---|---|---|
| [Wrapped 2025](https://github.com/kothari-nikunj/wrap2025) / [wrap2026](https://github.com/kothari-nikunj/wrap2026) | `curl` one Python file; Terminal Full Disk Access; chat.db, Contacts, WhatsApp | Personal slide gallery, local HTML | No: "Share slides, not the file" | Free, MIT | 58★; 2026 repo created 2026-11-04 |
| [Messages Wrapped](https://www.producthunt.com/posts/messages-wrapped) (snippet) | Mac app, local; encrypted story uploaded, opened by QR | Personal story on phone | Share link, 48 h | Free | Maker claims 9,000 users in 4 days |
| [Left on Read](https://github.com/Left-on-Read/leftonread) | Electron Mac app, local | "Your Year in Text" | No | Free | 209★ |
| [MiMessage](https://github.com/jonluca/mimessage) | Notarized Electron Mac app | Search, stats, wrapped | No | Free | 167★ |
| [gtarpenning/imessage-wrapped](https://github.com/gtarpenning/imessage-wrapped) | pip CLI or DMG; **uploads aggregate stats** | Hosted dashboard | Link; personal | Free | 2★ |
| [NoelSason/imessage-wrapped](https://github.com/NoelSason/imessage-wrapped) | Python CLI; Mac, or Windows + iPhone backup | **Per-chat** page, AES-encrypted | **Whole group.** Sender self-hosts, shares link + password | Free, MIT | 1★ |
| [textstat](https://github.com/benmross/textstat) | **In browser**: chat.db or iPhone backup folder | Personal story; Web Share per slide | No | Free | 0★ |
| [gc_wrapped](https://github.com/andrewlayer/gc_wrapped), [reaction leaderboard](https://github.com/matteodallolmo/imessage-wrapped) | Scripts on chat.db | Group stats | Manual | Free | under 5★ |
| iOS "chat wrapped" apps ([example](https://apps.apple.com/us/app/-/id6740490199)) | WhatsApp exports, by their titles (**UNVERIFIED**) | Recap cards | No | Unknown | Small |

[imessage-exporter](https://github.com/ReagentX/imessage-exporter) (5,744★) is the parsing reference rather than a competitor.

## Distribution-options table

| Channel | Cost | Approval / spend | Time to live | Who can use it today |
|---|---|---|---|---|
| Web story on GitHub Pages | $0 | Owner yes to enable Pages | Minutes | Anyone with a browser |
| Cloudflare Pages + custom domain | Domain fee | Spend + approval | Under 1 h | Anyone |
| Mac script by `curl` / own Homebrew tap | $0 | Approval to publicise | Hours | Mac users at ease with Terminal |
| Unsigned Mac app on GitHub Releases | $0 | Approval | Hours | Only people who override Gatekeeper |
| Notarized Mac DMG | $99/yr | Spend | Enrolment + under 1 h | Any Mac user |
| iOS free provisioning | $0 | None | Hours | Owner's own devices, 7 days |
| AltStore / SideStore | $0 | None | Not practical | Hobbyists with their own Apple ID |
| TestFlight internal | $99/yr | Spend | Same day | Up to 100 team members |
| TestFlight public link | $99/yr | Spend + beta review | Days (**UNVERIFIED**) | Up to 10,000, each installs TestFlight |
| App Store iMessage app | $99/yr | Spend + App Review + go-public | Days to weeks | iPhone users, each installs |
| App Clip | $99/yr + published app | As above | After App Store approval | iPhone recipients with the sender in Contacts |

## Scores: link + static web story

| Criterion | Score | Reason |
|---|---|---|
| In-Messages | 2 | A card sits in the thread, but the story plays in Safari and the card is generic |
| iPhone-only | 3 | Viewers need only a phone; the creator needs a Mac or a computer-made backup |
| Works for everyone | 5 | Any browser, Android included |
| Low setup | 4 | None for viewers; one command plus Full Disk Access for the creator |
| Usable by strangers today | 4 | Yes once Pages is approved; creators need Terminal |
| Privacy | 4 | Nothing reaches a server, but the link is the data and can be forwarded |
| Wow factor | 3 | Animated story and video card; no native bubble, full screen or reliable haptics |
| Feasibility | 5 | Standard web APIs, all in Safari since 16.4 |
| Cost | 5 | $0 |
| Time to demo | 5 | Hours |
| App Store / ToS risk | 4 | No Apple review; naming and GitHub Pages terms remain |

## Implications for the build

1. **One payload format:** versioned binary, `deflate-raw`, base64url; whole URL at most 5,000 characters, with a 2,000-character lite mode; no message text.
2. **The card is the same for every recap.** Invest in one strong `og:image` and a short looping `og:video` MP4. Personalised teasers must come from a separately sent image or the extension's template layout.
3. **Send the URL alone in its own message.**
4. **Web story:** feature-detect `DecompressionStream` with a small JS inflate fallback; `100dvh` and safe-area insets; share cards as files on tap, with a download fallback; no third-party scripts; a CSP meta tag; `referrer` set to `no-referrer`.
5. **Fix the public URL before sharing.** Sent links are permanent.
6. **Device tests owed:** fragment survival (iMessage, SMS, RCS, Mac); preview against URL length; image crop; video autoplay; AppleScript-sent previews; the haptic trick.
7. **Spend order:** ship web + Mac script free; prove the Messages extension on free provisioning; then ask for $99; App Clip last.
8. **Choose the public name before anything is announced.**

## Where the starting hypotheses were wrong

- **Previews:** the tags are right, but sender-side generation is not Apple-documented, and a fragment payload can never personalise the card.
- **Free provisioning:** 7 days is right, but it *does* include App Groups, so a free on-device extension demo is plausible.
- **Web Share files:** compat data says Safari 14; 15 is the safe floor.
- **Prior art:** the popular tools are Mac scripts and apps, not in-browser parsers (textstat is the exception). One project already serves the whole group, NoelSason/imessage-wrapped, by self-hosting plus a password. None does it with no server and one tap.
- **Reachability:** `support.apple.com` and `www.apple.com` could not be fetched.

## Sources

- **Apple:** [TN3156](https://developer.apple.com/documentation/technotes/tn3156-create-rich-previews-for-messages) · App Clip docs ([Messages](https://developer.apple.com/documentation/appclip/supporting-invocations-from-your-website-and-the-messages-app), [experiences](https://developer.apple.com/documentation/appclip/configuring-the-launch-experience-of-your-app-clip), [limits](https://developer.apple.com/documentation/appclip/choosing-the-right-functionality-for-your-app-clip), [testing](https://developer.apple.com/documentation/appclip/testing-the-launch-experience-of-your-app-clip)) · [MSMessage.url](https://developer.apple.com/documentation/messages/msmessage/url) · [capabilities](https://developer.apple.com/help/account/reference/supported-capabilities-ios) · [memberships](https://developer.apple.com/support/compare-memberships/) · [enrollment](https://developer.apple.com/support/enrollment/) · [TestFlight](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview) · [App Review](https://developer.apple.com/distribute/app-review/) · [guidelines](https://developer.apple.com/app-store/review/guidelines/) · [marketing guidelines](https://developer.apple.com/app-store/marketing/guidelines/) · [EU](https://developer.apple.com/support/dma-and-apps-in-the-eu/) · [notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution) · [Gatekeeper](https://developer.apple.com/news/?id=saqachfa)
- **Web platform:** [MDN browser-compat-data](https://github.com/mdn/browser-compat-data) · Safari [18](https://developer.apple.com/documentation/safari-release-notes/safari-18-release-notes) and [26.5](https://developer.apple.com/documentation/safari-release-notes/safari-26_5-release-notes) notes
- **Hosting and Homebrew** (source repos): [github/docs](https://github.com/github/docs/tree/main/content/pages/getting-started-with-github-pages) · [cloudflare-docs](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/pages/platform/limits.mdx) · [Homebrew 5.0.0](https://github.com/Homebrew/brew.sh/blob/master/_posts/2025-11-12-homebrew-5.0.0.md) · [Acceptable Casks](https://github.com/Homebrew/brew/blob/main/docs/Acceptable-Casks.md)
- **Snippet-only:** Mysk, Twilio, Linq, Product Hunt, trademark databases, Ars Technica.
