# LinkedIn post (draft)

Attach the 40-second clip from [`DEMO.md`](DEMO.md). Put the link in the first comment as
well as in the post; LinkedIn tends to show posts with a native video to more people than
posts whose main content is a link.

Replace the bracketed parts before posting. `[LINK]` is the public site once it is switched
on (`https://averyhsu.github.io/imessage-wrap/`).

---

**Our group chat sent 48,213 messages this year. 6,277 of them after midnight.**

Music apps tell you about your year. Your group chat, the place you actually spent it, tells
you nothing. So I built the missing recap: like Spotify Wrapped, for your iMessage group chats.

It's called Threadback. Someone types /wrapped in the chat, and a tap-through story lands in
the thread:

→ how many messages you all sent, and when
→ your chat's personality (ours: The Night Owls)
→ who carried the conversation
→ the message of the year, picked by tapbacks
→ awards nobody asked for (The Lurker knows who they are)

How it works, in one line: the numbers are counted on your own device, packed into the link
itself, and the link opens the story for everyone in the chat. No account, no upload, no app
needed to watch.

The interesting constraint: Apple gives apps no way to read your message history on an
iPhone. So one person makes the recap from their Mac (or an iPhone backup), right in the
browser, and everyone else just taps. There's also an app for the Messages app drawer and a
tiny Mac helper that answers /wrapped automatically.

I built it with Claude Code running a small team of AI agents: one researched each possible
route, others built and tested the pieces in parallel (including an iPhone app compiled and
screenshotted on cloud Macs), and an independent reviewer tried to break it before I called
it done. The research notes and every decision are in the repo.

Try the demo, then make one for your own chat: [LINK]
Code and write-up: https://github.com/averyhsu/imessage-wrap

What would your group chat's personality be?

#buildinpublic #sideproject #ios #ai

---

## Notes for posting

- **Shorter variant** (if you prefer under 600 characters): keep the first two lines, the
  five arrows, the "one line" paragraph and the link.
- **Names.** "Spotify Wrapped" and "iMessage" are other companies' trademarks. The post uses
  them only to describe what the project is like and what it works with; the product name is
  Threadback. Keep it that way in the headline and the video end card.
- **Numbers.** 48,213 and 6,277 come from the invented demo chat. If you post your real
  chat's numbers instead, check with the people in it first.
- **Claims to keep honest.** Until you have run the real-device checklist in
  [`STATUS.md`](../STATUS.md), say "there's also a Mac helper" rather than showing it working,
  and do not say the app is on the App Store or TestFlight (that needs the paid Apple
  Developer Program).
- **Good first comment:** "How it's built, what Apple does and doesn't allow, and the eleven
  routes I scored before picking this one: [link to docs/DECISIONS.md]".
