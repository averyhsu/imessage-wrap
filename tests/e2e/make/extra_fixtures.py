#!/usr/bin/env python3
"""Small extra databases for the maker's end-to-end tests. Invented data only.

    python tests/e2e/make/extra_fixtures.py OUTDIR

Written to OUTDIR (generated at test time, never committed):

    nogroups/chat.db    a real Messages schema with one 1:1 conversation and no group chat
    many/chat.db        twelve small group chats (the chat list shows a search box)
    other/library.db    a SQLite database that has nothing to do with Messages
    hostile/chat.db     two group chats whose people are called constructor, toString,
                        __proto__ and the like: once as the sender itself (the handle),
                        once only through hostile/AddressBook-v22.abcddb
    twins/a/chat.db, twins/b/chat.db
                        two different databases with the same file name
"""

import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "fixtures"))

import build_fixture  # noqa: E402  (the shared, invented Messages schema)


def write_no_groups(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    con = sqlite3.connect(path)
    build_fixture.create_messages_schema(con)
    con.execute("INSERT INTO handle (id, service) VALUES ('+15550100042', 'iMessage')")
    con.execute("INSERT INTO chat (guid, style, chat_identifier, service_name, display_name) "
                "VALUES ('iMessage;-;+15550100042', 45, '+15550100042', 'iMessage', '')")
    con.execute("INSERT INTO chat_handle_join VALUES (1, 1)")
    start = build_fixture.utc(2026, 4, 1, 12, 0, 0)
    for i, text in enumerate(["are we still on for Friday", "yes", "bring the board game"]):
        seconds = start + i * 60 - build_fixture.APPLE_EPOCH
        con.execute("INSERT INTO message (guid, text, handle_id, date, is_from_me) VALUES (?,?,?,?,?)",
                    ("NOGROUP-%d" % i, text, 1, seconds * 1000000000, i % 2))
        con.execute("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, ?)", (i + 1,))
    con.commit()
    con.close()


MANY_NAMES = ["Pickleball Sundays", "Carpool", "Flat 4B", "Book Swap", "Trivia Team", "Garden Plot 12",
              "Choir Altos", "Road Trip", "Cousins", "Lunch Run", "Climbing Gym", "Film Night"]


def write_many(path):
    """Twelve small group chats, enough for the chat list to offer a search box."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    con = sqlite3.connect(path)
    build_fixture.create_messages_schema(con)
    for person in range(1, 5):
        con.execute("INSERT INTO handle (id, service) VALUES (?, 'iMessage')", ("+1555010%04d" % (7000 + person),))
    start = build_fixture.utc(2026, 2, 1, 18, 0, 0)
    message = 0
    for index, name in enumerate(MANY_NAMES):
        chat = index + 1
        con.execute("INSERT INTO chat (guid, style, chat_identifier, service_name, display_name) "
                    "VALUES (?, 43, ?, 'iMessage', ?)",
                    ("iMessage;+;chat9%05d" % chat, "chat9%05d" % chat, name))
        members = [1 + (index + k) % 4 for k in range(3)]
        for handle in members:
            con.execute("INSERT INTO chat_handle_join VALUES (?, ?)", (chat, handle))
        for k in range(3 + index):
            message += 1
            seconds = start + index * 86400 + k * 300 - build_fixture.APPLE_EPOCH
            con.execute("INSERT INTO message (guid, text, handle_id, date, is_from_me) VALUES (?,?,?,?,?)",
                        ("MANY-%d" % message, "an invented line for %s" % name, members[k % 3],
                         seconds * 1000000000, 1 if k % 4 == 3 else 0))
            con.execute("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)", (chat, message))
    con.commit()
    con.close()


def write_other(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT)")
    con.execute("INSERT INTO books (title) VALUES ('An Invented Novel')")
    con.commit()
    con.close()


# Names that every JavaScript object already "has". A page that keeps people in a plain
# object keyed by name falls over on them; nobody is stopped from being saved as one.
HOSTILE_HANDLES = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]
HOSTILE_CONTACTS = [
    # first, last, phone: two share a first word, so the short names need an initial
    ("constructor", "Jones", "+15550108001"),
    ("constructor", "Ng", "+15550108002"),
    ("__proto__", "Smith", "+15550108003"),
    ("toString", None, "+15550108004"),
    ("hasOwnProperty", "Lee", "+15550108005"),
]
HOSTILE_LINES = ["who is bringing the cake", "me", "no, me", "we do not need two cakes", "we always need two cakes",
                 "fine", "what time", "seven", "seven thirty", "I will be late", "as always"]


def write_hostile(db_path, book_path):
    """Chat 1 "By handle": the senders are the names themselves. Chat 2 "By contact":
    ordinary phone numbers that the address book gives those names to."""
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    con = sqlite3.connect(db_path)
    build_fixture.create_messages_schema(con)
    handles = HOSTILE_HANDLES + [phone for _first, _last, phone in HOSTILE_CONTACTS]
    for ident in handles:
        con.execute("INSERT INTO handle (id, service) VALUES (?, 'iMessage')", (ident,))
    chats = [("By handle", range(1, len(HOSTILE_HANDLES) + 1)),
             ("By contact", range(len(HOSTILE_HANDLES) + 1, len(handles) + 1))]
    start = build_fixture.utc(2026, 3, 1, 19, 0, 0)
    message = 0
    for index, (name, members) in enumerate(chats):
        chat = index + 1
        members = list(members)
        con.execute("INSERT INTO chat (guid, style, chat_identifier, service_name, display_name) "
                    "VALUES (?, 43, ?, 'iMessage', ?)",
                    ("iMessage;+;chat8%05d" % chat, "chat8%05d" % chat, name))
        for handle in members:
            con.execute("INSERT INTO chat_handle_join VALUES (?, ?)", (chat, handle))
        for k in range(60):
            message += 1
            mine = k % 6 == 5
            sender = members[(k * 7 + k // 5) % len(members)]
            seconds = start + index * 3600 + k * 5400 - build_fixture.APPLE_EPOCH
            con.execute("INSERT INTO message (guid, text, handle_id, date, is_from_me) VALUES (?,?,?,?,?)",
                        ("HOSTILE-%d" % message, HOSTILE_LINES[k % len(HOSTILE_LINES)],
                         0 if mine else sender, seconds * 1000000000, 1 if mine else 0))
            con.execute("INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)", (chat, message))
    con.commit()
    con.close()
    build_fixture.write_mac_address_book(
        book_path, [(first, last, None, None, [("phone", phone)]) for first, last, phone in HOSTILE_CONTACTS])


def write_twins(root):
    """Two databases called chat.db, in two folders: one group chat each, told apart by name."""
    for folder, name in (("a", "Folder A"), ("b", "Folder B")):
        path = os.path.join(root, folder, "chat.db")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        con = sqlite3.connect(path)
        build_fixture.create_messages_schema(con)
        for person in range(1, 4):
            con.execute("INSERT INTO handle (id, service) VALUES (?, 'iMessage')", ("+1555010%04d" % (6000 + person),))
        con.execute("INSERT INTO chat (guid, style, chat_identifier, service_name, display_name) "
                    "VALUES ('iMessage;+;chat700001', 43, 'chat700001', 'iMessage', ?)", (name,))
        for handle in range(1, 4):
            con.execute("INSERT INTO chat_handle_join VALUES (1, ?)", (handle,))
        start = build_fixture.utc(2026, 5, 1, 9, 0, 0)
        for k in range(9 if folder == "a" else 14):
            seconds = start + k * 600 - build_fixture.APPLE_EPOCH
            con.execute("INSERT INTO message (guid, text, handle_id, date, is_from_me) VALUES (?,?,?,?,?)",
                        ("TWIN-%s-%d" % (folder, k), "an invented line in %s" % name, 1 + k % 3,
                         seconds * 1000000000, 1 if k % 4 == 3 else 0))
            con.execute("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, ?)", (k + 1,))
        con.commit()
        con.close()


def main(argv):
    if len(argv) != 2 or argv[1].startswith("-"):
        sys.stderr.write(__doc__)
        return 2
    out = os.path.abspath(argv[1])
    write_no_groups(os.path.join(out, "nogroups", "chat.db"))
    write_many(os.path.join(out, "many", "chat.db"))
    write_other(os.path.join(out, "other", "library.db"))
    write_hostile(os.path.join(out, "hostile", "chat.db"), os.path.join(out, "hostile", "AddressBook-v22.abcddb"))
    write_twins(os.path.join(out, "twins"))
    sys.stdout.write("extra fixtures written to %s\n" % out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
