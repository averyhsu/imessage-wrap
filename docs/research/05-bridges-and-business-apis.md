# 05 — Third-party iMessage bridges/APIs and Apple Messages for Business

_Checked 2026-11-11. Vendor sites (sendblue.com, loopmessage.com, linqapp.com, blooio.com,
photon.codes, register.apple.com, apple.com) are blocked from this sandbox, so their facts and
all prices come from search-engine extracts of those pages read on 2026-11-11, not from the
live pages. GitHub sources were fetched directly. Re-read any price before spending._

## Verdict

- A cloud "Wrapped bot" added to the group is the only path where typing `/wrapped` in the
  thread works on iPhone with no install, and shipping products prove it works
  ([Instinct](https://runtimewire.com/article/instinct-group-ai-agent-imessage),
  [Anuma's Coco](https://www.anuma.ai/ai-for-friend-groups)).
- It fails as the **main product**: it sees nothing sent before it joined, every later message
  leaves the devices, a line costs about $40–$290 a month, and Apple's own terms disfavour it.
- It is viable as a clearly labelled **opt-in extra** ("count from today, deliver in-thread").
- Apple Messages for Business is 1:1 only. BlueBubbles reads full history but needs the
  user's Mac, and its Private API needs SIP off.
- One hypothesis is wrong: three providers now send interactive iMessage-app bubbles.

## Comparison

| Provider | How it works | Existing group chats | Pre-join history | Interactive bubble | Price (read 2026-11-11) | Sign-up | ToS risk | Privacy cost |
|---|---|---|---|---|---|---|---|---|
| **Sendblue** | Hosted line, REST + webhooks (hardware set-up undisclosed) | Group API in beta, "select plans", up to 25; webhook carries `group_id` + `participants`; reactions API; no typing in groups | No | No evidence | Free sandbox (shared number, 10 verified contacts, no card); $100/line/month, inbound-first; Enterprise custom | Self-serve; sales for outbound | High | All post-join content to Sendblue and us |
| **LoopMessage** | Same model | Cannot create or manage groups; "can only receive and reply" in them; text, attachments, reactions | No | No evidence | Sandbox $0; Light $59.99/month, Regular $99.99 (**UNVERIFIED**, third-party) | Self-serve | High | Same |
| **Linq** | Same model | Create groups, add/remove participants (iMessage only, 3+ members); `message.received`, `participant.added`, `chat.created`; no typing or receipts in groups | No | **Yes**: `imessage_app` part, in-place update, hosted "experiences" | Free 7-day sandbox (100 messages/day, inbound-first); production price unpublished | Email for sandbox; sales after | High; documents Apple-flagged lines | Same |
| **Blooio** | Same model | Groups, reactions, signed webhooks; no receipts in groups | No | **Yes**: "custom bubbles" (beta, your own signed extension) | $39/month shared, $289 dedicated (a press release says $98; conflicting) | Self-serve | High | Same |
| **Photon** | Cloud lines (Spectrum), or open-source `imessage-kit` on your own Mac | Cloud: DM and group spaces, tapbacks, typing. Local kit: reads and sends, no tapbacks | Cloud no; local yes | **Yes**, cloud only: mini-app cards | Free shared pool; Pro $25/month, Business $250/line (**UNVERIFIED**, third-party) | Self-serve | High (cloud) | Cloud same; local none |
| **BlueBubbles** | Open-source server on the user's Mac; REST + webhooks; optional Private API | Full: the Mac is already a member | **Yes**, whole `chat.db` | No | Free | Always-on Mac, Full Disk Access; Private API needs SIP off | Low for personal use | None if we compute locally |
| **Beeper** | iMessage only in Beeper Desktop on a Mac; local API on `localhost:23373` (beta) | Whatever that Mac sees | Yes | No | Free; Plus $9.99/month | Beeper account + Mac | Medium; Beeper no longer troubleshoots iMessage | Local |
| **Cloud Mac + BlueBubbles** | Rent a bare-metal Mac, sign in a bot Apple ID | As BlueBubbles, with a bot identity | No | No | About $80–$200/month | New Apple ID, host account | High, and we carry the ban | All content to our Mac |
| **Apple Messages for Business** | Official, through an approved provider (MSP) | **None** | n/a | Yes, official "iMessage App" type | MSP fees (**UNVERIFIED**) | Apple Business Register, MSP, Apple review | None | n/a |

OpenBubbles, AirMessage and Sunbird are consumer clients, not bot APIs.
[OpenBubbles](https://raw.githubusercontent.com/OpenBubbles/openbubbles-app/rustpush/README.md)
"requires access to a Mac and an Apple ID". AirMessage's 2026 status is **UNVERIFIED**.
[Sunbird relaunched](https://macrumors.com/2026/08/05/sunbird-imessage-for-android) in August 2026.
Texts.com was [folded into Beeper](https://techcrunch.com/2025/07/16/beepers-all-in-one-messaging-app-relaunches-with-an-on-device-model-and-premium-upgrades/).

## Answers

**1. Can a bot be added, read everything after, and reply?** Yes, within Apple's limits: a
member can add someone only to a group that already has three or more people, all on Apple
devices ([Apple](https://support.apple.com/en-gb/108303)). One-to-one chats and mixed
SMS/RCS groups are out. LoopMessage documents exactly this role: it
["can only receive and reply"](https://loopmessage.com/apidocs/send-message/) in groups.
Sendblue's webhook carries [`group_id` and `participants`](https://docs.sendblue.com/getting-started/receiving-messages/);
Linq lists [`participant.added` and `chat.created`](https://docs.linqapp.com/guides/webhooks/events/).
"A member adds our line" is **UNVERIFIED** for Sendblue, Blooio and Photon; test in a sandbox.
All send images and links. Tapbacks: Sendblue, LoopMessage, Linq, Blooio, Photon. Typing
indicators do not work in groups on [Sendblue](https://docs.sendblue.com/api/resources/typing_indicators/)
or [Linq](https://docs.linqapp.com/guides/chats/group-chats/). **History before joining: none**
for any cloud bot; a new member sees only later messages
([Apple community](https://discussions.apple.com/thread/254419133)). Only tools on a member's
own Mac read history.

**2. Interactive bubbles?** Yes, since mid-2026. Linq sends an
[`imessage_app` part](https://docs.linqapp.com/guides/messaging/imessage-apps/index.md), updates
it [in place](https://docs.linqapp.com/api/resources/messages/methods/update_app_card/), and
offers ["experiences"](https://docs.linqapp.com/guides/messaging/experiences/) that render in
Linq's own app with no extension of ours. Blooio has
[custom bubbles](https://docs.blooio.com/guides/custom-bubbles). Photon has
[mini-app cards](https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features/apps)
through a launcher it says Apple approved. Recipients without the extension get a static card.
Behaviour in groups is **UNVERIFIED**. BlueBubbles' Private API has
[no balloon parameter](https://raw.githubusercontent.com/BlueBubblesApp/bluebubbles-server/master/packages/server/src/server/api/privateApi/apis/PrivateApiMessage.ts).

**3. Pricing and sign-up.** See the table. Free sandboxes exist at
[Sendblue](https://sendblue.com/pricing), LoopMessage and
[Linq](https://help.linqapp.com/what-is-sandbox-); Sendblue's and Linq's need no card. No
business verification was found for any entry tier. Linq production and Sendblue outbound
are priced by sales. Whether any sandbox allows group chats is **UNVERIFIED**.

**4. Terms and ban risk.** Apple's [Messages & Privacy](https://www.apple.com/legal/privacy/data/en/messages/)
page says "iMessage misuse may result in service limitations"; the Australian edition adds
that iMessage is for family and friends, not commercial activity (snippet truncated;
partly **UNVERIFIED**). Apple [shut down Beeper Mini](https://www.macrumors.com/2023/12/10/apple-confirms-it-shut-down-beeper-mini/)
within days in December 2023, then
[banned Macs](https://appleinsider.com/articles/24/01/14/beeper-mini-users-find-macs-banned-from-imessage-network)
used for Beeper in January 2024. Linq's help centre describes lines
[blocked by Apple](https://help.linqapp.com/flagged-number) for spam-like activity. Competitor
blogs report Linq closing sales-outreach accounts in October 2026
([source](https://bluereacher.com/blog/linq-limitations); **UNVERIFIED**). No broad Apple
crackdown on these providers was found. Apple's sanctioned route for agents is Messages for
Business: it [approved Poke](https://appleinsider.com/articles/26/06/04/first-ai-agent-for-messages-business-chat-approved-by-apple)
in June 2026. Provider consent rules are inbound-first; none was found for group members
(**UNVERIFIED**).

**5. Privacy.** The bot is a group member, so iMessage's encryption delivers every later
message to the provider's hardware, which forwards plain text to our webhook. That contradicts
"content stays on device". Per-member consent is not realistic: one member adds the bot, the
others only see a join notice, and their only opt-out is leaving. We could ignore messages
from members who have not replied "yes", but we would still receive them. Recording-consent
law was not researched (**UNVERIFIED**; needs legal advice).
[Coverage of Instinct](https://www.tekedia.com/instinct-puts-ai-agents-inside-group-chats-raising-new-privacy-and-permission-risks/)
shows the reaction to expect.

**6. BlueBubbles.** Without the Private API it adds little over `chat.db` plus AppleScript:
a REST API, [webhooks](https://raw.githubusercontent.com/BlueBubblesApp/bluebubbles-docs/master/server/developer-guides/rest-api-and-webhooks.md)
for new messages and participant changes, and attachment handling. The
[Private API](https://raw.githubusercontent.com/BlueBubblesApp/bluebubbles-docs/master/private-api/README.md)
adds tapbacks, typing indicators, replies, effects, mentions, edit and unsend, and group
create, rename and add/remove. History comes from `chat.db` either way. It
[requires](https://raw.githubusercontent.com/BlueBubblesApp/bluebubbles-docs/master/private-api/installation.md)
disabling SIP and library validation; on Apple Silicon that also disables iOS apps. Not
acceptable to ask of strangers.

**7. Apple Messages for Business.** One-to-one only: Apple's
[FAQ](https://register.apple.com/resources/messages/messaging-documentation/faq) says group
chat with a business is not supported, and the customer must start the conversation.
[Interactive types](https://register.apple.com/resources/messages/msp-rest-api/type-interactive):
quick reply, list picker, time picker, Apple Pay, authentication, forms and custom iMessage-app
messages. Onboarding needs an Apple Business Register account, an approved MSP and Apple
[review](https://register.apple.com/resources/messages/messaging-documentation/end-to-end).
Apple's RCS business messaging is also business-to-customer; group support is **UNVERIFIED**.

**8. Verdict.** (a) Main product: no. (b) Opt-in extra: yes. Demo: $0 on a sandbox, or
$40–$100 for one month (Blooio shared, LoopMessage Light, Sendblue), plus 1–2 days for a bot
that counts from joining and replies to `/wrapped` with an image. It needs owner approval for
the account, the card and sending into a real chat.

## Hypotheses

- Sendblue and LoopMessage as paid relays, post-join only, tens to hundreds of dollars:
  **right**. Both have free sandboxes; "Mac farm" is undisclosed.
- Messages for Business is 1:1: **right**.
- BlueBubbles Private API needs SIP off: **right**, plus library validation.
- No interactive bubbles: **wrong** (Linq, Blooio, Photon).

## Scores (best option here: managed cloud bot)

| Criterion | Score | Reason |
|---|---|---|
| In-Messages | 5 | Lives in the thread; `/wrapped` works |
| iPhone-only | 5 | No Mac for users |
| Works for everyone | 3 | All see replies; only all-iMessage groups of 3+ |
| Low setup | 4 | Add one contact |
| Usable by strangers today | 2 | Needs paid lines with daily new-contact caps |
| Privacy | 1 | All later content leaves devices |
| Wow factor | 3 | In-thread reply is strong; no history makes day-one stats thin |
| Feasibility | 3 | APIs exist; the history gap is structural |
| Cost | 2 | $40–$290 per line per month |
| Time to demo | 4 | 1–2 days after sign-up |
| App Store/ToS risk | 1 | Apple can flag lines |

## Implications for the build

- History must come from a member's own device; the bot cannot supply it.
- Keep the stats schema transport-neutral so a bot could later deliver the same card.
- If we ship an iMessage app extension, Linq, Blooio or Photon can post its bubble.
- Do not depend on BlueBubbles' Private API.

## Sources

Sendblue: [pricing](https://sendblue.com/pricing), [API page](https://sendblue.com/api),
[groups](https://docs.sendblue.com/getting-started/groups/),
[group feature page](https://www.sendblue.com/features/group-messaging),
[reactions](https://docs.sendblue.com/api-v2/reactions/),
[pricing write-up](https://getkanal.com/blog/sendblue-pricing).
LoopMessage: [send-message docs](https://loopmessage.com/apidocs/send-message/),
[campaigns](https://loopmessage.com/apidocs/campaigns/),
[pricing snapshot](https://www.xpay.sh/saas-pricing/loopmessage/),
[Blooio's comparison](https://blooio.com/alternatives/loopmessage).
Linq: [pricing](https://linqapp.com/s/pricing),
[rate limits](https://docs.linqapp.com/guides/platform/rate-limits/),
[add participant](https://docs.linqapp.com/api/resources/chats/subresources/participants/methods/add),
[hackathon notes](https://linqapp.com/hackathon).
Blooio: [pricing](https://blooio.com/integrations/api/pricing),
[webhook events](https://docs.blooio.com/api-reference/webhook-events),
[$98 press release](https://salestechstar.com/partner-management-channel-enablement/blooio-lowers-imessage-api-pricing-to-98-mo-adds-hubspot-integration-and-tier-1-carrier-partnerships/).
Photon: [imessage-kit README](https://raw.githubusercontent.com/photon-hq/imessage-kit/main/README.md),
[live mini-app cards](https://photon.codes/blog/you-can-now-send-live-mini-app-cards-in-imessage),
[pricing](https://photon.codes/pricing),
[MakerStack review](https://makerstack.co/reviews/photon-codes-review/),
[Hermes docs](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/photon).
BlueBubbles: [FAQ](https://bluebubbles.app/faq/).
Beeper: [Desktop API](https://developers.beeper.com/desktop-api/),
[support matrix](https://help.beeper.com/beeper-chat-support-matrix),
[iMessage on macOS guide](https://beeper.helpjuice.com/en_US/chat-networks/new-imessage-on-macos-getting-started-guide),
[Mac bans](https://mobilesyrup.com/2024/01/29/beeper-disables-imessage-connections-following-mac-bans/).
Apple: [MSP onboarding](https://register.apple.com/resources/messages/msp-onboarding/).
Context: [TechCrunch roundup of texting agents](https://techcrunch.com/2026/10/10/all-the-ai-agents-that-can-live-in-your-text-messages/),
[AirMessage server](https://raw.githubusercontent.com/airmessage/airmessage-server/master/README.md),
[RCS on iPhone](https://sinch.com/blog/apple-support-rcs/).
Cloud Macs: [MacStadium](https://www.whtop.com/plans/macstadium.com/138377),
[Scaleway](https://www.whtop.com/plans/scaleway.com/146127),
[AWS comparison](https://www.greenmini.nl/compare/aws-ec2-mac-alternative/).
