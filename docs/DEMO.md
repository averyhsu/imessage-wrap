# Demo: a 40-second screen recording

The goal of the clip: someone who has never heard of this understands it in the first five
seconds and wants to try it by the end. No voice-over needed; captions carry it.

There are two ways to record it. **Version A** is the real thing on your own phone and needs
your yes on two things first (a public site and one real send, see
[`STATUS.md`](../STATUS.md)). **Version B** needs nothing and can be recorded today.

## Before you record

- **Use invented or consenting content.** The safest clip uses the built-in demo chat
  ("Dinner Club 🍝", all invented). If you record a real chat, ask the people in it first and
  keep quotes switched off unless they agree.
- iPhone: Settings → Control Center → add **Screen Recording**. Turn on Do Not Disturb.
  Set the clock to a tidy time, full battery, good signal.
- Record vertical, export 1080 × 1920. LinkedIn autoplays muted, so every beat needs a caption.
- Keep each beat short. The whole story takes about 80 seconds if left alone; **tap through
  it** so the clip stays under 45 seconds.

## Version A: the real thing (iPhone + the Mac helper)

Setup once: the site is live, the Mac helper is running for one group chat
(`threadback agent --chat "…" --keep-awake`, see [`MAC.md`](MAC.md)), and you have run its
2-minute checklist.

| Time | On screen | Caption |
|------|-----------|---------|
| 0:00–0:04 | The group chat in Messages. Type `/wrapped`, hit send. | "Our group chat sent 48,213 messages this year." |
| 0:04–0:09 | The reply lands in the thread: the recap card, a short text recap, and the link. Hold on the card for a beat. | "So I made it a year in review. Type /wrapped, get this." |
| 0:09–0:13 | Tap the link. Cover slide, then the big number counts up. | "It opens for everyone in the chat. No app." |
| 0:13–0:17 | Tap → the 24-hour clock → tap → **The Night Owls**. | "It knows what kind of chat you are." |
| 0:17–0:22 | Tap → **Who carried the chat** (the crown lands on the top sender). | "Who carried." |
| 0:22–0:27 | Tap → **Message of the year** with its tapbacks. | "The message of the year, by tapbacks." |
| 0:27–0:31 | Tap → **And the winners are…** (the awards grid). | "And the awards nobody asked for." |
| 0:31–0:35 | Last slide: tap **Share card**; the share sheet rises with the image. | "One card to share." |
| 0:35–0:40 | Cut to the "Make your own" page on a laptop: drag `chat.db` in, a chat list appears, a link comes out. | "Made on your own device. Nothing is uploaded." |
| 0:40–0:43 | End card: **Threadback** + the URL. | "Make one for your chat. Link below." |

Tips: record the phone and the laptop separately and cut them together. If the link bubble
shows an animated preview in the thread (it should, but that is one of the things only a real
phone can confirm), hold on it for a second at 0:08, because it looks great.

## Version B: no real chat, recordable today

Nothing here sends a message or needs an account.

| Time | On screen | Caption |
|------|-----------|---------|
| 0:00–0:05 | Phone browser (or a desktop browser at phone size) on the demo story: cover → count-up. | "What if your group chat got a year in review?" |
| 0:05–0:27 | Tap through the same slides as Version A (clock, personality, top senders, message of the year, awards). | Same captions as above. |
| 0:27–0:31 | Share card. | "One card to share." |
| 0:31–0:38 | The "Make your own" page with the **sample data** button: chat list → link. | "Runs in your browser. Nothing is uploaded." |
| 0:38–0:42 | The iOS Simulator screenshots of the app and the Messages bubble (`docs/screenshots/ios/`). | "And it lives in the Messages app drawer." |
| 0:42–0:45 | End card. | "The code is public. Link below." |

To play the demo story locally:

```sh
npm ci
npm run serve          # then open http://127.0.0.1:4173/?demo=1
```

There is also a ready-made, frame-perfect recording of the demo story for use as b-roll:
`npm run record` writes `docs/media/demo-story.mp4` (780 × 1688) and a short looping GIF.

## Shot checklist

- [ ] First frame is the chat, not a title card.
- [ ] The big number is on screen by second 12.
- [ ] No real phone numbers, names or messages visible unless everyone agreed.
- [ ] Captions readable on a phone with the sound off.
- [ ] Ends on the name and the link.
