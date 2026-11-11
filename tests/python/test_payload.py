"""Link payload (section 5): codec, the shared vector, the trim ladder."""

import base64
import copy
import json
import os
import unittest
import zlib

import support

from wrapped import payload as P

with open(os.path.join(support.ROOT, "tests", "vectors", "payload-v1.json"), encoding="utf-8") as f:
    VECTOR = json.load(f)


def big_stats(senders=12, quotes=3, quote_len=180, awards=6, name_len=40):
    """Invented stats that do not compress well, to push links over budget."""
    seed = [12345]

    def noise(n):
        out = []
        for _ in range(n):
            seed[0] = (seed[0] * 1103515245 + 12345) % (1 << 31)
            out.append(chr(0x4E00 + seed[0] % 20000))
        return "".join(out)

    stats = copy.deepcopy(VECTOR["stats"])
    stats["senders"] = [
        {"name": noise(name_len), "messages": 1000 - i, "share": 0.0833, "words": 9000 + i,
         "attachments": i, "late_night": i * 3, "reactions_given": i * 7, "reactions_received": i * 5}
        for i in range(senders)]
    stats["most_reacted"] = [
        {"sender": stats["senders"][i % senders]["name"], "reactions": 9 - i, "date": "2026-03-14",
         "text": noise(quote_len), "kinds": {"laugh": 9 - i}} for i in range(quotes)]
    stats["awards"] = [
        {"id": "a%d" % i, "emoji": "⭐", "title": "Title %d" % i,
         "winner": stats["senders"][i % senders]["name"], "detail": noise(30)} for i in range(awards)]
    return stats


def length_after(stats, steps, quotes=True):
    trimmed = copy.deepcopy(stats)
    if not quotes:
        P.strip_quotes(trimmed)
    for step in range(1, steps + 1):
        P.apply_trim_step(trimmed, step)
    return len(P.BASE_URL + "#w1=" + P.encode_payload(trimmed)), trimmed


class Codec(unittest.TestCase):
    def test_shared_vector_decodes_exactly(self):
        self.assertEqual(P.decode_payload(VECTOR["payload"]), VECTOR["stats"])
        self.assertEqual(P.stats_from_url(VECTOR["url"]), VECTOR["stats"])

    def test_round_trip(self):
        for stats in (VECTOR["stats"], {}, {"chat": {"name": "\U0001F32E \"quoted\" \\  "}},
                      big_stats()):
            encoded = P.encode_payload(stats)
            self.assertRegex(encoded, r"^[A-Za-z0-9_-]+$")
            self.assertEqual(P.decode_payload(encoded), stats)

    def test_payload_is_raw_deflate_of_compact_utf8_json(self):
        encoded = P.encode_payload(VECTOR["stats"])
        packed = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        raw = zlib.decompress(packed, -15)
        self.assertEqual(raw.decode("utf-8"), P.canonical_json(VECTOR["stats"]))
        self.assertIn('"name":"Dinner Club \U0001F35D"', raw.decode("utf-8"))
        self.assertNotIn(": ", P.canonical_json({"a": [1, 2], "b": {"c": None}}))

    def test_canonical_json_matches_javascript_number_formatting(self):
        self.assertEqual(P.canonical_json({"a": 0.0832, "b": 1, "c": 0, "d": 0.5, "e": None,
                                           "f": True, "g": "é\n\x01"}),
                         '{"a":0.0832,"b":1,"c":0,"d":0.5,"e":null,"f":true,"g":"é\\n\\u0001"}')

    def test_decoder_accepts_padding_and_rejects_rubbish(self):
        encoded = P.encode_payload({"v": 1})
        padded = encoded + "=" * (-len(encoded) % 4)
        self.assertEqual(P.decode_payload(padded), {"v": 1})
        self.assertEqual(P.decode_payload("  " + encoded + "\n"), {"v": 1})
        for bad in ("", "!!!", "AAAA", encoded[:-3] + "@@@", None, 5):
            with self.assertRaises(ValueError):
                P.decode_payload(bad)
        not_json = base64.urlsafe_b64encode(zlib.compress(b"hello", 9)[2:-4]).decode().rstrip("=")
        with self.assertRaises(ValueError):
            P.decode_payload(not_json)

    def test_decoder_refuses_decompression_bombs(self):
        deflater = zlib.compressobj(9, zlib.DEFLATED, -15)
        packed = deflater.compress(b"[" + b"0," * (6 * 1024 * 1024) + b"0]") + deflater.flush()
        bomb = base64.urlsafe_b64encode(packed).decode().rstrip("=")
        with self.assertRaises(ValueError):
            P.decode_payload(bomb)

    def test_url_forms(self):
        payload = VECTOR["payload"]
        self.assertEqual(P.payload_from_url(P.BASE_URL + "#w1=" + payload), payload)
        self.assertEqual(P.payload_from_url(P.BASE_URL + "?w1=" + payload), payload)
        self.assertEqual(P.payload_from_url(P.BASE_URL + "?embed=ios&x=1#a=b&w1=" + payload), payload)
        self.assertEqual(P.payload_from_url("file:///index.html?demo=1&w1=" + payload + "#top"), payload)
        self.assertIsNone(P.payload_from_url(P.BASE_URL + "?demo=1"))
        self.assertIsNone(P.payload_from_url(None))
        with self.assertRaises(ValueError):
            P.stats_from_url(P.BASE_URL)

    def test_constants(self):
        self.assertEqual(P.BASE_URL, "https://averyhsu.github.io/imessage-wrap/")
        self.assertEqual(P.MAX_URL_LENGTH, 4800)
        self.assertTrue(VECTOR["url"].startswith(P.BASE_URL + "#w1="))


class TrimLadder(unittest.TestCase):
    def test_step_1_deletes_award_details(self):
        stats = P.apply_trim_step(big_stats(), 1)
        self.assertEqual(len(stats["awards"]), 6)
        for award in stats["awards"]:
            self.assertEqual(sorted(award), ["emoji", "id", "title", "winner"])

    def test_step_2_truncates_quotes_to_60_characters(self):
        stats = big_stats()
        stats["most_reacted"][1]["text"] = "short"
        stats["most_reacted"][2]["text"] = "\U0001F602" * 61
        original = stats["most_reacted"][0]["text"]
        P.apply_trim_step(stats, 2)
        self.assertEqual(stats["most_reacted"][0]["text"], original[:60] + "…")
        self.assertEqual(stats["most_reacted"][1]["text"], "short")
        self.assertEqual(stats["most_reacted"][2]["text"], "\U0001F602" * 60 + "…")
        exactly = big_stats(quote_len=60)
        before = copy.deepcopy(exactly)
        self.assertEqual(P.apply_trim_step(exactly, 2), before)

    def test_steps_3_and_6_keep_the_first_senders(self):
        stats = big_stats()
        names = [s["name"] for s in stats["senders"]]
        P.apply_trim_step(stats, 3)
        self.assertEqual([s["name"] for s in stats["senders"]], names[:8])
        P.apply_trim_step(stats, 6)
        self.assertEqual([s["name"] for s in stats["senders"]], names[:5])

    def test_step_4_keeps_the_first_quote_and_step_5_deletes_awards(self):
        stats = big_stats()
        first = copy.deepcopy(stats["most_reacted"][0])
        P.apply_trim_step(stats, 4)
        self.assertEqual(stats["most_reacted"], [first])
        P.apply_trim_step(stats, 5)
        self.assertNotIn("awards", stats)

    def test_steps_tolerate_missing_sections(self):
        for step in range(1, 7):
            self.assertEqual(P.apply_trim_step({"v": 1}, step), {"v": 1})
            empty = {"awards": None, "senders": None, "most_reacted": None}
            expected = dict(empty)
            if step == 5:
                del expected["awards"]
            self.assertEqual(P.apply_trim_step(empty, step), expected)
        with self.assertRaises(ValueError):
            P.apply_trim_step({}, 7)

    def test_nothing_is_trimmed_when_the_link_fits(self):
        result = P.fit_link(VECTOR["stats"])
        self.assertEqual(result["steps"], 0)
        self.assertEqual(result["stats"], VECTOR["stats"])
        self.assertEqual(P.stats_from_url(result["url"]), VECTOR["stats"])
        self.assertEqual(result["length"], len(result["url"]))
        self.assertLessEqual(result["length"], 4800)
        self.assertEqual(P.build_link(VECTOR["stats"]), result["url"])

    def test_ladder_stops_at_the_first_step_that_fits(self):
        stats = big_stats()
        frozen = copy.deepcopy(stats)
        lengths = [length_after(stats, steps)[0] for steps in range(7)]
        self.assertEqual(lengths, sorted(lengths, reverse=True))
        self.assertGreater(lengths[0], lengths[6])
        for steps in range(7):
            if steps and lengths[steps] == lengths[steps - 1]:
                continue
            result = P.fit_link(stats, max_length=lengths[steps])
            self.assertEqual(result["steps"], steps)
            self.assertEqual(result["length"], lengths[steps])
            self.assertEqual(result["stats"], length_after(stats, steps)[1])
            self.assertEqual(P.stats_from_url(result["url"]), result["stats"])
            if steps:
                roomy = P.fit_link(stats, max_length=lengths[steps - 1] - 1)
                self.assertEqual(roomy["steps"], steps)
        self.assertEqual(stats, frozen)                      # the input is never modified

    def test_default_budget_is_4800_characters(self):
        stats = big_stats(name_len=150)
        self.assertGreater(length_after(stats, 0)[0], 4800)
        result = P.fit_link(stats)
        self.assertGreater(result["steps"], 0)
        self.assertLessEqual(len(result["url"]), 4800)
        self.assertGreater(length_after(stats, result["steps"] - 1)[0], 4800)

    def test_too_long_even_after_every_step(self):
        stats = big_stats()
        with self.assertRaises(P.LinkTooLongError) as caught:
            P.fit_link(stats, max_length=length_after(stats, 6)[0] - 1)
        self.assertIn("does not fit", str(caught.exception))
        huge = big_stats()
        huge["chat"]["name"] = "".join(chr(0x4E00 + (i * 7919) % 20000) for i in range(4000))
        with self.assertRaises(P.LinkTooLongError):
            P.build_link(huge)

    def test_no_quotes_blanks_text_before_encoding(self):
        stats = big_stats()
        result = P.fit_link(stats, quotes=False, max_length=100000)
        self.assertEqual([q["text"] for q in result["stats"]["most_reacted"]], ["", "", ""])
        self.assertEqual([q["reactions"] for q in result["stats"]["most_reacted"]], [9, 8, 7])
        self.assertEqual(result["steps"], 0)
        self.assertEqual(len(stats["most_reacted"][0]["text"]), 180)
        with_quotes = P.fit_link(stats, max_length=100000)
        self.assertLess(result["length"], with_quotes["length"])
        self.assertEqual(P.stats_from_url(P.build_link(stats, quotes=False, max_length=100000)),
                         result["stats"])
        # the ladder still applies afterwards
        budget = length_after(stats, 3, quotes=False)[0]
        trimmed = P.fit_link(stats, quotes=False, max_length=budget)
        self.assertEqual(trimmed["steps"], 3)
        self.assertEqual(len(trimmed["stats"]["senders"]), 8)

    def test_base_url_is_configurable(self):
        url = P.build_link(VECTOR["stats"], base_url="http://localhost:4173/")
        self.assertTrue(url.startswith("http://localhost:4173/#w1="))
        self.assertEqual(P.stats_from_url(url), VECTOR["stats"])


if __name__ == "__main__":
    unittest.main()
