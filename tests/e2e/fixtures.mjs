// Invented recaps for the robustness matrix. Nothing here comes from a real chat.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const vector = require('../vectors/payload-v1.json');

const clone = (o) => JSON.parse(JSON.stringify(o));
const round4 = (x) => Math.round(x * 10000) / 10000;

const NAMES = ['Maya', 'Dev', 'Priya', 'Jonah', 'Tess', 'Marcus', 'Lena', 'Okonkwo', 'Beatriz', 'Sven', 'Anneliese', 'Raj'];
const HOUR_PROFILE = [5, 3, 2, 1, 1, 0, 1, 2, 3, 4, 4, 4, 5, 5, 4, 4, 4, 5, 6, 6, 7, 8, 8, 8];
const WEEK_PROFILE = [12, 13, 13, 14, 16, 18, 14];
const MONTH_PROFILE = [8, 7, 9, 8, 9, 10, 13, 11, 9, 11, 5, 0];

/** Split `total` across `weights` so the parts are integers and sum exactly to total. */
function split(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  let left = total - parts.reduce((a, b) => a + b, 0);
  for (let i = 0; left > 0; i = (i + 1) % parts.length) { if (weights[i] > 0) { parts[i]++; left--; } }
  return parts;
}

/** A complete, internally consistent v1 recap. */
export function makeStats({ name = 'Dinner Club 🍝', members = 7, total = 48213, label = '2026', names = NAMES, quotes = true } = {}) {
  const who = names.slice(0, members);
  const weights = who.map((_, i) => Math.pow(0.78, i) * 100);
  const messages = split(total, weights);
  const byHour = split(total, HOUR_PROFILE);
  const lateTotal = byHour.slice(0, 5).reduce((a, b) => a + b, 0);
  const lateBy = split(lateTotal, who.map((_, i) => (i === 1 ? 5 : 1)));
  const reactions = Math.round(total * 0.19);
  const given = split(reactions, who.map((_, i) => 3 + ((i * 7) % 5)));
  const received = split(reactions, who.map((_, i) => 3 + ((i * 3) % 4)));
  const words = Math.round(total * 5.2);
  const wordsBy = split(words, weights);
  const attachments = Math.round(total * 0.065);
  const attBy = split(attachments, weights);
  const kinds = split(reactions, [24, 17, 2, 31, 13, 3, 10]);
  const senders = who.map((n, i) => ({
    name: n, messages: messages[i], share: round4(messages[i] / total), words: wordsBy[i], attachments: attBy[i],
    late_night: lateBy[i], reactions_given: given[i], reactions_received: received[i],
  })).sort((a, b) => b.messages - a.messages || (a.name < b.name ? -1 : 1));
  const topGiver = who.map((n, i) => ({ name: n, count: given[i] })).sort((a, b) => b.count - a.count)[0];
  const topReceiver = who.map((n, i) => ({ name: n, count: received[i] })).sort((a, b) => b.count - a.count)[0];
  const lateTop = who.map((n, i) => ({ name: n, messages: lateBy[i] })).sort((a, b) => b.messages - a.messages)[0];
  const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const last = senders[senders.length - 1];
  const stats = {
    v: 1,
    chat: { name, members },
    period: { label, start: '2026-01-01', end: '2026-11-10' },
    totals: { messages: total, words, attachments, reactions, days_active: Math.min(301, total), longest_streak: Math.min(87, total) },
    by_hour: byHour,
    by_weekday: split(total, WEEK_PROFILE),
    by_month: split(total, MONTH_PROFILE),
    busiest_day: { date: '2026-07-04', messages: Math.max(1, Math.round(total * 0.0127)) },
    personality: { id: 'night_owls', title: 'The Night Owls', blurb: 'Peak hour: 9 PM. Sleep is a suggestion.', peak_hour: 21 },
    late_night: { messages: lateTotal, share: round4(lateTotal / total), top: lateTotal > 0 ? lateTop : null },
    senders,
    most_reacted: [
      { sender: who[2 % members], reactions: 6, date: '2026-03-14', text: quotes ? 'Update: the “quick 5 minute recipe” has officially entered hour two' : '', kinds: { laugh: 4, emphasize: 1, love: 1 } },
      { sender: who[3 % members], reactions: 6, date: '2026-07-19', text: quotes ? 'I just waved back at someone who was not waving at me. Moving to a new city, goodbye forever' : '', kinds: { laugh: 5, emphasize: 1 } },
      { sender: who[(members - 1) % members], reactions: 6, date: '2026-09-02', text: quotes ? 'I GOT THE JOB!!!' : '', kinds: { love: 5, emphasize: 1 } },
    ],
    reactions: {
      by_kind: { love: kinds[0], like: kinds[1], dislike: kinds[2], laugh: kinds[3], emphasize: kinds[4], question: kinds[5], emoji: kinds[6] },
      top_giver: topGiver, top_receiver: topReceiver,
    },
    awards: members >= 3 ? [
      { id: 'yapper', emoji: '🗣️', title: 'The Yapper', winner: senders[0].name, detail: `${fmt(senders[0].messages)} messages. Nobody asked.` },
      { id: 'lurker', emoji: '👻', title: 'The Lurker', winner: last.name, detail: `${fmt(last.messages)} messages. Reads everything, says little.` },
      { id: 'night_owl', emoji: '🦉', title: 'The Night Owl', winner: lateTop.name, detail: `${fmt(lateTop.messages)} messages after midnight.` },
      { id: 'comedian', emoji: '😂', title: 'The Comedian', winner: topReceiver.name, detail: `Made the chat laugh ${fmt(Math.round(kinds[3] / 3))} times.` },
      { id: 'hype', emoji: '📣', title: 'The Hype Machine', winner: topGiver.name, detail: `Handed out ${fmt(topGiver.count)} tapbacks.` },
      { id: 'novelist', emoji: '📚', title: 'The Novelist', winner: senders[Math.min(2, members - 1)].name, detail: '10.0 words per message. A paragraph person.' },
    ] : [],
    meta: { generator: 'wrapped/1', source: 'fixture', generated: '2026-11-11' },
  };
  return stats;
}

const longNames = [
  'Maximilian Alexander von Hohenzollern-Sigmaringen', 'Bartholomew "Barty" Featherstonehaugh III', 'Wilhelmina Persephone Abernathy-Kowalczyk',
  'Seraphina', 'Christopher-Jonathan', 'Guadalupe Hernández de la Cruz', 'Ng', 'Æthelred', 'Zoë', 'Þórður', 'Łukasz', 'Siobhán',
];
const emojiNames = ['Maya 🌮', '🦖 Dev', 'Priya ✨✨', 'J', '👩‍🚀', 'Marcus 🇨🇦', 'Léna 💅', 'Ok', 'B', 'S', 'A', 'R'];
// People who are not in the owner's contacts arrive masked (docs/SCHEMA.md §2): an
// ellipsis plus the last four digits of a phone number, or the part of an e-mail before the @.
const maskedNames = ['…0001', 'Maya', 'jo.smith', '…4417', 'Tess', '…9902', 'averyveryverylon…'];

const tiny = makeStats({ name: 'Book Club (allegedly)', members: 4, total: 60, label: '2026' });
tiny.totals.words = 212;
tiny.totals.days_active = 19;
tiny.totals.longest_streak = 2;
tiny.busiest_day = { date: '2026-02-09', messages: 11 };
tiny.personality = { id: 'after_hours', title: 'The After-Hours Crew', blurb: 'Peak hour: 9 PM. The day ends. The chat begins.', peak_hour: 21 };
tiny.most_reacted = [{ sender: 'Priya', reactions: 2, date: '2026-02-09', text: 'has anyone actually read it', kinds: { laugh: 2 } }];
tiny.awards = tiny.awards.slice(0, 3);

const huge = makeStats({ name: 'ALL-HANDS (do not mute)', members: 12, total: 1200000, label: '2019–2026' });
huge.totals.days_active = 2811;
huge.totals.longest_streak = 1204;
huge.period.start = '2019-03-02';
huge.busiest_day = { date: '2024-11-05', messages: 18422 };
huge.personality = { id: 'always_on', title: 'The Always-On Group Chat', blurb: 'Peak hour: 9 PM. There is no off switch.', peak_hour: 21 };
huge.most_reacted[0].reactions = 148;
huge.most_reacted[0].kinds = { laugh: 96, love: 30, emphasize: 14, like: 5, question: 2, emoji: 1 };
huge.most_reacted[0].text = 'Reminder that the “quick sync” from Tuesday is now in its third calendar day and has spawned two sub-threads, a spreadsheet nobody can open, and a rival group chat. Please advise. Also whoever keeps reacting with a thumbs down to the lunch poll: we can see you, it has your name on it';

const duo = makeStats({ name: 'me & u', members: 2, total: 9204, label: '2026', names: ['Sam', 'Alex'] });
duo.awards = [];

const dozen = makeStats({ name: 'Cousins + plus-ones + the dog', members: 12, total: 31876, label: '2026' });
dozen.awards.forEach((a) => { a.ai = true; }); // opt-in AI-written awards carry this flag

const longName = makeStats({
  name: 'The Extremely Long Group Chat Name That Just Keeps Going And Going And Nobody Will Rename 🎉🎉', members: 9, total: 48213, label: 'Summer 2026', names: longNames,
});
longName.personality = { id: 'custom', title: 'The Supercalifragilistic Overcommunicators Anonymous', blurb: 'Peak hour: 9 PM. An unreasonably long blurb that someone asked an AI to write and that therefore goes on for rather longer than any of the built-in ones would, just to see what breaks.', peak_hour: 21 };
longName.awards.forEach((a) => { a.title = 'The ' + a.title.slice(4) + ' Of The Entire Year'; a.detail += ' And then some more words to make this run long enough to need clamping, truly.'; });
longName.most_reacted[2].text = 'Pneumonoultramicroscopicsilicovolcanoconiosis-supercalifragilisticexpialidocious-hippopotomonstrosesquippedaliophobia';

const unbroken = makeStats({ name: 'Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch', members: 3, total: 4020, label: '2026', names: ['Supercalifragilisticexpialidocious', 'Hippopotomonstrosesquippedaliophobia', 'Al'] });

const emojiName = makeStats({ name: '🍕🍕🍕 pizza fam 👨‍👩‍👧‍👦✨ ¡olé!', members: 7, total: 12345, label: '2026', names: emojiNames });

// The default recap: no message text (quotes are opt-in) and some members known only by
// a masked number. The most-reacted message and the top late-night sender are masked people.
const masked = makeStats({ name: '…0001, Maya, jo.smith & 4 more', members: 7, total: 20480, names: maskedNames, quotes: false });

// A seven-digit late-night count (nine characters with its separators): the widest number
// the late-night slide has to hold next to the moon.
const nightHuge = makeStats({ name: 'Insomniacs Anonymous', members: 6, total: 9876543 });
nightHuge.late_night.messages = 1234567;
nightHuge.late_night.share = 0.125;
nightHuge.late_night.top = { name: 'Bartholomew "Barty" Featherstonehaugh III', messages: 1004417 };
nightHuge.senders[1].late_night = 987654;
nightHuge.senders[2].late_night = 123456;

// Numbers no chat can have. normalize() caps them; nothing may print as "1e+21".
const astronomical = makeStats({ name: 'Numbers Station', members: 5, total: 4000 });
astronomical.totals = { messages: 1e21, words: 1e300, attachments: 5e24, reactions: 1e22, days_active: 1e21, longest_streak: 1e21 };
astronomical.by_hour = astronomical.by_hour.map((v, i) => (i === 21 ? 1e30 : 1e21));
astronomical.by_weekday = astronomical.by_weekday.map(() => 1e25);
astronomical.by_month = astronomical.by_month.map((v, i) => (i === 6 ? 1e40 : 1e21));
astronomical.busiest_day.messages = 1e21;
astronomical.late_night = { messages: 1e21, share: 5e20, top: { name: 'Dev', messages: 1e21 } };
astronomical.senders.forEach((x, i) => { x.messages = 1e21 * (5 - i); x.share = 1e9; x.late_night = 1e21; x.reactions_given = 1e21; });
astronomical.most_reacted[0].reactions = 1e21;
astronomical.most_reacted[0].kinds = { laugh: 1e21, love: 1e22, emphasize: 3e21, like: 1e21, question: 1e21, dislike: 1e21, emoji: 1e21 };
astronomical.most_reacted[1].reactions = 1e21;
Object.keys(astronomical.reactions.by_kind).forEach((k, i) => { astronomical.reactions.by_kind[k] = 1e21 * (i + 1); });
astronomical.reactions.top_giver.count = 1e21;
astronomical.reactions.top_receiver.count = 1e300;

// Right-to-left names, long enough to be truncated, including the people on the
// message-of-the-year slide (whose tapback counts must stay visible).
const rtlNames = [
  'عبد الرحمن بن محمد بن عبد العزيز آل سعود الهاشمي القرشي', 'מרדכי בן אליעזר הכהן מירושלים עיר הקודש', 'فاطمة الزهراء بنت عبد الله الأنصارية الخزرجية المدنية',
  'يوسف إسماعيل إبراهيم عبد الرحيم الطويل جداً جداً', 'נועה', 'Maya', 'שלמה זלמן בן ציון מאיר חי עוזיאל הלוי',
];
const rtl = makeStats({ name: 'مجموعة العائلة الكبيرة جداً وأصدقاء الطفولة من المدرسة القديمة', members: 7, total: 30200, names: rtlNames });
rtl.most_reacted[0].text = 'من سيحضر الحلوى هذه المرة؟ آخر مرة نسي الجميع 😅';
rtl.most_reacted[1].sender = rtlNames[0];
rtl.most_reacted[2].sender = 'Maximilian Alexander von Hohenzollern-Sigmaringen the Younger';
rtl.most_reacted[2].reactions = 1234;

// What a recap looks like when nothing is tuned: no contacts file, quotes off. The owner
// has a real first name, some members are in the chat by first name, the rest are masked
// numbers ("…0006"), and no message text travels. The top sender is a masked number, so
// the crown lands on "…0001". This is the recap behind the default-* screenshots.
const defaultNames = ['…0001', 'Sam', 'Maya', '…0006', 'Dev', 'Priya', '…4417'];
const defaultRecap = makeStats({ name: 'Sunday Dinner Club', members: 7, total: 18204, names: defaultNames, quotes: false });
defaultRecap.most_reacted[0].sender = '…0006';
defaultRecap.most_reacted[1].sender = 'Sam';
defaultRecap.most_reacted[2].sender = 'Maya';

// No message text and no breakdown of the tapbacks either: the bubble still has to say something.
// The winner here is a "blank message" (zero-width and filler characters), which must count as no text.
const quietNoKinds = makeStats({ name: 'Quiet Ones', members: 4, total: 2400, quotes: false });
quietNoKinds.most_reacted.forEach((m) => { m.kinds = {}; });
quietNoKinds.most_reacted[0].text = '\u200B\u2800\u3164';

// Names outside Latin: CJK without spaces, right-to-left scripts, combining marks.
const intl = makeStats({ name: '周末火锅小分队🔥ولائم نهاية الأسبوع', members: 6, total: 15230, label: '2026年', names: ['小明', 'محمد علي', 'Zoë', 'אורי', 'Ngọc Ánh', 'Åsa'] });
intl.most_reacted[0].text = '今晚谁带锅？我只负责吃。😋 من سيحضر الطبق الرئيسي؟';

// Only what a v1 consumer may rely on: everything optional is gone.
const bare = { v: 1, chat: { name: 'Bare Minimum', members: 5 }, period: { label: '2026' }, totals: { messages: 812 } };

// Optional sections present but empty / nulled, as the schema allows.
const sparse = makeStats({ name: 'Quiet Lately', members: 5, total: 2300 });
delete sparse.awards;
delete sparse.reactions;
sparse.totals.reactions = 0;
sparse.most_reacted = [];
sparse.late_night.top = null;
delete sparse.busiest_day;
sparse.totals.words = 0;
sparse.totals.attachments = 0;

const noQuotes = makeStats({ name: 'Dinner Club 🍝', members: 7, total: 48213, quotes: false });
noQuotes.awards.forEach((a) => { delete a.detail; });

const zeroNight = makeStats({ name: 'Early To Bed', members: 4, total: 5000 });
zeroNight.by_hour = split(5000, [0, 0, 0, 0, 0, 0, 3, 8, 9, 6, 5, 5, 7, 6, 5, 5, 5, 6, 7, 8, 6, 4, 0, 0]);
zeroNight.late_night = { messages: 0, share: 0, top: null };
zeroNight.personality = { id: 'early_birds', title: 'The Early Birds', blurb: 'Peak hour: 8 AM. Texting before coffee is a choice.', peak_hour: 8 };
zeroNight.senders.forEach((s) => { s.late_night = 0; });
zeroNight.awards = zeroNight.awards.slice(0, 5);
zeroNight.most_reacted = zeroNight.most_reacted.slice(0, 1);
zeroNight.most_reacted[0].kinds = {}; // tapback count without a breakdown

// The original prototype's output shape (docs/SCHEMA.md §1, "Legacy input").
const legacy = {
  chat_name: 'The Prototype Era',
  year: 2025,
  total_messages: 23117,
  total_words: 120400,
  messages_by_hour: Object.fromEntries(split(23117, HOUR_PROFILE).map((v, h) => [String(h), v])),
  messages_by_weekday: Object.fromEntries(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d, i) => [d, split(23117, WEEK_PROFILE)[i]])),
  messages_by_month: Object.fromEntries(split(23117, [8, 7, 9, 8, 9, 10, 13, 11, 9, 11, 9, 12]).map((v, m) => [String(m + 1), v])),
  top_senders: [{ name: 'Robin', count: 9020 }, { name: 'Sky', count: 7411 }, { name: 'Ash', count: 4302 }, { name: 'Quinn', count: 2384 }],
  most_reacted: [
    { sender: 'Sky', reactions: 9, date: '2025-05-02', text: 'who taught the dog to open the fridge' },
    { sender: 'Ash', reactions: 7, date: '2025-08-21', text: 'not me showing up a full day early' },
  ],
};

export const fixtures = {
  demo: clone(vector.stats),
  tiny, huge, nightHuge, astronomical, duo, dozen, longName, unbroken, emojiName, intl, rtl, masked, defaultRecap, quietNoKinds, bare, sparse, noQuotes, zeroNight, legacy,
};

export const viewports = {
  'se-320x568': { width: 320, height: 568, mobile: true },
  'phone-390x844': { width: 390, height: 844, mobile: true },
  'max-430x932': { width: 430, height: 932, mobile: true },
  'tablet-768x1024': { width: 768, height: 1024, mobile: false },
  'desktop-1440x900': { width: 1440, height: 900, mobile: false },
  'landscape-1024x600': { width: 1024, height: 600, mobile: false },
};
