#!/usr/bin/env python3
"""Make small WAL-mode databases whose newest data only exists in the -wal.

    python tests/engine-js/wal_cases.py OUTDIR

For every case OUTDIR/<name>/db and OUTDIR/<name>/db-wal are written, and
OUTDIR/cases.json records what SQLite itself reads from the pair (row count
and a SHA-256 of the rows), opened read-only. The JavaScript WAL merger in
web/make/db.js must reproduce exactly that. Invented data, standard library
only.
"""

import hashlib
import json
import os
import shutil
import sqlite3
import struct
import sys

QUERY = "SELECT id, a, hex(b) FROM t ORDER BY id"


def filler(seed, n):
    out = bytearray()
    state = seed * 2654435761 % (1 << 32) or 1
    while len(out) < n:
        state = (state * 1103515245 + 12345) % (1 << 31)
        out.append(state >> 16 & 0xFF)
    return bytes(out)


def snapshot(con, work, dest):
    os.makedirs(dest, exist_ok=True)
    shutil.copyfile(work, os.path.join(dest, "db"))
    shutil.copyfile(work + "-wal", os.path.join(dest, "db-wal"))


def make(out, name, page_size, script):
    work_dir = os.path.join(out, "_work_" + name)
    os.makedirs(work_dir)
    work = os.path.join(work_dir, "db")
    con = sqlite3.connect(work, isolation_level=None)
    con.execute("PRAGMA page_size = %d" % page_size)
    con.execute("PRAGMA journal_mode = WAL")
    con.execute("PRAGMA wal_autocheckpoint = 0")
    con.execute("PRAGMA synchronous = OFF")
    con.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b BLOB)")
    con.execute("CREATE INDEX t_a ON t (a)")
    script(con)
    snapshot(con, work, os.path.join(out, name))
    con.close()
    shutil.rmtree(work_dir)


def insert(con, first, count, blob=40):
    con.execute("BEGIN")
    for i in range(first, first + count):
        con.execute("INSERT INTO t VALUES (?, ?, ?)", (i, "row %d" % i, filler(i, blob + i % 7)))
    con.execute("COMMIT")


def base(con, rows=300):
    insert(con, 1, rows)
    con.execute("PRAGMA wal_checkpoint(TRUNCATE)")


def simple(con):
    base(con)
    insert(con, 1000, 50)
    insert(con, 2000, 5)
    con.execute("UPDATE t SET a = 'changed ' || id WHERE id % 10 = 0")
    con.execute("DELETE FROM t WHERE id % 17 = 0")


def grow(con):
    base(con, 50)
    insert(con, 1000, 400, blob=3000)       # overflow pages, database grows a lot


def overwrite(con):
    base(con)
    for round_ in range(12):
        con.execute("UPDATE t SET a = ? || id WHERE id <= 40", ("round %d " % round_,))


def restart(con):
    base(con)
    insert(con, 1000, 200)
    con.execute("UPDATE t SET a = 'old generation' WHERE id < 100")
    con.execute("PRAGMA wal_checkpoint(PASSIVE)")   # log is kept, next writer restarts it
    insert(con, 5000, 3)                              # new salts; stale frames follow


def shrink(con):
    base(con, 2000)
    con.execute("DELETE FROM t WHERE id > 20")
    con.execute("VACUUM")                             # the commit frame shrinks the database


def only_wal(con):
    insert(con, 1, 120)                               # never checkpointed: almost all in the log


def read_expected(case_dir):
    """What SQLite sees, on a private copy so the case files stay untouched."""
    copy = case_dir + "_copy"
    shutil.copytree(case_dir, copy)
    try:
        con = sqlite3.connect("file:%s?mode=ro" % os.path.join(copy, "db"), uri=True)
        rows = con.execute(QUERY).fetchall()
        check = con.execute("PRAGMA integrity_check").fetchone()[0]
        con.close()
    finally:
        shutil.rmtree(copy)
    digest = hashlib.sha256()
    for row in rows:
        digest.update(("%d|%s|%s\n" % row).encode("utf-8"))
    with open(os.path.join(case_dir, "db"), "rb") as handle:
        header = handle.read(100)
    plain = sqlite3.connect("file:%s?immutable=1" % os.path.join(case_dir, "db"), uri=True)
    try:
        without = plain.execute("SELECT COUNT(*) FROM t").fetchone()[0]
    except sqlite3.Error:
        without = None
    plain.close()
    return {"rows": len(rows), "sha256": digest.hexdigest(), "integrity": check,
            "rows_without_wal": without,
            "page_size": (lambda n: 65536 if n == 1 else n)(struct.unpack(">H", header[16:18])[0]),
            "wal_bytes": os.path.getsize(os.path.join(case_dir, "db-wal"))}


def checksum(data, s0, s1, big):
    fmt = ">II" if big else "<II"
    for i in range(0, len(data), 8):
        x0, x1 = struct.unpack_from(fmt, data, i)
        s0 = (s0 + x0 + s1) & 0xFFFFFFFF
        s1 = (s1 + x1 + s0) & 0xFFFFFFFF
    return s0, s1


def to_big_endian_checksums(wal):
    """Rewrite a log so its checksums use big-endian words (magic 0x377f0683),
    as a big-endian machine would have written it."""
    out = bytearray(wal)
    page_size = struct.unpack(">I", wal[8:12])[0]
    out[0:4] = struct.pack(">I", 0x377F0683)
    s0, s1 = checksum(bytes(out[0:24]), 0, 0, True)
    out[24:32] = struct.pack(">II", s0, s1)
    old_salts = wal[16:24]
    frame = 24 + page_size
    for offset in range(32, len(wal) - frame + 1, frame):
        if wal[offset + 8:offset + 16] != old_salts:
            break
        s0, s1 = checksum(bytes(out[offset:offset + 8]), s0, s1, True)
        s0, s1 = checksum(bytes(out[offset + 24:offset + frame]), s0, s1, True)
        out[offset + 16:offset + 24] = struct.pack(">II", s0, s1)
    return bytes(out)


def derive(out, source, name, change):
    dest = os.path.join(out, name)
    shutil.copytree(os.path.join(out, source), dest)
    with open(os.path.join(dest, "db-wal"), "rb") as handle:
        wal = handle.read()
    with open(os.path.join(dest, "db-wal"), "wb") as handle:
        handle.write(change(wal))


def main(out):
    if os.path.exists(out):
        shutil.rmtree(out)
    os.makedirs(out)
    make(out, "simple", 4096, simple)
    make(out, "page1024", 1024, simple)
    make(out, "page512", 512, simple)
    make(out, "page8192", 8192, simple)
    make(out, "page65536", 65536, simple)
    make(out, "grow", 4096, grow)
    make(out, "overwrite", 4096, overwrite)
    make(out, "restart", 4096, restart)
    make(out, "shrink", 1024, shrink)
    make(out, "only_wal", 4096, only_wal)
    frame = 24 + 4096
    derive(out, "simple", "truncated_frame", lambda wal: wal[:len(wal) - frame // 2])
    derive(out, "simple", "cut_two_frames", lambda wal: wal[:len(wal) - 2 * frame])
    derive(out, "simple", "header_only", lambda wal: wal[:32])
    derive(out, "simple", "empty_wal", lambda wal: b"")
    derive(out, "simple", "flipped_byte",
           lambda wal: wal[:32 + 5 * frame + 100] + bytes([wal[32 + 5 * frame + 100] ^ 0xFF])
           + wal[32 + 5 * frame + 101:])
    derive(out, "simple", "bad_salt",
           lambda wal: wal[:32 + 3 * frame + 8] + b"\x00\x00\x00\x00" + wal[32 + 3 * frame + 12:])
    derive(out, "simple", "garbage_tail", lambda wal: wal + filler(9, 3 * frame))
    derive(out, "simple", "big_endian", to_big_endian_checksums)
    derive(out, "restart", "restart_big_endian", to_big_endian_checksums)
    cases = {}
    for name in sorted(os.listdir(out)):
        case_dir = os.path.join(out, name)
        if os.path.isdir(case_dir):
            cases[name] = read_expected(case_dir)
    with open(os.path.join(out, "cases.json"), "w", encoding="utf-8") as handle:
        json.dump({"query": QUERY, "cases": cases}, handle, indent=1)
    return cases


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.stderr.write(__doc__)
        sys.exit(2)
    for name, info in main(sys.argv[1]).items():
        sys.stdout.write("%-20s %s\n" % (name, json.dumps(info)))
