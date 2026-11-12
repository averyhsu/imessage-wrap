# 08 — Getting the Mac helper onto a stranger's Mac: one-click distribution

_Researched 2026-11-12. Current releases: macOS 15 Sequoia, 26 Tahoe, 27 "Golden Gate" (Apple silicon only, see [03](03-mac-chatdb-applescript.md)). Read directly: `developer.apple.com` documentation (through its JSON API), Apple developer-forum threads, the App Review Guidelines, and the source repositories of Sparkle, Briefcase, PyInstaller, GitHub Docs and GitHub's runner images. `support.apple.com`, news sites and vendor sites were unreachable, so anything resting on a search snippet, on memory, or not checked is marked **UNVERIFIED**. Permissions (Full Disk Access, the Automation prompt) are covered by a separate note; this one covers getting the app onto the Mac and keeping it updated._

## Bottom line

- **A true "few clicks" install needs the $99/yr Apple Developer Program.** A Developer ID-signed, notarized native app in a zip or DMG takes about 4 to 6 clicks to first launch, with one mild dialog. Without it, every browser download hits "Apple could not verify … is free of malware" and a roughly 10-step detour through System Settings.
- **The Mac App Store and TestFlight are out for the bot.** Both require the sandbox. App Review rarely approves the Apple-events exception needed to send messages, and it rejects apps whose setup is a Full Disk Access tutorial.
- **Ship a native Swift menu-bar app, not wrapped Python.** It is about 5 MB instead of about 50, shows its own name and icon in every permission prompt, keeps its permissions across updates when signed with Developer ID, and reuses `ios/Shared` plus `engine.js` through JavaScriptCore.
- **The best free route is one Terminal paste that installs a real app.** `curl` does not quarantine what it downloads (**UNVERIFIED**, test it), so the app needs no Gatekeeper override and then runs its own permission setup.
- **Nothing works with no install at all.** Shortcuts on a Mac might trigger on a message, but every other link in the chain is unverified. On iPhone, a no-install bot works only as a demo for the owner's own phone, or by uploading messages to a server.

## 1. What a non-technical user actually sees

A "click" here is one deliberate action: a click, a drag, or a password/Touch ID entry. Counts run from the landing page's Download button to the app's own first window. The app's permission setup comes on top and is the same for every app route (about 5 to 8 actions; see the permissions note).

### (a) Developer ID-signed, notarized, stapled app (zip or DMG)

- **Apple's description:** Gatekeeper "places descriptive information in the initial launch dialog to help the user make an informed choice" ([Apple, notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)). Stapling lets that check work offline ([Apple, customizing the workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)).
- **What appears:** "“Threadback” is an app downloaded from the Internet. Are you sure you want to open it?", with [Cancel] [Open] and a line saying Apple checked it for malicious software and found none. That wording is from memory and **UNVERIFIED** for 26/27.
- **Zip in Safari:** Safari unzips "safe" downloads by default (**UNVERIFIED** for Safari 26/27). Steps: Download (1), maybe "Allow downloads on this site?" (1, **UNVERIFIED**), click the download (1), Open (1), then the app offers "Move to Applications?" (1). **4–5 clicks.**
- **DMG:** Download (1), open the DMG (1), drag to the Applications alias (1), open Applications and double-click (1–2), Open (1), eject (optional). **5–7 clicks.** Users often run the app straight from the mounted DMG. Then App Translocation runs it from a random path, Sparkle cannot update it, and a login item points at a disk image. Sparkle recommends an `/Applications` symlink in the DMG, and zips containing nothing but the app ([Sparkle docs](https://github.com/sparkle-project/sparkle-project.github.io/blob/master/documentation/index.md)). An app that offers to move itself fixes both cases.
- **Scary moments:** none beyond the one dialog.

### (b) Ad-hoc-signed or unsigned app, downloaded with a browser

- **Apple:** "In macOS Sequoia, users will no longer be able to Control-click to override Gatekeeper when opening software that isn't signed correctly or notarized. They'll need to visit System Settings > Privacy & Security" ([Apple, 2024-08-06](https://developer.apple.com/news/?id=saqachfa)). Ad-hoc signatures "cannot pass through Gatekeeper" (cited in [06](06-distribution-and-links.md)).
- **What appears** (third-party guides and Apple Support via snippets, **UNVERIFIED** wording):
  1. "“Threadback” Not Opened. Apple could not verify “Threadback” is free of malware that may harm your Mac or compromise your privacy." [Done] [Move to Trash].
  2. Apple menu > System Settings > Privacy & Security, scroll to Security: "“Threadback” was blocked to protect your Mac." [Open Anyway]. Third-party guides say the button shows for about an hour after the block.
  3. Admin password or Touch ID.
  4. A second dialog with [Open Anyway] again.
- **Count:** Download (1), open (1), Done (1), System Settings path (3–4), Open Anyway (1), password (1), open the app again (1), Open Anyway (1). **About 10 clicks**, two of them next to the words "malware" and "Move to Trash".
- **Format differences:** zip and DMG behave the same, because the check runs when the app launches. An unsigned `.pkg` is blocked the same way before Installer even starts (**UNVERIFIED**). Tahoe 26 guides describe the same flow. I found no report of a change in macOS 27 (**UNVERIFIED**).
- **"Damaged" failure:** an app whose signature is missing or broken (for example, files changed after signing, or an incompletely signed bundle) gets "“Threadback” is damaged and can't be opened. You should move it to the Trash." It has no Open Anyway button, and the only fix is `xattr -cr` in Terminal ([macos-tahoe.com guide](https://macos-tahoe.com/blog/app-is-damaged-cant-be-opened-macos-tahoe-gatekeeper-quarantine-fix-2026/), snippet only). For a stranger it is a dead end.
- **Every update repeats this**, and ad-hoc code also loses its Full Disk Access and Automation grants on every update ([Apple DTS, "On File System Permissions"](https://developer.apple.com/forums/thread/678819): "If your code is unsigned, or signed ad hoc … the system can't tell that version N+1 of your code is the same as version N").

### (c) Signed and notarized `.pkg`

- Notarization accepts "signed flat installer packages" and nested containers ([Apple](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)).
- **Steps:** Download (1), open (1), possibly "This package will run a program to determine if the software can be installed" [Continue] (1, only with scripts), Introduction [Continue] (1), [Install] (1), admin password (1), [Close] (1), "Move the installer to the Trash?" (1). **6–8 clicks.**
- **Scary moments:** an admin password, and "run a program". A user who is not an admin cannot finish.
- **When it helps:** only if something must go outside `~/Applications`. This app needs nothing of the kind, so a pkg adds steps and fear for no gain.

### (d) Mac App Store

- Link (1), Get (1), Install and authenticate (1), Open (1). **4 clicks, no fear.**
- Not feasible for this app (section 3).

### (e) TestFlight for Mac

- Install TestFlight from the Mac App Store (3), open the public link (1), Accept (1), Install (1), Open (1). **About 7 clicks.**
- Builds expire after 90 days, and external testing needs Beta App Review ([Apple](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/), cited in 06).
- **Same sandbox wall as the Store.** Uploads to App Store Connect fail ingestion with `ITMS-90296 App sandbox not enabled` ([forum examples](https://developer.apple.com/forums/thread/768361)). That this check applies to TestFlight-only builds is my inference from the shared upload path.

### (f) AppleScript applet or `.command` file

- **Applet:** Script Editor applets are app bundles, so a downloaded one gets route (b). Applets that save `property` values rewrite themselves, which breaks the signature, invites "damaged" and resets permissions. This is inference; test it.
- **`.command`:** a browser download keeps the quarantine flag and may lose the executable bit. The likely results are a Gatekeeper block or "could not be executed because you do not have appropriate access privileges" (**UNVERIFIED** on 15/26/27). Neither format can be stapled ("it's not currently possible to staple tickets to" standalone binaries, [Apple](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)).
- **Verdict:** worse than (b), with no upside.

### (g) Today's `curl | bash`

- **Steps:** open Terminal (⌘Space, type, Enter: 3), paste (1), Enter (1).
  - If Python is missing, the Command Line Tools dialog appears: Install (1), Agree (1), then minutes of waiting ([03](03-mac-chatdb-applescript.md), **UNVERIFIED** on a clean Mac).
  - Full Disk Access for Terminal: about 5 actions, then quit and reopen Terminal (2).
  - Typed commands: `doctor`, `agent --chat …` (3 or more), then Allow at the Automation prompt (1).
  - The Terminal window must then stay open for good.
  - **About 15–20 actions, several of them typed.**
- **Scary moments:** Terminal itself; granting Full Disk Access to Terminal, which covers everything ever run in it ([MAC.md](../MAC.md)); and typed commands. No Gatekeeper prompt appears.

## 2. Developer ID and notarization in practice (2026)

- **Cost:** 99 USD per membership year ([Apple](https://developer.apple.com/programs/enroll/)).
- **Enrolment:**
  - Requirements: an Apple Account with two-factor authentication, legal age, and your legal name in the account. "Using an alias, nickname, or company name … will cause a delay."
  - Paying by card as an individual requires your own card, "or … you'll be asked for a copy of your government-issued photo identification".
  - Timing: "If you haven't received a membership confirmation within 24 hours of your purchase, contact us" ([Apple](https://developer.apple.com/support/enrollment/)). Apple gives no other timeline.
  - **Privacy:** as an individual, "your personal legal name will be listed as the seller". The Developer ID certificate likewise names you (`Developer ID Application: <legal name> (<team id>)`; format from memory).
- **Notarization turnaround:**
  - Apple: "most software within 5 minutes, and … 98 percent of software within 15 minutes" ([Apple](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)).
  - **First submissions from new accounts** stuck "In Progress" for 1–4 days were widely reported in February–March 2026. Apple DTS: "Occasionally, some uploads are held for in-depth analysis … it usually clears in a day or two. I start to worry if it's been more than a week" ([forum 814827](https://developer.apple.com/forums/thread/814827)).
  - Budget a few days for the first release.
- **Requirements** ([Apple](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)): "Enable code-signing for all of the executables you distribute"; a Developer ID certificate, not "ad hoc"; the Hardened Runtime; a secure timestamp; no `get-task-allow`.
- **Apple events under the Hardened Runtime:** sending them needs the [`com.apple.security.automation.apple-events`](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.automation.apple-events) entitlement ("first enable the Hardened Runtime capability … then under Resource Access, select Apple Events"), plus `NSAppleEventsUsageDescription` in Info.plist ([03](03-mac-chatdb-applescript.md)).
- **Credentials:** `notarytool` takes an app-specific password ("you must create an app-specific password for `notarytool`", [Apple](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)) or an App Store Connect API key (`--key/--key-id/--issuer`, from `man notarytool`, **UNVERIFIED** here).
- **CI on GitHub:**
  - GitHub documents importing a base64 `.p12` into a temporary runner keychain, with secrets `BUILD_CERTIFICATE_BASE64`, `P12_PASSWORD` and `KEYCHAIN_PASSWORD` ([GitHub Docs](https://github.com/github/docs/blob/main/content/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications.md)).
  - Runners: `macos-26` / `macos-latest` (arm64), `macos-26-intel` (x64), and `macos-15` ([runner-images](https://github.com/actions/runner-images)).
  - `hdiutil` creates DMGs on any macOS runner (standard tool, not checked).
  - Secrets are not passed to workflows triggered from forks (GitHub's default, from memory), so run releases only from tags the owner pushes.
- **Updates with Sparkle 2** (current 2.10.1, which needs macOS 12 or later; [CHANGELOG](https://github.com/sparkle-project/Sparkle/blob/2.x/CHANGELOG)):
  - `generate_keys` once; put the public key in `SUPublicEDKey` and the feed URL in `SUFeedURL`.
  - `generate_appcast <folder>` signs the archives, writes `appcast.xml` and delta updates.
  - Host the archives and the appcast anywhere static: GitHub Releases for the files, GitHub Pages for `appcast.xml`.
  - `generate_keys -x` exports the private key for CI ([Sparkle docs](https://github.com/sparkle-project/sparkle-project.github.io/blob/master/documentation/index.md), [publishing](https://github.com/sparkle-project/sparkle-project.github.io/blob/master/documentation/publishing/index.md)).
  - Sparkle needs Developer ID or Apple Development signing for library validation; with an ad-hoc signature "the system may not let your application load Sparkle".
- **Permission grants on update:** the system remembers a decision only for "a stable code signing identity" ([Apple DTS](https://developer.apple.com/forums/thread/678819)). The same bundle ID and Team ID, updated in place, keep Full Disk Access and Automation (inference from that post, and what users of Developer ID apps see). Changing the bundle ID, the Team ID or the signing type loses them.

### Minimal release pipeline

1. **Once:**
   1. Enrol.
   2. Create a "Developer ID Application" certificate and export it as `.p12`.
   3. Create an App Store Connect API key (or an app-specific password).
   4. Run `generate_keys` and export the private key.
   5. Add six repository secrets: certificate, its password, keychain password, the API key file, key ID and issuer ID. Add the EdDSA key as a seventh.
2. **On a `v*` tag, on `macos-26`:**
   1. Import the certificate into a temporary keychain.
   2. Run `xcodebuild archive` with a universal build, then `xcodebuild -exportArchive` with the Developer ID method. That signs every nested binary with the Hardened Runtime and a secure timestamp.
3. Run `ditto -c -k --keepParent Threadback.app Threadback.zip`, then `xcrun notarytool submit Threadback.zip --key … --wait`.
4. Run `xcrun stapler staple Threadback.app`, then zip again for distribution. A zip cannot itself be stapled ([Apple](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)). Optionally build a DMG with an `/Applications` link, notarize and staple it too.
5. Run `generate_appcast` over the release folder, using the EdDSA key from the secret.
6. Upload the zip or DMG to a GitHub Release and publish `appcast.xml` on Pages.
7. On a clean Mac (or the macOS 15 runner), run `spctl -a -vv Threadback.app` and `stapler validate`.

## 3. Mac App Store feasibility for this exact app

- **The sandbox is mandatory.** Guideline 2.4.5(i): "They must be appropriately sandboxed". 2.4.5(vii): updates only through the Store. 2.4.5(iii): no code that runs at login "without consent". 2.5.2: apps "may not read or write data outside the designated container area" ([App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)).
- **Reading `chat.db`: possible in principle, fragile.**
  - Apple: the sandbox extends to "a document that's outside your app's sandbox" when the user picks it in an open panel, and a security-scoped bookmark keeps that access across launches ([Apple](https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox)).
  - The Messages folder has a second lock (mandatory access control): "if the user grants you access to `~/Library`, that does not give you access to `~/Library/Mail` because the latter is protected by MAC" ([Apple DTS](https://developer.apple.com/forums/thread/678819)).
  - One developer reports that selecting `~/Library/Mail` *itself* in the panel works, while a parent folder does not ([forum 799832, Sept 2025](https://developer.apple.com/forums/thread/799832)). That Messages behaves the same is **UNVERIFIED**.
  - Apple DTS: a sandboxed app "still need[s] a sandboxed extension" even with Full Disk Access ([forum 124895](https://developer.apple.com/forums/thread/124895)).
  - **Precedent:** [Messages Export Pro](https://wideanglesoftware.com/messagesexportpro/) is on the Mac App Store and loads Mac Messages after "access to Contacts and Messages" is allowed. Its mechanism is **UNVERIFIED** (snippets only).
- **Sending: very unlikely to pass review.**
  - Messages publishes no scripting-target access groups, as far as I can tell. That leaves the `temporary-exception.apple-events` entitlement for Messages (bundle ID `com.apple.MobileSMS`, from memory).
  - Apple DTS, April 2026: "App Review rarely approves folks to use temporary exception entitlements" ([forum 823455](https://developer.apple.com/forums/thread/823455)).
  - A TestFlight build was rejected in 2026 for that exception for Finder and Terminal ([forum 852292](https://developer.apple.com/forums/thread/852292)).
  - **The one sandbox-legal route:** a script the user places in `~/Library/Application Scripts/<bundle id>` and runs with `NSUserAppleScriptTask`, outside the sandbox. The user must put it there by hand. One developer reports a rejection merely for referring to such scripts (old report, snippet only).
- **Setup instructions are themselves a risk.** A community answer (not Apple) says "any kind of tutorial or help regarding Full Disk Access or Sandbox escape is an automatic rejection" ([forum 125243](https://developer.apple.com/forums/thread/125243)). Guideline 5.1.2(v) also wants "a clear description of how the message will appear to the recipient before sending it". I found no Mac App Store app that sends iMessages automatically.
- **Verdict:**
  - A read-only "make a recap and share it yourself" Store app: plausible, medium confidence.
  - The `/wrapped` auto-reply bot: **not feasible through the Mac App Store**, about 85% confident.

## 4. Package the Python helper, or rewrite natively?

| Option | Download (estimate) | Notarization pain | Name and icon in prompts | Updates | Verdict |
|---|---|---|---|---|---|
| **Swift app** (MenuBarExtra, `NSAppleScript` in-process, SQLite3, `engine.js` in JavaScriptCore, card via AppKit or `ImageRenderer`) | ~3–8 MB universal | Lowest: Xcode signs everything | **"Threadback"**, its own icon, for Full Disk Access and "“Threadback” wants access to control “Messages”" | Sparkle, in place | **Recommended** |
| [Briefcase](https://github.com/beeware/briefcase/blob/main/docs/en/reference/platforms/macOS/index.md) (embedded Python, compiled stub) | ~40–60 MB with Pillow | Built in ("By default, apps will be both signed and notarized"; universal by default), but grants `disable-library-validation` and `allow-unsigned-executable-memory` by default; it warns notarization "can take … hours" | The app, since the stub is the main executable (inference); `osascript` children attribute to the app (Apple DTS on responsible code) | Sparkle possible; every update re-notarizes the whole Python tree | Fastest port of today's code |
| [PyInstaller](https://github.com/pyinstaller/pyinstaller/blob/develop/doc/feature-notes.rst) | ~30–50 MB | Signs collected binaries and turns on the Hardened Runtime with a real identity; `universal2` only from a `universal2` Python; it signs `.app` with `--deep` | As Briefcase | As Briefcase | Workable, more DIY |
| py2app | Similar | Manual signing of every `.so` | As above | As above | No advantage over Briefcase |
| Platypus (script in a wrapper app) | Small, plus whatever Python it calls | System Python means the Command Line Tools prompt; must bundle Python anyway | Wrapper app | Manual | No |

- **Why Swift:** the repo already has portable Swift. `RecapLink.swift` and `RecapPayload.swift` import only Foundation and Compression; `RecapCardRenderer.swift` uses UIKit and needs a port.
- **One stats engine everywhere:** `web/make/engine.js` is a dependency-free "classic script" with a pure `computeStats`. Running it in JavaScriptCore keeps the byte-for-byte conformance tests meaningful (inference: its only `require` is the Node `zlib` branch).
- **Permissions in-process:** in-process `NSAppleScript` keeps the Apple-events entitlement and the Automation prompt on the app itself. Whether a hardened app's `osascript` child is treated the same way is **UNVERIFIED**.
- **Size:** the Python sizes are my estimates and **UNVERIFIED**.

## 5. Routes with no install

- **Shortcuts on a Mac**, checking each link of the chain:
  1. **Message-triggered automation on Mac:** macOS 26 added automations to Shortcuts on the Mac (Apple's "What's new" via snippet: Wi-Fi, Bluetooth, Display, Stage Manager, App, Battery, Charger, folder and file triggers). A Message or Email trigger on Mac is reported only by third parties ([How-To Geek](https://www.howtogeek.com/dont-wait-get-these-macos-26-tahoe-features-right-now/), snippet). **UNVERIFIED.**
  2. **Sharing:** a shortcut can be shared as an iCloud link. Automations cannot; each user builds one by hand, about 8 clicks (community knowledge, **UNVERIFIED** for macOS 26/27).
  3. **What the trigger receives:** on iOS, only the triggering message and its sender, never the conversation; group behaviour is **UNVERIFIED** ([02](02-ios-history-apis.md)).
  4. **Reading history:** the actions are named "Find Message" / "Find Conversation" in Apple's list (snippet). Their Mac availability is **UNVERIFIED**.
  5. **Computing the recap:** "Run JavaScript for Mac Automation" and "Run Shell Script" exist on the Mac. They need Shortcuts > Settings > Advanced > **Allow Running Scripts**, plus per-shortcut privacy prompts (Apple guide via snippet; [forum 689436](https://developer.apple.com/forums/thread/689436) shows the "security settings don't allow scripting actions" error). `engine.js` could in theory run in JXA.
  6. **Replying:** Send Message to a group is documented for iOS 27, not the Mac (**UNVERIFIED**). A recap *image* would need extra actions.
  7. **Verdict:** at least four unverified links and about 15 manual steps. Worth one hour of testing on a macOS 26/27 Mac, not a plan.
- **iPhone (iOS 26/27):**
  - There is no script action.
  - A shortcut *can* tally senders with Repeat/Dictionary actions (slow) and use the Use Model action for awards, so a text-only recap on the owner's own phone is conceivable (inference).
  - Handing a year of rows to a web page through "Open URL" hits URL limits, and the page cannot reply into the thread.
  - Handing rows to an App Intent needs an installed app (paid program).
  - "Get Contents of URL" to our server needs spending and uploads message text.
  - [02](02-ios-history-apis.md) already rates the message-triggered bot "demo only".
- **Browser, no bot:** the existing web maker reads a `chat.db` chosen in a file picker. That makes a one-off recap with no install, but cannot answer `/wrapped`. Whether a browser without Full Disk Access can open `~/Library/Messages/chat.db` is still **UNVERIFIED** ([03](03-mac-chatdb-applescript.md) §3).
- **Conclusion:** no zero-install route answers `/wrapped` for a stranger.

## 6. Other things worth knowing

- **Homebrew:** not for these users. Official casks must pass Gatekeeper; `--no-quarantine` was deprecated in 5.0.0; personal taps need explicit trust since 6.0.0 ([03](03-mac-chatdb-applescript.md) §8). A personal-tap formula suits technical users only.
- **Setapp:** a subscription storefront for notarized, non-App Store Mac apps; it needs a vendor agreement and review (**UNVERIFIED**, not researched further). Wrong fit for a free app a stranger installs once.
- **GitHub Releases:** free, and fine as the download and Sparkle host. The repository is already public, but a release binary and a landing page are new public artefacts aimed at strangers. Under [DECISIONS](../DECISIONS.md) that needs the owner's approval, as does the $99.
- **Safari auto-unzip:** makes a zip download the fewest clicks (section 1a). Ship an archive containing only the app.
- **"Damaged":** the failure strangers cannot fix. Prevent it by signing every nested binary inside Xcode's export, never with `--deep` after the fact, and verifying on a clean Mac.
- **Apple silicon and Intel:** macOS 27 is Apple silicon only, but Tahoe 26 still runs on Intel Macs. Ship a universal binary (free in Swift). Python needs `universal2` wheels or a separate build per architecture (PyInstaller notes).
- **Start at login:** `SMAppService` (macOS 13+) shows a "Background Items Added" notification (wording **UNVERIFIED**), allowed by 2.4.5(iii) only "with consent". Ask in the app first.

## Comparison of routes

| Route | Clicks to first launch | Scary moments | Cost | Time to ship | Risk |
|---|---|---|---|---|---|
| Notarized native app, zip + Sparkle | 4–5 | None | $99/yr | ~1–2 weeks build + 1–3 days enrol/first notarization | Low; new-account notarization delays |
| Notarized native app, DMG | 5–7 | None; running from the DMG | $99/yr | Same | Low; translocation if not moved |
| Notarized `.pkg` | 6–8 | Admin password, "run a program" | $99/yr | Same + Installer work | Low; non-admins blocked |
| Notarized Briefcase-wrapped Python | 4–7 | None | $99/yr | ~2–4 days | Medium: 50 MB, library-validation exemptions, slower notarization |
| **Free: one Terminal paste installs an unquarantined app** | Terminal 3 + paste 2 | Opening Terminal | $0 | ~1–2 weeks (same app) | Medium: relies on `curl` not quarantining (**UNVERIFIED**); Apple could close it |
| Free: ad-hoc app from a browser + Open Anyway | ~10 | "could not verify … malware", "Move to Trash", password | $0 | Same app | High: repeated on every update; permissions reset |
| Today's `curl \| bash` CLI | 15–20, some typed | Terminal, Full Disk Access to Terminal, open Terminal forever | $0 | Done | Medium: Command Line Tools prompt, fragile |
| Mac App Store | 4 | None | $99/yr | Weeks | Very high: sandbox; send blocked; tutorials rejected |
| TestFlight for Mac | ~7 | None | $99/yr | Days | Same as App Store + 90-day expiry |
| AppleScript applet / `.command` | ≥10 | As ad-hoc, plus "damaged" | $0 | Hours | High |
| Shortcuts only (Mac) | ~15 manual | "Allow Running Scripts" | $0 | Unknown | Very high: 4+ unverified links |

## 7. Recommendation

**Ranking for a stranger, fewest clicks and least fear first:**

1. Notarized zip
2. Notarized DMG
3. Notarized pkg
4. Free Terminal paste that installs an app
5. Ad-hoc app with Open Anyway
6. Today's CLI

The Mac App Store and Shortcuts are not viable for the bot.

**(i) If the owner pays for the Developer Program:**
- A Swift menu-bar app, Developer ID-signed, notarized, stapled, universal.
- A zip on GitHub Releases, with Sparkle updates and the appcast on Pages.
- In-process `NSAppleScript` and an in-app permission walkthrough.

**(ii) With zero spending:**
- The same Swift app, ad-hoc-signed, installed by one pasted line: `curl -fsSL …/install.sh | bash`. The script downloads the app into `~/Applications` and opens it.
- If `curl` indeed adds no quarantine flag, Gatekeeper never asks. From there the stranger sees the same app-driven setup as in (i).
- **Two costs:**
  - Every update (re-running the line) changes the ad-hoc code hash, so Full Disk Access and Automation must be granted again. Keeping the launcher binary unchanged and shipping updatable parts outside the bundle might avoid this (inference, **UNVERIFIED**).
  - Opening Terminal remains the one scary moment.
- Test the whole route on a clean macOS 15, 26 and 27 Mac before publishing.

**(iii) What the owner can run today:** the existing CLI, exactly as [MAC.md](../MAC.md) describes. Run the 2-minute checklist first. The group send on 26/27 is the real blocker for every route above.

### Script for (i): landing page to working `/wrapped`

1. On the landing page, click **Download Threadback for Mac**.
2. If Safari asks whether to allow downloads from the site, click **Allow**.
3. Click the downloads arrow in Safari's toolbar, then click **Threadback**. Safari has already unzipped it.
4. macOS asks: "“Threadback” is an app downloaded from the Internet. Are you sure you want to open it?" Click **Open**.
5. Threadback asks "Move to your Applications folder?" Click **Move**. It reopens from there.
6. The welcome window explains, in one screen, what is read, what is sent and that replies come from your Apple ID. Click **Continue**.
7. "Let Threadback read your Messages": click **Open System Settings**. The app opens the Full Disk Access pane and shows its own icon to drag in.
8. Switch **Threadback** on (drag the icon in, or use **+** and choose it), then confirm with Touch ID or your password.
9. When macOS offers **Quit & Reopen**, click it. Threadback reopens and shows "Can read your messages ✓".
10. "Pick the group chats where /wrapped should work": tick one or more chats, then click **Next**.
11. Click **Preview** to see the card that would be sent. Optional.
12. Click **Send a test message**. macOS asks "“Threadback” wants access to control “Messages”". Click **Allow**. The app sends one test line to the chat you picked and confirms it arrived.
13. Click **Start**. If asked, allow Threadback to open at login. A small icon appears in the menu bar.
14. Done. Anyone in a chosen chat types `/wrapped`, and the card, text and link appear while this Mac is awake. Updates arrive through Sparkle's "A new version is available" window (**Install Update**), and the permissions stay.

Total: about 12–15 actions, two of them in System Settings, with no Terminal and no malware warning. Steps 7–12 belong to the permissions note and may change with its findings.

## UNVERIFIED

- Exact dialog wording on 15/26/27 (sections 1a, 1b, the login-item notification); any Gatekeeper change in macOS 27.
- Whether `curl` downloads stay unquarantined on 15/26/27, and whether an unquarantined ad-hoc app then launches with no prompt (route ii).
- Whether selecting `~/Library/Messages` in an open panel gives a sandboxed app read access; how Messages Export Pro does it.
- That TestFlight-only Mac builds are held to the sandbox check (inferred from `ITMS-90296`).
- Whether a hardened app's `osascript` child needs the app's Apple-events entitlement, and which name its prompt shows.
- The Shortcuts-on-Mac chain: a Message trigger on Mac, Find Message on Mac, Send Message to a group on Mac, sharing automations.
- Python bundle sizes; Pillow `universal2` wheel availability.
- App Store Connect API key flags for `notarytool` (from memory); the Developer ID certificate's name format; Messages' bundle ID `com.apple.MobileSMS`.
- Safari's per-site download prompt and auto-unzip defaults in Safari 26/27.
- Setapp's requirements.

## Sources

All inline. Read in full: Apple's notarization, customizing-notarization, sandbox file-access and Apple-events entitlement docs (JSON API); the Sequoia Gatekeeper news item; the enrolment pages; App Review Guidelines (sections 1–5.2); developer forum threads 678819, 799832, 124895, 125243, 29516, 823455, 852292 and 814827; the Sparkle documentation and CHANGELOG; the Briefcase macOS reference; PyInstaller's feature notes; GitHub Docs on signing on macOS runners; the runner-images README. Snippet-only: Apple Support pages, How-To Geek, macos-tahoe.com, iBoysoft, Eclectic Light, Wide Angle Software.
