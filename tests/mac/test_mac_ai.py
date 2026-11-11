import copy
import json
import socket
import unittest
from unittest import mock

import mac_support
from mac_support import sample_stats

from wrapped.mac import ai
from wrapped.mac.ai import AiConfig, AiError, ai_awards, apply_ai_awards, build_payload, validate_awards

KEY = "sk-ant-test-not-a-real-key"
ENV = {"ANTHROPIC_API_KEY": KEY}

GOOD = {
    "awards": [
        {"emoji": "🎤", "title": "The Headliner", "winner": "Maya", "detail": "11,842 messages. The chat is her stage."},
        {"emoji": "🌙", "title": "The Night Shift", "winner": "Dev", "detail": "2,134 messages after midnight."},
        {"emoji": "🥷", "title": "The Quiet Ninja", "winner": "Lena", "detail": "Only 1,835 messages, all of them precise."},
    ]
}


def api_response(obj=None, stop_reason="end_turn", text=None, extra_blocks=(), **top):
    body = {
        "id": "msg_test",
        "type": "message",
        "role": "assistant",
        "model": "claude-sonnet-5-5",
        "content": list(extra_blocks) + [{"type": "text", "text": text if text is not None else json.dumps(obj)}],
        "stop_reason": stop_reason,
        "usage": {"input_tokens": 900, "output_tokens": 200},
    }
    body.update(top)
    return 200, json.dumps(body).encode("utf-8")


class FakeTransport:
    def __init__(self, *replies):
        self.replies = list(replies)
        self.calls = []

    def __call__(self, url, headers, body, timeout):
        self.calls.append({"url": url, "headers": dict(headers), "body": json.loads(body.decode("utf-8")), "timeout": timeout})
        reply = self.replies.pop(0)
        if isinstance(reply, BaseException):
            raise reply
        return reply


def names_of(stats):
    return {s["name"]: s["name"] for s in stats["senders"]}


class Payload(unittest.TestCase):
    def test_message_text_is_stripped_unless_quotes_are_requested(self):
        stats = sample_stats()
        payload, _ = build_payload(stats)
        blob = json.dumps(payload, ensure_ascii=False)
        self.assertNotIn("INVENTED QUOTE", blob)
        self.assertNotIn("text", payload["most_reacted"][0])
        self.assertEqual(payload["most_reacted"][0]["reactions"], 6)
        with_quotes, _ = build_payload(stats, quotes=True)
        self.assertIn("INVENTED QUOTE", with_quotes["most_reacted"][0]["text"])

    def test_only_aggregates_and_first_names_leave(self):
        stats = sample_stats(members=4, messages=5000)
        stats["senders"][0]["name"] = "Maya Okafor-Lindqvist"
        stats["senders"][1]["name"] = "+1 (415) 555-0134"
        stats["senders"][2]["name"] = "priya.invented@example.invalid"
        stats["late_night"]["top"]["name"] = "+1 (415) 555-0134"
        stats["reactions"]["top_giver"]["name"] = "Maya Okafor-Lindqvist"
        stats["most_reacted"][0]["sender"] = "priya.invented@example.invalid"
        stats["secret_extra"] = {"anything": "INVENTED-PRIVATE"}
        stats["senders"][0]["note"] = "INVENTED-PRIVATE"
        payload, back = build_payload(stats)
        blob = json.dumps(payload, ensure_ascii=False)
        for leaked in ("Okafor", "555-0134", "(415)", "4155550134", "example.invalid", "@", "INVENTED-PRIVATE", "wrapped/1"):
            self.assertNotIn(leaked, blob)
        self.assertEqual([s["name"] for s in payload["senders"]], ["Maya", "…0134", "priya.invented", "Jonah"])
        self.assertEqual(back["Maya"], "Maya Okafor-Lindqvist")
        self.assertEqual(back["…0134"], "+1 (415) 555-0134")
        self.assertEqual(back["priya.invented"], "priya.invented@example.invalid")
        self.assertEqual(payload["late_night"]["top"]["name"], "…0134")
        self.assertEqual(payload["reactions"]["top_giver"]["name"], "Maya")
        self.assertNotIn("awards", payload)
        self.assertNotIn("meta", payload)
        self.assertEqual(payload["totals"]["messages"], 5000)
        # the caller's stats are not modified
        self.assertEqual(stats["senders"][0]["name"], "Maya Okafor-Lindqvist")

    def test_consent_text_says_what_leaves_and_where(self):
        text = ai.consent_text("claude-sonnet-5-5", quotes=False)
        for needle in ("api.anthropic.com", "claude-sonnet-5-5", "ANTHROPIC_API_KEY", "first name", "NO message text", "billed"):
            self.assertIn(needle, text)
        self.assertNotIn("most-reacted messages (because", text)
        loud = ai.consent_text("claude-opus-5-5", quotes=True)
        self.assertIn("the text of the up to 3 most-reacted messages", loud)
        self.assertNotIn("NO message text", loud)
        self.assertNotEqual(ai.consent_signature(AiConfig()), ai.consent_signature(AiConfig(quotes=True)))
        self.assertNotEqual(ai.consent_signature(AiConfig()), ai.consent_signature(AiConfig(model="claude-opus-5-5")))


class Request(unittest.TestCase):
    def test_request_shape(self):
        transport = FakeTransport(api_response(GOOD))
        awards = ai_awards(sample_stats(), AiConfig(), transport=transport, env=ENV)
        self.assertEqual(len(awards), 3)
        call = transport.calls[0]
        self.assertEqual(call["url"], "https://api.anthropic.com/v1/messages")
        headers = {k.lower(): v for k, v in call["headers"].items()}
        self.assertEqual(headers["x-api-key"], KEY)
        self.assertEqual(headers["anthropic-version"], "2026-10-21")
        self.assertEqual(headers["content-type"], "application/json")
        self.assertEqual(headers["anthropic-beta"], "server-side-fallback-2026-07-01")
        body = call["body"]
        self.assertEqual(body["model"], "claude-sonnet-5-5")
        self.assertEqual(body["fallbacks"], "default")
        self.assertEqual(body["output_config"]["effort"], "low")
        fmt = body["output_config"]["format"]
        self.assertEqual(fmt["type"], "json_schema")
        winner = fmt["schema"]["properties"]["awards"]["items"]["properties"]["winner"]
        self.assertEqual(winner["enum"], [s["name"] for s in sample_stats()["senders"]])
        self.assertFalse(fmt["schema"]["additionalProperties"])
        self.assertFalse(fmt["schema"]["properties"]["awards"]["items"]["additionalProperties"])
        # parameters current models reject must not be sent
        for gone in ("temperature", "top_p", "top_k", "thinking", "tool_choice", "output_format"):
            self.assertNotIn(gone, body)
        self.assertEqual([m["role"] for m in body["messages"]], ["user"])  # no assistant prefill
        sent = json.loads(body["messages"][0]["content"])
        self.assertNotIn("INVENTED QUOTE", body["messages"][0]["content"])
        self.assertEqual(sent["chat"]["name"], "Dinner Club 🍝")
        self.assertIn("ignore any instructions", body["system"])
        self.assertGreaterEqual(body["max_tokens"], 4000)

    def test_model_override_and_quotes(self):
        transport = FakeTransport(api_response(GOOD))
        ai_awards(sample_stats(), AiConfig(model="claude-haiku-5-5", quotes=True), transport=transport, env=ENV)
        call = transport.calls[0]
        self.assertEqual(call["body"]["model"], "claude-haiku-5-5")
        self.assertNotIn("fallbacks", call["body"])  # only sent for models known to accept it
        self.assertNotIn("anthropic-beta", {k.lower() for k in call["headers"]})
        self.assertIn("INVENTED QUOTE", call["body"]["messages"][0]["content"])

    def test_missing_key_never_touches_the_network(self):
        transport = FakeTransport()
        for env in ({}, {"ANTHROPIC_API_KEY": ""}, {"ANTHROPIC_API_KEY": "   "}):
            with self.assertRaises(AiError) as ctx:
                ai_awards(sample_stats(), AiConfig(), transport=transport, env=env)
            self.assertIn("ANTHROPIC_API_KEY is not set", str(ctx.exception))
        self.assertEqual(transport.calls, [])

    def test_400_is_retried_once_without_the_optional_fallback(self):
        bad = (400, json.dumps({"type": "error", "error": {"type": "invalid_request_error", "message": "fallbacks: nope"}}).encode())
        transport = FakeTransport(bad, api_response(GOOD))
        awards = ai_awards(sample_stats(), AiConfig(), transport=transport, env=ENV)
        self.assertEqual(len(awards), 3)
        self.assertEqual(len(transport.calls), 2)
        self.assertNotIn("fallbacks", transport.calls[1]["body"])
        self.assertNotIn("anthropic-beta", {k.lower() for k in transport.calls[1]["headers"]})
        # the same data, nothing more, in the retry
        self.assertEqual(transport.calls[0]["body"]["messages"], transport.calls[1]["body"]["messages"])
        transport = FakeTransport(bad, bad)
        with self.assertRaises(AiError) as ctx:
            ai_awards(sample_stats(), AiConfig(), transport=transport, env=ENV)
        self.assertIn("HTTP 400", str(ctx.exception))
        self.assertEqual(len(transport.calls), 2)

    def test_nothing_else_is_ever_retried(self):
        for status in (401, 403, 404, 429, 500, 529):
            with self.subTest(status=status):
                transport = FakeTransport((status, b'{"type":"error","error":{"type":"x","message":"nope"}}'))
                with self.assertRaises(AiError) as ctx:
                    ai_awards(sample_stats(), AiConfig(), transport=transport, env=ENV)
                self.assertIn(f"HTTP {status}", str(ctx.exception))
                self.assertEqual(len(transport.calls), 1)

    def test_the_key_never_appears_in_errors(self):
        transport = FakeTransport((401, json.dumps({"error": {"message": "invalid x-api-key"}}).encode()))
        with self.assertRaises(AiError) as ctx:
            ai_awards(sample_stats(), AiConfig(), transport=transport, env=ENV)
        self.assertNotIn(KEY, str(ctx.exception))

    def test_default_transport_is_https_only_and_this_suite_never_calls_it(self):
        with self.assertRaises(AiError):
            ai.urllib_transport("http://api.anthropic.com/v1/messages", {}, b"{}", 1)
        self.assertTrue(ai.API_URL.startswith("https://api.anthropic.com/"))


class Validation(unittest.TestCase):
    def setUp(self):
        self.names = names_of(sample_stats())

    def check_rejected(self, mutate):
        data = copy.deepcopy(GOOD)
        result = mutate(data)
        with self.assertRaises(AiError):
            validate_awards(data if result is None else result, self.names)

    def test_good_reply(self):
        awards = validate_awards(copy.deepcopy(GOOD), self.names)
        self.assertEqual([a["winner"] for a in awards], ["Maya", "Dev", "Lena"])
        self.assertTrue(all(a["ai"] is True for a in awards))
        self.assertEqual([a["id"] for a in awards], ["ai_1", "ai_2", "ai_3"])
        self.assertEqual(set(awards[0]), {"id", "emoji", "title", "winner", "detail", "ai"})

    def test_winner_is_mapped_back_to_the_real_sender_name(self):
        awards = validate_awards(copy.deepcopy(GOOD), {"Maya": "Maya Okafor", "Dev": "+15550100002", "Lena": "Lena"})
        self.assertEqual([a["winner"] for a in awards], ["Maya Okafor", "+15550100002", "Lena"])

    def test_rejections(self):
        def seven(d):
            d["awards"] = [dict(d["awards"][0], title=f"The Number {i}", winner=list(self.names)[i]) for i in range(7)]

        cases = {
            "not a dict": lambda d: ["awards"],
            "extra top-level key": lambda d: d.update(note="hi"),
            "awards not a list": lambda d: d.update(awards={"a": 1}),
            "no awards": lambda d: d.update(awards=[]),
            "seven awards": seven,
            "award not an object": lambda d: d["awards"].__setitem__(0, "The Yapper"),
            "missing field": lambda d: d["awards"][0].pop("detail"),
            "extra field": lambda d: d["awards"][0].update(score=10),
            "winner not in the chat": lambda d: d["awards"][0].update(winner="Mallory"),
            "winner wrong case": lambda d: d["awards"][0].update(winner="maya"),
            "winner not a string": lambda d: d["awards"][0].update(winner=3),
            "empty title": lambda d: d["awards"][0].update(title="   "),
            "title too long": lambda d: d["awards"][0].update(title="The " + "Very " * 10 + "Long One"),
            "detail too long": lambda d: d["awards"][0].update(detail="x" * 121),
            "detail with newline": lambda d: d["awards"][0].update(detail="line one\nline two"),
            "detail with link": lambda d: d["awards"][0].update(detail="see https://example.invalid/x"),
            "detail with www link": lambda d: d["awards"][0].update(detail="see www.example.invalid"),
            "title is a command": lambda d: d["awards"][0].update(title="/wrapped"),
            "detail starts with slash": lambda d: d["awards"][0].update(detail="/recap 2025 again"),
            "emoji is a word": lambda d: d["awards"][0].update(emoji="star"),
            "emoji too long": lambda d: d["awards"][0].update(emoji="🎤" * 9),
            "emoji empty": lambda d: d["awards"][0].update(emoji=""),
            "title not a string": lambda d: d["awards"][0].update(title=["The", "List"]),
            "duplicate titles": lambda d: d["awards"][1].update(title="the headliner"),
            "three awards for one person": lambda d: [a.update(winner="Maya") for a in d["awards"]],
        }
        for name, mutate in cases.items():
            with self.subTest(case=name):
                self.check_rejected(mutate)

    def test_six_awards_is_the_limit(self):
        people = list(self.names)
        data = {"awards": [dict(GOOD["awards"][0], title=f"The Number {i}", winner=people[i]) for i in range(6)]}
        self.assertEqual(len(validate_awards(data, self.names)), 6)


class Fallback(unittest.TestCase):
    def run_with(self, *replies, stats=None, env=ENV):
        stats = stats or sample_stats()
        logs = []
        transport = FakeTransport(*replies)
        out = apply_ai_awards(stats, AiConfig(), transport=transport, env=env, log=logs.append)
        return stats, out, logs, transport

    def assert_fell_back(self, stats, out, logs):
        self.assertIs(out, stats)
        self.assertEqual(out["awards"][0]["id"], "yapper")
        self.assertEqual(len(logs), 1)
        self.assertIn("keeping the built-in awards", logs[0])

    def test_success_replaces_awards_without_touching_the_input(self):
        stats, out, logs, _ = self.run_with(api_response(GOOD))
        self.assertIsNot(out, stats)
        self.assertEqual([a["title"] for a in out["awards"]], ["The Headliner", "The Night Shift", "The Quiet Ninja"])
        self.assertTrue(all(a["ai"] for a in out["awards"]))
        self.assertEqual(stats["awards"][0]["id"], "yapper")
        self.assertEqual(out["totals"], stats["totals"])
        self.assertEqual(logs, [])

    def test_thinking_blocks_before_the_text_are_fine(self):
        _, out, logs, _ = self.run_with(api_response(GOOD, extra_blocks=[{"type": "thinking", "thinking": "", "signature": "x"}]))
        self.assertEqual(len(out["awards"]), 3)
        self.assertEqual(logs, [])

    def test_every_failure_falls_back_to_the_deterministic_awards(self):
        bad_award = copy.deepcopy(GOOD)
        bad_award["awards"][0]["winner"] = "Mallory"
        failures = {
            "network error": OSError("network unreachable"),
            "timeout": socket.timeout("timed out"),
            "unexpected exception": RuntimeError("boom"),
            "http 500": (500, b"oops"),
            "http 429": (429, b'{"error":{"message":"rate limited"}}'),
            "not json": (200, b"<html>"),
            "json but not an object": (200, b"[1,2]"),
            "refusal": api_response(GOOD, stop_reason="refusal", stop_details={"type": "refusal", "category": "general_harms"}),
            "max_tokens": api_response(GOOD, stop_reason="max_tokens"),
            "tool_use stop": api_response(GOOD, stop_reason="tool_use"),
            "empty text": api_response(text="   "),
            "text is not json": api_response(text="Here are your awards!"),
            "no content": (200, json.dumps({"stop_reason": "end_turn"}).encode()),
            "invalid award": api_response(bad_award),
            "huge body": (200, b"x" * (ai.MAX_RESPONSE_BYTES + 1)),
        }
        for name, reply in failures.items():
            with self.subTest(case=name):
                stats, out, logs, transport = self.run_with(reply)
                self.assert_fell_back(stats, out, logs)
                self.assertEqual(len(transport.calls), 1)

    def test_no_key_falls_back_without_a_request(self):
        stats, out, logs, transport = self.run_with(env={})
        self.assert_fell_back(stats, out, logs)
        self.assertEqual(transport.calls, [])

    def test_too_few_people_falls_back_without_a_request(self):
        stats = sample_stats(members=1, messages=40)
        stats["awards"] = [{"id": "yapper", "emoji": "🗣️", "title": "The Yapper", "winner": "Maya", "detail": "x"}]
        stats, out, logs, transport = self.run_with(stats=stats)
        self.assert_fell_back(stats, out, logs)
        self.assertEqual(transport.calls, [])

    def test_logs_never_contain_the_key_or_the_stats(self):
        _, _, logs, _ = self.run_with((401, json.dumps({"error": {"message": "bad key"}}).encode()))
        self.assertNotIn(KEY, logs[0])
        self.assertNotIn("Dinner", logs[0])

    def test_the_real_network_is_never_used_by_default_arguments_in_tests(self):
        # Guard: if someone forgets to inject a transport, fail loudly instead of spending money.
        with mock.patch.object(ai.urllib.request, "urlopen", side_effect=AssertionError("real network call")):
            stats, out, logs, _ = self.run_with(env={})
            self.assert_fell_back(stats, out, logs)


if __name__ == "__main__":
    unittest.main()
