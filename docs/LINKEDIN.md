# LinkedIn post (draft)

Attach the clip from [`DEMO.md`](DEMO.md) and put the link in the first comment as well as
in the post.

**Before posting**, replace the bracketed parts:

- `[N]` and `[M]`: your own chat's numbers, after you have made a real recap (and the chat
  is fine with you sharing them). Do not post the demo's invented numbers as your own.
- `[PERSONALITY]`: what your chat came out as.
- `[LINK]`: the public site, once it is switched on
  (`https://averyhsu.github.io/imessage-wrap/`).

---

**Our group chat sent [N] messages this year. [M] of them after midnight.**

Music apps tell you about your year. Your group chat, the place you actually spent it, tells
you nothing. So I built the missing recap: like Spotify Wrapped, for your iMessage group chats.

It's called Threadback. One person makes the recap, drops a link in the chat, and everyone
taps through the same story:

→ how many messages you all sent, and when
→ your chat's personality (ours: [PERSONALITY])
→ who carried the conversation
→ the message of the year, picked by tapbacks
→ awards nobody asked for (The Lurker knows who they are)

How it works, in one line: the numbers are counted on your own device and packed into the
link itself, so there is no account, no upload, and nothing to install to watch.

The interesting constraint: Apple gives apps no way to read your message history on an
iPhone. So the recap is made where the history can be read (a Mac, or an iPhone backup),
right in the browser, and everyone else just taps the link.

I built it with Claude Code running a small team of AI agents: one researched each possible
route, others built and tested the pieces in parallel (including an iPhone app compiled and
run in Apple's simulator on cloud Macs), and two independent reviewers tried to break it.
They found real problems, and those got fixed before I posted this. The research notes and
every decision are in the repo.

Try the demo, then make one for your own chat: [LINK]
Code and write-up: https://github.com/averyhsu/imessage-wrap

What would your group chat's personality be?

#buildinpublic #sideproject #ios #ai

---

## Notes for posting

- **Shorter variant** (under about 600 characters): keep the first two lines, the five
  arrows, the "one line" paragraph and the link.
- **What to leave out until it is true.** The post describes only what works for anyone
  today: the link, the story and the browser maker. Two more pieces exist in the repo and
  can be added as a line each once you have seen them work on your own devices
  ([`STATUS.md`](../STATUS.md) has the checks):
  - the Mac helper that answers `/wrapped` in the chat ("Type /wrapped and it answers in
    the thread"), after one real send has worked on your Mac;
  - the app for the Messages app drawer, once people can install it (that needs TestFlight
    and the paid Apple Developer Program).
- **Names.** "Spotify Wrapped" and "iMessage" are other companies' trademarks. The post uses
  them only to describe what the project is like and what it works with; the product name is
  Threadback. Keep it that way in the headline and the video end card.
- **Quotes.** A recap leaves the words of messages out unless you switch them on. If your
  clip shows the message of the year with its text, ask whoever wrote it first.
- **Good first comment:** "How it's built, what Apple does and doesn't allow, and the eleven
  routes I scored before picking this one: [link to docs/DECISIONS.md]".
