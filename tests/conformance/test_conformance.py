"""The Python engine and the JavaScript engine must agree exactly.

One job (databases, chats, periods, time zones, awkward strings, random rows,
payloads) is run through both engines. Stats are compared as canonical JSON
*text*, so key order and number formatting count as well.

Needs Node 18+ on PATH (or $NODE); the suite is skipped without it.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "tests", "python"))

import support  # noqa: E402
from support import build_fixture  # noqa: E402

import wrapped  # noqa: E402
from wrapped import db, payload, stats as S, typedstream  # noqa: E402

NODE = os.environ.get("NODE") or shutil.which("node")
ZONES = ["America/Los_Angeles", "Asia/Kolkata", "UTC", "Australia/Lord_Howe"]
PERIODS = [{"year": 2026}, {"year": 2025}, {"all_time": True},
           {"start": "2026-02-10", "end": "2026-03-10"}]
LOCAL_ZONE = "America/Los_Angeles"

with open(os.path.join(HERE, "expected_tiny.json"), encoding="utf-8") as handle:
    EXPECTED = json.load(handle)


class Rng(build_fixture.Rng):
    pass


def random_rows(rng, n):
    """Messy but valid rows: every rule gets exercised somewhere."""
    handles = ["+15550100001", "+1 (555) 010-0001", "a@example.com", "A@Example.com",
               "+15550100002", "+15550100003", None, "urn:biz:42", "22000"]
    alphabet = ["a", "bb", "ccc", " ", "  ", "\t", "\n", "\xa0", "\u3000", "\ufeff", "\x1f", "\x85",
                "\u2028", "\ufffc", "\ufffd", "\U0001F602", "\xe9", "\u200b", "0", "\u202f", "\x00"]
    base = 1750000000 + rng.below(40000000)
    rows = []
    guids = []
    for i in range(n):
        t = base + rng.below(60 * 86400)
        unit = rng.below(10)
        if unit < 7:
            date = str((t - 978307200) * 10 ** 9 + rng.below(10 ** 9))
        elif unit < 9:
            date = t - 978307200
        else:
            date = rng.pick([None, 0, "", "junk", -5, "0"])
        row = {"rowid": rng.below(n * 2) + 1, "guid": "G%d" % i, "date": date,
               "is_from_me": 1 if rng.chance(20) else 0, "handle": rng.pick(handles)}
        roll = rng.below(100)
        if roll < 30 and guids:
            kind = rng.pick([2000, 2001, 2002, 2003, 2004, 2005, 2006, 2007,
                             3000, 3001, 3003, 3006, 1000, 4000, 2, 3])
            prefix = rng.pick(["p:0/", "p:1/", "bp:", "", "p:0/"])
            row["associated_message_type"] = kind
            row["associated_message_guid"] = prefix + rng.pick(guids + ["MISSING"])
            row["text"] = "Reacted"
        else:
            text = "".join(rng.pick(alphabet) for _ in range(rng.below(25)))
            shape = rng.below(10)
            if shape < 5:
                row["text"] = text
            elif shape < 8:
                row["text"] = rng.pick([None, ""])
                row["attributedBody"] = build_fixture.archive_attributed_string(
                    text + "x" * rng.pick([0, 0, 130, 300]), mutable=rng.chance(40)).hex()
            else:
                row["text"] = None
            row["cache_has_attachments"] = rng.pick([0, 0, 0, 1, None])
            row["item_type"] = rng.pick([0, 0, 0, 0, None, 1, 2, 3])
            row["associated_message_type"] = rng.pick([0, 0, None, 0])
            if rng.chance(3):
                row["keep_empty"] = 1
            guids.append(row["guid"])
        rows.append(row)
    return rows


def build_job(fixture_dir, info):
    paths = info["paths"]
    mac_books = paths["address_books"]
    backup_sms = paths["backup_sms"]
    backup_book = paths["backup_address_book"]
    wal_root = paths["backup_wal"]
    sources = [
        {"id": "mac", "kind": "chat.db", "db": paths["chat_db"], "wal": paths["chat_db_wal"],
         "contacts": mac_books},
        {"id": "backup", "kind": "sms.db", "db": backup_sms, "contacts": [backup_book]},
        {"id": "backup_wal", "kind": "sms.db",
         "db": "%s/%s/%s" % (wal_root, db.SMS_DB_ID[:2], db.SMS_DB_ID),
         "wal": "%s/%s/%s" % (wal_root, db.SMS_WAL_ID[:2], db.SMS_WAL_ID),
         "contacts": ["%s/%s/%s" % (wal_root, db.ADDRESS_BOOK_ID[:2], db.ADDRESS_BOOK_ID)]},
        {"id": "noemoji", "kind": "chat.db", "db": paths["noemoji_db"], "contacts": mac_books},
        {"id": "legacy", "kind": "chat.db", "db": paths["legacy_db"], "contacts": []},
    ]
    now = info["now"]
    group_keys = ["lively", "tiny", "unnamed", "stress"]
    cases = []
    for key in group_keys:
        chat = info["chats"][key]["rowid"]
        for zone in ZONES:
            for period in PERIODS:
                for contacts in (True, False):
                    if not contacts and (zone != ZONES[0] or "start" in period):
                        continue
                    options = dict(period, tz=zone, now=now)
                    cases.append({"id": "mac/%s/%s/%s/%s" % (key, zone, json.dumps(period, sort_keys=True),
                                                             contacts),
                                  "source": "mac", "chat": chat, "contacts": contacts,
                                  "options": options})
        for source in ("backup", "backup_wal"):
            for zone in ("Asia/Kolkata", "UTC"):
                cases.append({"id": "%s/%s/%s" % (source, key, zone), "source": source, "chat": chat,
                              "contacts": True, "options": {"year": 2026, "tz": zone, "now": now}})
        cases.append({"id": "me/%s" % key, "source": "mac", "chat": chat, "contacts": True,
                      "options": {"all_time": True, "tz": "Pacific/Apia", "now": now,
                                  "me": "Zo\xeb M\xfcller", "label": "Everything \u2728"}})
    tiny = info["chats"]["tiny"]["rowid"]
    for case in EXPECTED["cases"]:
        cases.append({"id": "expected/" + case["name"], "source": "mac", "chat": tiny,
                      "contacts": case["contacts"], "options": dict(case["options"], now=EXPECTED["now"])})
    cases.append({"id": "noemoji/tiny", "source": "noemoji", "chat": tiny, "contacts": True,
                  "options": {"year": 2026, "tz": ZONES[0], "now": now}})
    cases.append({"id": "legacy", "source": "legacy", "chat": 1, "contacts": False,
                  "options": {"year": 2016, "tz": "Europe/London", "now": now}})
    cases.append({"id": "later-now", "source": "mac", "chat": tiny, "contacts": True,
                  "options": {"tz": "UTC", "now": now + 400 * 86400, "year": 2026}})

    rng = Rng(7)
    samples = [s["hex"] for s in info["typedstream_samples"]]
    decode = list(samples)
    for sample in samples[:12]:
        raw = bytes.fromhex(sample)
        for _ in range(6):
            cut = rng.below(len(raw) + 1)
            decode.append(raw[:cut].hex())
            if cut < len(raw):
                broken = bytearray(raw)
                broken[cut] = rng.below(256)
                decode.append(bytes(broken).hex())
    prefix = typedstream._FAST_PREFIXES[0]
    for bad in (b"\xff\xfe", b"\xed\xa0\x80", b"\xf0\x9f\x98", b"a\xc3", b"\xef\xbb\xbfbom",
                b"\xc0\xaf", b"\xf4\x90\x80\x80", b"ok \xe2\x82\xac", b"\x00nul", b"\xe2\x28\xa1"):
        decode.append((prefix + bytes([len(bad)]) + bad + b"\x86").hex())
    decode += ["", "00", "040b73747265616d7479706564"]

    texts = list(build_fixture.EDGE_TEXTS) + [
        "", " ", "\ufffc", "\ufffc\ufffc hi", "a\ufffdb", "\ufeff\ufeff", "x" * 9 + "\U0001F602" * 3,
        "\U0001F602" * 10, "\U0001F602" * 11, "0123456789", "0123456789a", "a\x0bb\x0cc",
        "tab\there", "  lead", "trail  ", "\u2003x\u2003", build_fixture.M11_TEXT,
    ]
    identifiers = ["+1 (555) 010-0001", "5550100001", "0015550100001", "22000", "Ines@Example.COM",
                   " spaced@example.com ", "\xc9cole@example.com", "\u0130@x.y", "Pizza Planet", "",
                   "urn:biz:42", "\u202a+1\xa0555\u2011010\u20110001\u202c", "+44 20 7946 0000",
                   "\u0661\u0662\u0663", "ext. 5", "a@b@c"]
    contacts = [["+15550100001", "Ines Calloway"], ["+15550100002", "Bram Okoye"],
                ["sam@example.com", " Sam  Rivera "], ["+15550100004", "\U0001F525 Jake"],
                ["5550100001", "Aaa First"], ["+15550100009", "Me"]]
    names = [
        ["Dinner", ["+15550100001"], contacts, "Me"],
        ["", ["+15550100001", "+15550100002", "SAM@example.com", "+15550100004", "x@example.com"],
         contacts, "Me"],
        [None, ["+15550100004", "+15550100009", "+15550100002"], contacts, "Me"],
        ["   ", [], None, "Me"],
        ["", ["+15550100007", "+15550100008"], None, "Avery"],
        ["", ["+15550100002", "+15550100002", "(555) 010-0002"], contacts, None],
    ]
    round4 = [[n, t] for t in (1, 3, 7, 8, 16, 21, 32, 64, 127, 4096, 20000, 20001, 48213, 99999)
              for n in sorted({0, 1, 2, t // 3, t // 2, t - 1, t})] + [[0, 0], [5, 0]]
    dates = [0, 1, 5, 99999, 100000000000, 100000000001, "100000000000", "100000000001",
             "804914400100000001", "804914400999999999", 804914400, "804914400", None, "", "x", -3,
             "-3", "0", "000", "00012", " 12 ", "+12", "9999999999999999999", 4102444800,
             "3124137600000000000", "3124137600000000001", 1.5, 0.5]
    rows_cases = []
    for i in range(24):
        options = {"tz": rng.pick(ZONES + ["Europe/London", "Asia/Kathmandu"]), "now": 1795000000,
                   "contacts": contacts if rng.chance(60) else None,
                   "participants": ["+15550100002", "ghost@example.com"] if rng.chance(50) else None,
                   "chat_name": rng.pick(["", "Fuzz", None])}
        options.update(rng.pick([{"all_time": True}, {"year": 2025}, {"year": 2026}, {},
                                 {"start": "2025-08-01"}, {"end": "2025-12-31"}]))
        rows_cases.append({"rows": random_rows(rng, 40 + rng.below(260)), "options": options})
    # no tz option: both engines must use the process's local zone
    rows_cases.append({"rows": random_rows(rng, 200), "options": {"now": 1795000000, "all_time": True}})

    objects = [EXPECTED["cases"][0]["stats"],
               {"a": [1, 0.5, 0.0001, 1.0, 0, None, True, "\u2028\n\x01", -0.0, 2.5e-5,
                      1e-7, 1.5e21, 123456789012, 0.1 + 0.2, -3.75, 1e21, 5e-324, 1e-6, 123456.789e3]},
               {"emoji": "\U0001F32E", "nested": {"deep": ["\xe9", {"k": 0.3333}]},
                "10": 1, "9": 2, "b": 3, "1": 4, "01": 5, "-1": 6, "4294967295": 7, "4294967294": 8}]
    job = {
        "fixture": fixture_dir, "sources": sources, "stats": cases, "decode": decode, "texts": texts,
        "identifiers": identifiers, "names": names, "round4": round4, "dates": dates,
        "zones": {"names": ZONES + ["Europe/London", "Asia/Kathmandu", "America/Sao_Paulo",
                                    "Pacific/Apia", "Africa/Casablanca"],
                  "lo": 1262304000, "hi": 1793491200},          # 2010-01-01 .. 2026-11-01
        "rows": rows_cases,
        "payload": {"objects": objects, "encoded": [payload.encode_payload(o) for o in objects]},
        "links": [],
        "vendored_fflate": True,
    }
    return job


@unittest.skipUnless(NODE, "Node.js is not installed")
class Conformance(unittest.TestCase):
    maxDiff = 2000

    @classmethod
    def setUpClass(cls):
        cls.fixture_dir, cls.info = support.fixture()
        cls.job = build_job(cls.fixture_dir, cls.info)
        cls.py_stats = cls.python_stats()
        # link ladder cases need the stats first: every budget sits between the
        # lengths of two neighbouring steps, so the engines cannot disagree by
        # a few bytes of compressor output
        stress = [c["id"] for c in cls.job["stats"]
                  if c["id"].startswith("mac/stress/") and "all_time" in c["id"]][:2]
        tiny = "expected/los_angeles_2026"
        cls.job["links"] = [{"stats": sid, "budgets": []} for sid in stress + [tiny]]
        first = cls.run_node(cls.job)
        for item in cls.job["links"]:
            mine = cls.ladder_lengths(json.loads(cls.py_stats[item["stats"]]))
            theirs = [first["links"][item["stats"]]["lengths"],
                      first["links"][item["stats"]]["lengths_no_quotes"]]
            for quotes, a, b in ((True, mine[0], theirs[0]), (False, mine[1], theirs[1])):
                item["budgets"].append({"quotes": quotes, "max_length": 4800})
                item["budgets"].append({"quotes": quotes, "max_length": 100000})
                for step in range(7):
                    high = min(a[step - 1], b[step - 1]) - 1 if step else max(a[0], b[0]) + 50
                    low = max(a[step], b[step])
                    if low <= high:
                        item["budgets"].append({"quotes": quotes, "max_length": (low + high) // 2,
                                                "expect_steps": step})
                item["budgets"].append({"quotes": quotes, "max_length": min(a[6], b[6]) - 1,
                                        "expect_error": True})
        cls.js = cls.run_node(cls.job)

    @classmethod
    def run_node(cls, job):
        folder = tempfile.mkdtemp(prefix="wrapped-job-")
        try:
            job_path = os.path.join(folder, "job.json")
            with open(job_path, "w", encoding="utf-8") as handle:
                json.dump(job, handle)
            env = dict(os.environ, TZ=LOCAL_ZONE)
            proc = subprocess.run([NODE, os.path.join(HERE, "js_runner.js"), job_path],
                                  capture_output=True, env=env)
            if proc.returncode != 0:
                raise AssertionError("js_runner failed:\n" + proc.stderr.decode("utf-8", "replace"))
            return json.loads(proc.stdout.decode("utf-8"))
        finally:
            shutil.rmtree(folder, ignore_errors=True)

    @classmethod
    def open_sources(cls):
        opened = {}
        for spec in cls.job["sources"]:
            full = lambda rel: os.path.join(cls.fixture_dir, *rel.split("/"))
            con = db.open_database(full(spec["db"]), wal=full(spec["wal"]) if spec["id"] == "backup_wal"
                                   else None)
            contacts = []
            for book in spec["contacts"]:
                contacts += db.load_contacts(full(book))
            opened[spec["id"]] = (wrapped.Source(con, spec["kind"], spec["db"], contacts),
                                  wrapped.Source(con, spec["kind"], spec["db"], []))
        return opened

    @classmethod
    def python_stats(cls):
        cls.sources = cls.open_sources()
        out = {}
        for case in cls.job["stats"]:
            source = cls.sources[case["source"]][0 if case["contacts"] else 1]
            out[case["id"]] = payload.canonical_json(source.stats(case["chat"], **case["options"]))
        return out

    @classmethod
    def tearDownClass(cls):
        for with_contacts, _without in getattr(cls, "sources", {}).values():
            with_contacts.close()

    @staticmethod
    def ladder_lengths(stats):
        out = []
        for quotes in (True, False):
            copy = json.loads(json.dumps(stats))
            if not quotes:
                payload.strip_quotes(copy)
            lengths = [len(payload.BASE_URL + "#w1=" + payload.encode_payload(copy))]
            for step in range(1, 7):
                payload.apply_trim_step(copy, step)
                lengths.append(len(payload.BASE_URL + "#w1=" + payload.encode_payload(copy)))
            out.append(lengths)
        return out

    # ---- databases ----------------------------------------------------------

    def test_stats_are_byte_identical(self):
        self.assertGreaterEqual(len(self.job["stats"]), 100)
        self.assertEqual(set(self.js["stats"]), set(self.py_stats))
        different = [cid for cid in self.py_stats if self.py_stats[cid] != self.js["stats"][cid]]
        for cid in different[:3]:
            self.assertEqual(json.loads(self.js["stats"][cid]), json.loads(self.py_stats[cid]), cid)
            self.assertEqual(self.js["stats"][cid], self.py_stats[cid], cid)
        self.assertEqual(different, [])

    def test_the_cases_are_not_trivial(self):
        totals = {cid: json.loads(text)["totals"] for cid, text in self.py_stats.items()}
        self.assertGreater(sum(1 for t in totals.values() if t["messages"] > 300), 40)
        self.assertGreater(sum(1 for t in totals.values() if t["reactions"] > 50), 40)
        distinct = {json.dumps(t, sort_keys=True) for t in totals.values()}
        self.assertGreater(len(distinct), 40)
        zone_views = {self.py_stats["mac/lively/%s/%s/True" % (z, json.dumps({"year": 2026}))]
                      for z in ZONES}
        self.assertEqual(len(zone_views), len(ZONES))       # the zone really changes the answer

    def test_both_engines_match_the_hand_computed_numbers(self):
        for case in EXPECTED["cases"]:
            for engine, results in (("python", self.py_stats), ("javascript", self.js["stats"])):
                got = json.loads(results["expected/" + case["name"]])
                if "stats" in case:
                    self.assertEqual(got, case["stats"], (engine, case["name"]))
                    self.assertEqual(results["expected/" + case["name"]],
                                     payload.canonical_json(case["stats"]), (engine, case["name"]))
                else:
                    self.assertEqual(support.subset_mismatches(case["partial"], got), [],
                                     (engine, case["name"]))

    def test_mac_backup_and_wal_copies_agree(self):
        for key in ("lively", "tiny", "unnamed", "stress"):
            a = json.loads(self.js["stats"]["backup/%s/UTC" % key])
            b = json.loads(self.js["stats"]["backup_wal/%s/UTC" % key])
            c = json.loads(self.js["stats"]["mac/%s/UTC/%s/True" % (key, json.dumps({"year": 2026}))])
            self.assertEqual(a, b, key)
            self.assertEqual(c["meta"].pop("source"), "chat.db")
            self.assertEqual(a["meta"].pop("source"), "sms.db")
            self.assertEqual(a, c, key)

    def test_chat_lists_diagnostics_and_contacts(self):
        for source_id, (with_contacts, without) in self.sources.items():
            self.assertEqual(self.js["chats"][source_id + "+contacts"],
                             json.loads(json.dumps(with_contacts.chats())), source_id)
            self.assertEqual(self.js["chats"][source_id], json.loads(json.dumps(without.chats())),
                             source_id)
            mine = with_contacts.diagnostics()
            theirs = self.js["diagnostics"][source_id]
            for key in ("messages", "chats", "group_chats", "first_unix", "last_unix"):
                self.assertEqual(theirs[key], mine[key], (source_id, key))
            self.assertEqual(self.js["contacts"][source_id],
                             [list(pair) for pair in with_contacts.contacts], source_id)
        self.assertTrue(self.js["diagnostics"]["mac"]["wal_merged"])
        self.assertEqual(self.js["diagnostics"]["mac"]["messages"],
                         self.js["diagnostics"]["backup"]["messages"])

    # ---- pure functions -------------------------------------------------------

    def test_attributed_body_decoding(self):
        self.assertGreater(len(self.job["decode"]), 150)
        for blob, theirs in zip(self.job["decode"], self.js["decode"]):
            mine = typedstream.decode_with_strategy(bytes.fromhex(blob))
            self.assertEqual(theirs, list(mine), blob[:80])
        used = {how for _text, how in self.js["decode"]}
        self.assertEqual(used, {"fast", "structural", "scan", "none"})

    def test_text_rules(self):
        for text, theirs in zip(self.job["texts"], self.js["texts"]):
            cleaned = S.clean_text(text)
            self.assertEqual(theirs, [cleaned, S.count_words(cleaned), S._truncate(text, 10)], repr(text))

    def test_contact_keys_and_chat_names(self):
        self.assertEqual(self.js["identifiers"], [S.contact_key(i) for i in self.job["identifiers"]])
        mine = [S.chat_display_name(n[0], n[1], n[2], n[3] or "Me") for n in self.job["names"]]
        self.assertEqual(self.js["names"], mine)
        # two cards claim +1 555 010 0001: the name that sorts first wins
        self.assertEqual(mine[1], "Aaa, Bram, Sam & 2 more")

    def test_rounding_and_dates(self):
        self.assertEqual(self.js["round4"], [S._round4(n, t) for n, t in self.job["round4"]])
        mine = [S._split_date(d) for d in self.job["dates"]]
        self.assertEqual(self.js["dates"], [list(m) if m else None for m in mine])

    def test_time_zone_tables(self):
        spec = self.job["zones"]
        for zone in spec["names"]:
            table = S._Offsets(S._offset_function(zone), spec["lo"], spec["hi"])
            self.assertEqual(self.js["zones"][zone], [table.starts, table.offsets], zone)
        self.assertGreater(len(self.js["zones"]["America/Los_Angeles"][0]), 30)
        self.assertEqual(len(self.js["zones"]["UTC"][0]), 1)

    def test_random_rows(self):
        results = []
        previous = os.environ.get("TZ")
        for case in self.job["rows"]:
            rows = [dict(r, attributedBody=bytes.fromhex(r["attributedBody"]))
                    if r.get("attributedBody") else r for r in case["rows"]]
            if "tz" not in case["options"]:
                if not hasattr(time, "tzset"):
                    results.append(None)
                    continue
                os.environ["TZ"] = LOCAL_ZONE
                time.tzset()
            try:
                results.append(payload.canonical_json(S.compute_stats(rows, case["options"])))
            finally:
                if "tz" not in case["options"]:
                    if previous is None:
                        os.environ.pop("TZ", None)
                    else:
                        os.environ["TZ"] = previous
                    time.tzset()
        for index, (mine, theirs) in enumerate(zip(results, self.js["rows"])):
            if mine is not None:
                self.assertEqual(json.loads(theirs), json.loads(mine), index)
                self.assertEqual(theirs, mine, index)
        counted = [json.loads(r)["totals"]["messages"] for r in self.js["rows"]]
        self.assertGreater(sum(1 for c in counted if c > 20), 12)
        self.assertGreater(sum(json.loads(r)["totals"]["reactions"] for r in self.js["rows"]), 100)

    # ---- payload ---------------------------------------------------------------

    def test_payloads_cross_decode(self):
        objects = self.job["payload"]["objects"]
        canonical = [payload.canonical_json(o) for o in objects]
        self.assertEqual(self.js["payload"]["canonical"], canonical)
        self.assertEqual(self.js["payload"]["decoded"], canonical)
        self.assertEqual(self.js["payload"]["fflate_decoded"], canonical)
        for key in ("encoded", "fflate_encoded"):
            for original, encoded in zip(objects, self.js["payload"][key]):
                self.assertEqual(payload.decode_payload(encoded), original, key)

    def test_link_ladder_is_identical(self):
        checked_steps = set()
        for item in self.job["links"]:
            stats = json.loads(self.py_stats[item["stats"]])
            results = self.js["links"][item["stats"]]["fits"]
            for budget, theirs in zip(item["budgets"], results):
                where = (item["stats"], budget)
                if budget.get("expect_error"):
                    self.assertEqual(theirs, {"error": "link_too_long"}, where)
                    with self.assertRaises(payload.LinkTooLongError):
                        payload.fit_link(stats, quotes=budget["quotes"], max_length=budget["max_length"])
                    continue
                mine = payload.fit_link(stats, quotes=budget["quotes"], max_length=budget["max_length"])
                self.assertEqual(theirs["steps"], mine["steps"], where)
                self.assertEqual(theirs["stats"], payload.canonical_json(mine["stats"]), where)
                self.assertLessEqual(theirs["length"], budget["max_length"], where)
                self.assertEqual(payload.canonical_json(payload.stats_from_url(theirs["url"])),
                                 theirs["stats"], where)
                if "expect_steps" in budget:
                    self.assertEqual(mine["steps"], budget["expect_steps"], where)
                    checked_steps.add(mine["steps"])
        self.assertEqual(checked_steps, set(range(7)))

    def test_long_names_and_quotes_are_trimmed_identically_at_the_real_budget(self):
        stress = self.job["links"][0]
        stats = json.loads(self.py_stats[stress["stats"]])
        self.assertGreater(len(payload.BASE_URL + "#w1=" + payload.encode_payload(stats)), 4800)
        theirs = self.js["links"][stress["stats"]]["fits"][0]            # quotes, 4800
        mine = payload.fit_link(stats)
        self.assertGreater(mine["steps"], 0)
        self.assertEqual(theirs["steps"], mine["steps"])
        self.assertEqual(theirs["stats"], payload.canonical_json(mine["stats"]))
        self.assertLessEqual(len(theirs["url"]), 4800)
        self.assertLessEqual(len(mine["url"]), 4800)
        # and the margin to the neighbouring steps is wide enough that a few
        # bytes of difference between DEFLATE implementations cannot matter
        for lengths in (self.ladder_lengths(stats)[0], self.js["links"][stress["stats"]]["lengths"]):
            self.assertGreater(lengths[mine["steps"] - 1], 4800 + 40)
            self.assertLess(lengths[mine["steps"]], 4800 - 40)


if __name__ == "__main__":
    unittest.main()
