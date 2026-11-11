# 06 — Distribution, and the in-thread link experience

_Researched 2026-11-11. Apple developer docs, MDN compat data, GitHub and Homebrew docs were read directly (the last three from their source repos). `www.apple.com`, `support.apple.com`, Product Hunt, WebKit Bugzilla and most news sites were unreachable from this sandbox, and the web-search budget ran out near the end; anything resting on a search snippet or not checked is marked **UNVERIFIED**._

## Verdict

- **Link + static web story is the only path that is free, live in hours, and reaches every member (Android and Mac included) with no install.** Its limits: the preview card cannot be personalised (the fragment is invisible to the preview fetch) and the story plays in Safari, not inside Messages.
- **Every native path costs $99/yr plus review.** App Clips additionally need a *published* App Store app; free provisioning only reaches the owner's own devices.
- **Budget the payload to 5,000 URL characters** so one format fits both a link fragment and `MSMessage.url`.
- **Prior art is crowded for "my personal Wrapped on a Mac"** (Wrapped 2025 relaunched as wrap2026.com this week) **and thin for "one tap in the thread for the whole group, no server".**
- **Do not ship the names "iMessage" or "Wrapped".** Both are other companies' marks.

## Answers

### 1. Rich link previews in Messages

- **Who generates them.** Apple documents the tags, not the mechanism ([TN3156](https://developer.apple.com/documentation/technotes/tn3156-create-rich-previews-for-messages)). Sender-side generation comes from Mysk's 2020 research ([MacRumors summary](https://www.macrumors.com/2020/10/26/link-previews-may-lead-to-security-vulnerabilities/), snippet only). It fits what chat.db shows: the preview is a separate `com.apple.messages.URLBalloonProvider` row 0.8–2.0 s after the text ([imsg #141](https://github.com/openclaw/imsg/issues/141)).
- **Tags that matter** (TN3156): `og:title`, `og:image`, `og:site_name`; `og:video` or `twitter:player:stream` pointing at a direct MP4 **downloads and autoplays in the bubble**; `apple-touch-icon` or favicon is the icon. `og:description` is only used for social-post cards. No JavaScript and no meta redirects; server redirects are followed.
- **Sizes** (TN3156): image at least 900 px wide (under 150 px is treated as an icon); icon square, at least 108 px; page at most 1 MB; all sub-resources at most 10 MB; avoid text in the image. Apple gives no aspect ratio; 1200×630 is web convention. **UNVERIFIED** how Messages crops it: test 1.91:1 against square.
- **Other text in the message.** A preview appears only when the URL is first or last, never mid-sentence or with a second URL ([Twilio](https://support.twilio.com/hc/en-us/articles/360013199334-How-do-SMS-and-MMS-URL-Link-Previews-Work-on-Mobile-Devices), snippet). Send the link as its own message.
- **Fragments.** Never sent over HTTP ([RFC 3986 §3.5](https://www.rfc-editor.org/rfc/rfc3986#section-3.5), not re-fetched), so the preview fetch sees only the path. Survival on send and tap is **UNVERIFIED**: send a 2k-character fragment between two iPhones and a Mac and compare `location.hash`. Use only base64url characters.
- **Maximum length.** No documented limit for a typed link. Documented: `MSMessage.url` "cannot be longer than 5,000 characters" ([Apple](https://developer.apple.com/documentation/messages/msmessage/url)); a 2016 test found 5,114 worked and 5,115 failed ([forum](https://developer.apple.com/forums/thread/52504)). One iMessage API vendor caps link messages at 2,048 ([Linq](https://docs.linqapp.com/guides/messaging/rich-link-previews/), snippet). Target 2,000, hard cap 5,000; device-test 2k/5k/10k.
- **How it opens.** In the default browser, not an in-app view ([Apple](https://developer.apple.com/documentation/appclip/supporting-invocations-from-your-website-and-the-messages-app)), so full Safari APIs apply.
- **Sent from a Mac by AppleScript.** **UNVERIFIED.** BlueBubbles needs an explicit `ddScan` flag on its private-API sends ([source](https://github.com/BlueBubblesApp/bluebubbles-server/blob/76d2b2e786c04d7516de089f31be978a68da8083/packages/server/src/server/api/interfaces/messageInterface.ts)), which suggests previews are not automatic for scripted sends. Test: `osascript` a bare URL, then look for the balloon row in chat.db and on a recipient's phone.
- **SMS/RCS.** No sender-made preview travels; the URL is plain text. iPhones on SMS must "opt to load the rich link" (Apple, same page); Android behaviour is **UNVERIFIED**. The story still opens in any browser.

### 2. App Clips

- **Launch from a Messages link:** yes, including the default link ([Apple](https://developer.apple.com/documentation/appclip/configuring-the-launch-experience-of-your-app-clip)). The recipient needs iOS 14+ **and the sender in their Contacts**.
- **Default versus associated-domain links.** The default `appclip.apple.com` link needs no server and works on iOS 16.4+; an associated domain adds the Safari banner and card. Both accept URL **query parameters** (the demo link does not). Fragment delivery is undocumented: **UNVERIFIED**.
- **One card only.** Messages always shows the default card, never a per-URL one ([Apple engineer](https://developer.apple.com/forums/thread/834811)).
- **Size:** 10 MB (iOS 15), 15 MB (iOS 16), 100 MB on iOS 17+ for digital-only invocations ([Apple](https://developer.apple.com/documentation/appclip/choosing-the-right-functionality-for-your-app-clip)).
- **Requirements:** a full app with the same functionality; "testing and using default and demo links requires your app and App Clip to pass App Store review and to be available in the App Store". The capability is not offered to free accounts ([table](https://developer.apple.com/help/account/reference/supported-capabilities-ios)).
- **TestFlight:** yes, but testers launch from the TestFlight app, no card appears, and an associated domain is required ([Apple](https://developer.apple.com/documentation/appclip/testing-the-launch-experience-of-your-app-clip)).
- **Realistic?** After App Store approval it is the best native no-install route for iPhone members. Not today, and Android and Mac members still need the web story.

### 3. TestFlight, App Store, naming

- **Program:** 99 USD/yr, Apple Account with two-factor authentication, legal age; an individual's legal name is the seller name ([Apple](https://developer.apple.com/support/enrollment/)). TestFlight, App Store Connect and notarization are members-only ([comparison](https://developer.apple.com/support/compare-memberships/)).
- **Testers:** 100 internal; 10,000 external by email or public link (open or filtered, cap settable); the first build of a version needs TestFlight App Review; builds last 90 days ([overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview), [external](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers)). Apple publishes no beta-review time; App Review overall does 50% in under 24 h and 90% in under 48 h ([Apple](https://developer.apple.com/distribute/app-review/)).
- **Guidelines that bite** ([text](https://developer.apple.com/app-store/review/guidelines/)):
  - **4.2.3(i)** "should work on its own without requiring installation of another app", and **4.2** for a thin viewer.
  - **2.1** the reviewer must see it work, so bundle a sample recap.
  - **5.1.1 / 5.1.2** statistics about other people; a privacy policy is mandatory.
  - **5.2.5** nothing "confusingly similar" to Messages. Precedent: a rejection for "iMessage in the app name or subtitle in an inappropriate manner" ([forum](https://developer.apple.com/forums/thread/129822)).
  - **4.1(c) / 5.2.1** another developer's product name.
- **"iMessage" in the name.** Apple's marketing rules allow product names only referentially ("_app name_ for iPhone", "works with"), never "_iPhone app name_" ([Apple](https://developer.apple.com/app-store/marketing/guidelines/)). The trademark guidelines say an Apple word mark must not be part of the product name (snippet only; page unreachable).
- **"Wrapped".** Trademark databases list WRAPPED registrations owned by Spotify AB, filed 2018 and registered 2019 ([record](https://trademarkdir.com/trademark/wrapped-87927276), **UNVERIFIED** against USPTO). In September 2025 Spotify told the "Unwrapped" project its name may infringe ([Ars via Slashdot](https://tech.slashdot.org/story/25/09/12/2112234/)). Dozens of small "X Wrapped" projects are untouched, so the risk grows with visibility.
- **Safer names:** "Chat Rewind", "Group Chat Recap", "Threadback", "GC Yearbook", with "works with iMessage" only in the description.

### 4. iOS with no paid account

- **Free Apple ID ("Personal Team"):** 10 App IDs, 3 devices, 3 apps per device, everything expires in 7 days, no distribution ([Apple](https://developer.apple.com/support/compare-memberships/)).
- **Capabilities:** **App Groups are available to free accounts**; Associated Domains, Push and App Clips are not ([table](https://developer.apple.com/help/account/reference/supported-capabilities-ios)). A Messages extension needs no capability, so it should run on the owner's phone for free. **UNVERIFIED** until built.
- **AltStore/SideStore:** re-sign with each user's own Apple ID under the same limits, with computer setup (**UNVERIFIED**, weak sources).
- **EU marketplaces:** require program membership, Apple notarization and financial eligibility ([Apple](https://developer.apple.com/support/dma-and-apps-in-the-eu/)).
- **Viable for strangers?** No, none of them.

### 5. Web story APIs ([MDN compat data](https://github.com/mdn/browser-compat-data))

- **`CompressionStream` / `DecompressionStream`, including `deflate-raw`:** Safari and iOS 16.4, Chrome 103, Firefox 113. Brotli only arrived in Safari 18.4, so avoid it. Safari 26.5 fixed a trailing-bytes bug ([notes](https://developer.apple.com/documentation/safari-release-notes/safari-26_5-release-notes)); append nothing after the stream.
- **Web Share with files:** `navigator.share` since Safari 12.1; `canShare` and files are listed from 14, though WebKit bug reports say default-on from iOS 15. It needs a tap (transient activation) and HTTPS ([MDN](https://developer.mozilla.org/docs/Web/API/Navigator/share)). Firefox lacks files; fall back to download.
- **Haptics:** `navigator.vibrate` is unsupported in Safari. `<input type="checkbox" switch>` gives a haptic on toggle since Safari 18 ([notes](https://developer.apple.com/documentation/safari-release-notes/safari-18-release-notes)). [ios-haptics](https://github.com/tijnjh/ios-haptics) now forwards a real tap instead of a scripted click; whether a scripted click still fires on current iOS is **UNVERIFIED**. Treat haptics as a bonus.
- **Full screen:** the Fullscreen API is "only available on iPad, not on iPhone"; standalone needs Add to Home Screen. Use `100dvh` (Safari 15.4) with `viewport-fit=cover` and `env(safe-area-inset-*)` (Safari 11).

### 6. GitHub Pages

- **Suitability:** HTTPS is automatic on `github.io`. Published site at most 1 GB; soft limits of 100 GB/month and 10 builds/hour; 429s are possible; "not intended for … commercial software as a service" ([limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)).
- **Private repos:** Pages on the Free plan needs a public repo.
- **Logs:** GitHub logs visitor IPs for security ([docs](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)); the owner gets none.
- **Fragments:** never reach the server (RFC 3986). They can still leak through any script on the page, browser history and tab sync.
- **Alternatives:** Cloudflare Pages has free unlimited static requests, a `_headers` file for a real CSP, and private-repo deploys ([limits](https://developers.cloudflare.com/pages/platform/limits/)). GitHub Pages cannot set headers (**UNVERIFIED** here). Vercel and Netlify were not checked. Start on GitHub Pages; put a custom domain in front before strangers get links, because fragment links cannot be redirected server-side.

### 7. Mac distribution

- **Free, good:** a script fetched with `curl` (what Wrapped 2025 does), or a formula in our own Homebrew tap. Homebrew quarantines cask downloads only ([docs](https://github.com/Homebrew/brew/blob/main/docs/Homebrew-Security-and-Supply-Chain.md)). The user must still grant Terminal Full Disk Access.
- **Free, bad:** an unsigned or ad-hoc `.app` downloaded in a browser is quarantined, and since macOS 15 the user must approve it in System Settings > Privacy & Security ([Apple](https://developer.apple.com/news/?id=saqachfa)). Ad-hoc signatures "cannot pass through Gatekeeper" ([Apple](https://developer.apple.com/documentation/macos-release-notes/macos-big-sur-11_0_1-universal-apps-release-notes)).
- **Homebrew policy:** 5.0.0 deprecated `--no-quarantine` and unsigned casks, and official casks failing Gatekeeper were to be disabled in September 2026 ([release notes](https://brew.sh/2025/11/12/homebrew-5.0.0)). Official taps also need notability, about 75 stars ([policy](https://github.com/Homebrew/brew/blob/main/docs/Package-Acceptance-Policy.md)).
- **Paid:** Developer ID signature, hardened runtime and secure timestamp, then `notarytool` and stapling; DMG, pkg or zip; "usually takes less than an hour", no App Review ([Apple](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)).

### 8. Prior art

See the table. Ours would differ by being group-first, needing no server, account or expiry, arriving in the thread as one tap for every member, working for members with no Mac, and making privacy checkable (static page, no third-party scripts).

## Prior-art table

| Product | Gets data | Shows | In-thread / whole group | Price | Traction |
|---|---|---|---|---|---|
| [Wrapped 2025](https://github.com/kothari-nikunj/wrap2025) / [wrap2026](https://github.com/kothari-nikunj/wrap2026) | `curl` one Python file; Terminal Full Disk Access; chat.db, Contacts, WhatsApp | Personal slide gallery in a local HTML file | No. "Share slides, not the file" | Free, MIT | 58★; 2026 repo pushed 2026-11-10 |
| [Messages Wrapped](https://www.producthunt.com/posts/messages-wrapped) | Mac app, local; encrypted story uploaded, opened by QR | Personal story on phone | Share link, expires in 48 h | Free | Maker claims 9,000 users in 4 days (snippet) |
| [Left on Read](https://github.com/Left-on-Read/leftonread) | Electron Mac app, local | "Your Year in Text" | No | Free, ELv2 | 209★ |
| [Mimessage](https://github.com/jonluca/mimessage) | Electron Mac app | Search, wrapped, AI chat | No | Free | 167★ |
| [gtarpenning/imessage-wrapped](https://github.com/gtarpenning/imessage-wrapped) | pip CLI or DMG; **uploads aggregate stats** | Hosted dashboard URL | Link; personal | Free | 2★ |
| [NoelSason/imessage-wrapped](https://github.com/NoelSason/imessage-wrapped) | Python CLI; Mac, or Windows + iPhone backup | **Per-chat** scrolling page, AES-encrypted | **Group, yes.** Sender self-hosts and shares link + password | Free, MIT | 1★ (Aug 2026) |
| [textstat](https://github.com/benmross/textstat) | **In browser**: chat.db or iPhone backup folder | Personal cinematic story; Web Share per slide | No | Free | 0★ |
| [gc_wrapped](https://github.com/andrewlayer/gc_wrapped), [reaction leaderboard](https://github.com/matteodallolmo/imessage-wrapped) | Scripts on chat.db | Group stats | Manual | Free | under 5★ |
| iOS "Chat Wrapped" apps ([example](https://apps.apple.com/app/id6740463139)) | WhatsApp export files, not iMessage | Recap cards | No | Freemium | Small |

[imessage-exporter](https://github.com/ReagentX/imessage-exporter) (5,744★) is the parsing reference rather than a competitor.

## Distribution-options table

| Channel | Cost | Approval / spend | Time to live | Who can use it today |
|---|---|---|---|---|
| Web story on GitHub Pages | $0 | Owner yes to enable Pages | Minutes | Anyone with a browser |
| Cloudflare Pages + custom domain | About $12/yr (**UNVERIFIED**) | Spend + approval | Under 1 h | Anyone |
| Mac script by `curl` / own Homebrew tap | $0 | Approval to publicise | Hours | Mac users at ease with Terminal |
| Unsigned Mac app on GitHub Releases | $0 | Approval | Hours | Only people who will override Gatekeeper |
| Notarized Mac DMG | $99/yr | Spend | Enrolment + under 1 h | Any Mac user |
| iOS free provisioning | $0 | None | Hours | Owner's own devices, 7 days |
| AltStore / SideStore | $0 | None | — | Hobbyists, each with their own Apple ID |
| TestFlight internal | $99/yr | Spend | Same day | Up to 100 team members |
| TestFlight public link | $99/yr | Spend + beta review | About 1–3 days | Up to 10,000, each installs TestFlight |
| App Store iMessage app | $99/yr | Spend + App Review + go-public | Days to weeks | iPhone users, each installs |
| App Clip | $99/yr + published app | As above | After App Store approval | iPhone recipients with the sender in Contacts |

## Scores: link + static web story

| Criterion | Score | Reason |
|---|---|---|
| In-Messages | 2 | A card sits in the thread, but the story plays in Safari and the card is generic |
| iPhone-only | 3 | Viewers need only a phone; the creator needs a Mac or a computer-made backup |
| Works for everyone | 5 | Any browser, including Android |
| Low setup | 4 | Zero for viewers; one command plus Full Disk Access for the creator |
| Usable by strangers today | 4 | Yes once Pages is approved; creators need Terminal |
| Privacy | 4 | Nothing reaches a server, but the link is the data and can be forwarded |
| Wow factor | 3 | Animated story and video card; no native bubble, full screen or reliable haptics |
| Feasibility | 5 | Standard web APIs, all shipped by Safari 16.4 |
| Cost | 5 | $0 |
| Time to demo | 5 | Hours |
| App Store / ToS risk | 4 | No Apple review; residual naming and GitHub Pages terms risk |

## Implications for the build

1. **One payload format:** versioned binary, `deflate-raw`, base64url, whole URL at most 5,000 characters with a 2,000 "lite" mode, and no message text.
2. **The card is the same for every recap.** Spend effort on one strong `og:image` and a short looping `og:video` MP4. Personalised teasers must come from a separately sent image or the extension's template layout.
3. **Send the URL alone in its own message.**
4. **Web story:** feature-detect `DecompressionStream` with a small JS inflate fallback; `100dvh` and safe-area insets; share cards as files on tap with a download fallback; no third-party scripts, a CSP meta tag, and `referrer` set to `no-referrer`.
5. **Fix the public URL before sharing.** Sent links are permanent.
6. **Device tests owed:** fragment survival (iMessage, SMS, RCS, Mac), preview against URL length, image crop, video autoplay, AppleScript-sent previews, the haptic trick.
7. **Spend order:** ship web + Mac script free; prove the Messages extension on free provisioning; only then ask for $99; App Clip last.
8. **Pick a public name with neither "iMessage" nor "Wrapped" before anything is announced.**

## Where the starting hypotheses were wrong

- **Previews:** right about tags, but sender-side generation is not Apple-documented, and the missed consequence is that a fragment payload can never personalise the card.
- **Free provisioning:** right about 7 days, but it *does* include App Groups, so a free on-device extension demo is plausible.
- **Web Share files:** compat data says Safari 14; 15 is the safe floor. Immaterial in 2026.
- **Prior art:** the popular tools are Mac scripts and apps, not in-browser parsers (textstat is the exception). "None serve the whole group" is no longer true: NoelSason/imessage-wrapped does, with self-hosting and a password. None does it with no server and one tap.
- **Reachability:** `support.apple.com` and `www.apple.com` were not reachable, so Apple's trademark guidelines are quoted from snippets only.

## Sources

Apple: [TN3156](https://developer.apple.com/documentation/technotes/tn3156-create-rich-previews-for-messages) · [App Clip Messages invocations](https://developer.apple.com/documentation/appclip/supporting-invocations-from-your-website-and-the-messages-app) · [App Clip experiences](https://developer.apple.com/documentation/appclip/configuring-the-launch-experience-of-your-app-clip) · [App Clip limits](https://developer.apple.com/documentation/appclip/choosing-the-right-functionality-for-your-app-clip) · [App Clip testing](https://developer.apple.com/documentation/appclip/testing-the-launch-experience-of-your-app-clip) · [MSMessage.url](https://developer.apple.com/documentation/messages/msmessage/url) · [capabilities](https://developer.apple.com/help/account/reference/supported-capabilities-ios) · [memberships](https://developer.apple.com/support/compare-memberships/) · [enrollment](https://developer.apple.com/support/enrollment/) · [TestFlight](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview) · [App Review](https://developer.apple.com/distribute/app-review/) · [guidelines](https://developer.apple.com/app-store/review/guidelines/) · [marketing guidelines](https://developer.apple.com/app-store/marketing/guidelines/) · [EU distribution](https://developer.apple.com/support/dma-and-apps-in-the-eu/) · [notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution) · [Sequoia Gatekeeper](https://developer.apple.com/news/?id=saqachfa) · forum threads [52504](https://developer.apple.com/forums/thread/52504), [834811](https://developer.apple.com/forums/thread/834811), [129822](https://developer.apple.com/forums/thread/129822)

Web platform: [MDN browser-compat-data](https://github.com/mdn/browser-compat-data) (`api/CompressionStream`, `api/Navigator`, `api/Element`, `css/types/length`, `css/types/env`, `html/elements/input`) · Safari [18](https://developer.apple.com/documentation/safari-release-notes/safari-18-release-notes) and [26.5](https://developer.apple.com/documentation/safari-release-notes/safari-26_5-release-notes) release notes

Hosting and Homebrew: [github/docs](https://github.com/github/docs/tree/main/content/pages/getting-started-with-github-pages) · [cloudflare-docs](https://github.com/cloudflare/cloudflare-docs/blob/production/src/content/docs/pages/platform/limits.mdx) · [Homebrew 5.0.0](https://github.com/Homebrew/brew.sh/blob/master/_posts/2025-11-12-homebrew-5.0.0.md) · [Acceptable Casks](https://github.com/Homebrew/brew/blob/main/docs/Acceptable-Casks.md)

Snippet-only (not fetched): Mysk link-preview research, Twilio, Linq, Product Hunt, trademark databases, Ars Technica on Unwrapped.
