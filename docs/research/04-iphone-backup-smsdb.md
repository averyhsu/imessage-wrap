# 04 — iPhone backup (`sms.db`) parsed in the browser

_Researched 2026-11-11._ **[code]** = read in source on GitHub. **[test]** = run in this
sandbox (Node 22, not a real browser). **[snippet]** = search-result summary only:
`support.apple.com`, `sqlite.org`, Elcomsoft and iMazing were blocked here and the search
budget ran out, so every Apple statement below must be re-read before it is quoted.

## Verdict

- Feasible, and the only path that gives an iPhone-plus-Windows user their full history with
  nothing uploaded and nothing installed beyond Apple's own backup app.
- The file constants are confirmed and deterministic. The schema is the same as the Mac's
  `chat.db`, so one parser serves both.
- The largest open risk is Messages in iCloud. Apple's page says computer backups leave
  messages out; two vendors who parse backups for a living say the text is always there.
  **UNVERIFIED** until a real-device test.
- Setup is heavy (a full phone backup, 20–90 minutes) and the result lives on a desktop web
  page, not in Messages. Treat it as the completeness fallback, not the headline experience.

## Answers

### 1. Where `sms.db` lives
- fileID = `SHA1("<domain>-<relativePath>")`, stored at `<backup>/<first 2 hex>/<fileID>`.
  Recomputed here [test]:
  - `HomeDomain-Library/SMS/sms.db` → `3d0d7e5fb2ce288813306e4d4636395e047a3d28` (folder `3d/`)
  - `HomeDomain-Library/AddressBook/AddressBook.sqlitedb` → `31bb7ba8914766d4ba40d6dfb6113c8b614be442` (folder `31/`)
- Both constants are hard-coded in imessage-exporter
  ([table.rs](https://github.com/ReagentX/imessage-exporter/blob/develop/imessage-database/src/tables/table.rs),
  [contacts.rs](https://github.com/ReagentX/imessage-exporter/blob/develop/imessage-exporter/src/app/contacts.rs)) [code].
  They are stable for as long as Apple keeps the path. The `xx/` subfolders and `Manifest.db`
  date from iOS 10; older backups are flat
  ([path_hint.rs](https://github.com/ReagentX/imessage-exporter/blob/develop/imessage-database/src/util/path_hint.rs)).
- Manifest lookup [code,
  [iphone_backup.py](https://github.com/jsharkey13/iphone_backup_decrypt/blob/master/src/iphone_backup_decrypt/iphone_backup.py)]:
  `SELECT fileID, file FROM Files WHERE relativePath='Library/SMS/sms.db' AND domain='HomeDomain' AND flags=1`
  (flags 1 = file, 2 = folder, 4 = symlink). Not needed to locate the file, only to get its key
  in an encrypted backup.
- Contacts [code, contacts.rs]: `ABPerson(ROWID, First, Last, PersonLink)` joined to
  `ABMultiValue(record_id, property, value)` with `property` 3 = phone, 4 = email. Skip
  `ABStore.MeIdentifier`; merge linked cards through `ABPersonLink`.
- Attachments: `SHA1("MediaDomain-" + path)`
  ([attachment.rs](https://github.com/ReagentX/imessage-exporter/blob/develop/imessage-database/src/tables/attachment.rs)).

### 2. Backup folder locations
- macOS `~/Library/Application Support/MobileSync/Backup/<UDID>/`. Windows
  `%APPDATA%\Apple Computer\MobileSync\Backup` (iTunes from apple.com) or
  `%USERPROFILE%\Apple\MobileSync\Backup` (Microsoft Store iTunes and Apple Devices)
  ([dirs.rs](https://github.com/ReagentX/imessage-exporter/blob/develop/imessage-database/src/util/dirs.rs) [code];
  [Apple 108809](https://support.apple.com/en-us/108809) [snippet]).
- Linux has no standard folder. `idevicebackup2 backup --full <dir>` writes the same format
  ([man page](https://github.com/libimobiledevice/libimobiledevice/blob/master/docs/idevicebackup2.1)).
- macOS TCC: command-line tools need Full Disk Access to read this folder (path_hint.rs
  comment). Whether a browser's Open panel or a drag from Finder can read it without that
  is **UNVERIFIED**. Eclectic Light says user-intent access through Open panels and
  drag-and-drop is normally granted
  ([1](https://eclecticlight.co/2025/02/24/gaining-access-to-privacy-protected-folders/),
  [2](https://eclecticlight.co/2026/04/08/privacy-files-folders-or-full-disk-access/)) [snippet],
  but not for MobileSync specifically. Test: pick and drag `…/3d/3d0d…` in Safari, Chrome
  and Firefox. Fallback: copy the file to the Desktop in Finder first.
- New finding [code]: Chromium's File System Access blocklist refuses `~/Library` on macOS
  and all of `%APPDATA%` on Windows
  ([source](https://github.com/chromium/chromium/blob/main/chrome/browser/file_system_access/chrome_file_system_access_permission_context.cc)).
  `showDirectoryPicker()` therefore cannot open the classic iTunes folder or the Mac folder.
  Classic `<input type=file>` and drag-and-drop are not routed through that list (inferred
  from where the code lives; confirm by test).

### 3. Schema versus `chat.db`
Same schema; imessage-exporter runs one set of queries on both and says so in attachment.rs
[code]. Dates are nanoseconds since 2001-01-01 UTC, with older rows in seconds
([dates.rs](https://github.com/ReagentX/imessage-exporter/blob/develop/imessage-database/src/util/dates.rs)).
Tapbacks are `associated_message_type` 2000–2007 added, 3000–3007 removed, 1000 sticker,
4000 poll vote
([message.rs](https://github.com/ReagentX/imessage-exporter/blob/develop/imessage-database/src/tables/messages/message.rs)).
Differences that matter for statistics:
- Attachment paths are rooted at `~/Library/SMS`. Counts and MIME types still come from the
  `attachment` table without the files.
- Body text can be only in `attributedBody` (typedstream), so a decoder is required on both
  platforms.
- The phone is the primary store, so SMS/MMS/RCS group chats are more likely complete than
  on a Mac (inference, not tested).

### 4. Messages in iCloud — sources conflict
- Apple [snippet]: a computer backup does not include "Data already synced and stored in
  iCloud, like iCloud Photos, iMessages, and text (RCS and SMS) and multimedia (MMS)
  messages" ([108771](https://support.apple.com/en-us/108771),
  [platform guide](https://support.apple.com/en-la/guide/platform-support/sup77a8281a3/web)).
  For iCloud Backup the exclusion is undisputed ([108770](https://support.apple.com/en-us/108770)).
- Hands-on vendors [snippet]: Elcomsoft, "iMessages always appear in local backups, both
  encrypted and unencrypted"
  ([2022](https://blog.elcomsoft.com/2022/02/dude-where-are-my-messages/)). iMazing, which
  reads only local backups: older attachments may be offloaded but "Message text is never
  affected"
  ([guide](https://imazing.com/guides/how-to-export-iphone-text-messages-sms-and-imessages-to-your-computer-as-pdf-excel-csv-or-rsmf)).
  An [AAFS 2020 abstract](https://www.aafs.org/sites/default/files/media/documents/AAFS-2020-C9.pdf)
  was summarised two different ways and could not be read.
- Reading: probably present with full text, but **UNVERIFIED** on current iOS. Test: iPhone
  with Messages in iCloud on, unencrypted backup, confirm `3d/3d0d…` exists and compare
  `SELECT COUNT(*), MIN(date), MAX(date) FROM message` with the phone. Repeat for
  `31/31bb…` with iCloud Contacts on.

### 5. Encrypted backups
- Not the default: "Encrypt local backup" is an opt-in checkbox
  ([Apple Devices guide](https://support.apple.com/guide/devices-windows/mchla3c8ed03/windows),
  108771) [snippet]. From memory, not re-fetched: the setting lives on the phone and stays on
  for every later backup until turned off with the password.
- Algorithm [code,
  [utils.py](https://github.com/jsharkey13/iphone_backup_decrypt/blob/master/src/iphone_backup_decrypt/utils.py)]:
  1. `Manifest.plist` → `BackupKeyBag` (tag-length-value records).
  2. `PBKDF2-SHA256(password, DPSL, DPIC)` then `PBKDF2-SHA1(result, SALT, ITER)`, 32 bytes.
     DPIC is 10,000,000 and ITER 10,000 per the
     [README](https://github.com/jsharkey13/iphone_backup_decrypt/blob/master/README.md);
     both are read from the keybag.
  3. RFC 3394 AES key unwrap of each class key (`WPKY`, where `WRAP & 2`).
  4. `ManifestKey` = 4-byte little-endian class + wrapped key; AES-256-CBC with a zero IV
     decrypts `Manifest.db`.
  5. Per file: the `Files.file` plist gives `EncryptionKey` (skip 4 bytes, 40-byte wrapped
     key), `ProtectionClass` and `Size`; unwrap, AES-CBC with zero IV, strip padding.
- Implementations: iphone_backup_decrypt (Python),
  [crabapple](https://github.com/ReagentX/crabapple) (Rust, GPL-3.0, used by imessage-exporter).
- In the browser: realistic. WebCrypto defines PBKDF2, AES-KW and AES-CBC, and
  `deriveBits`, `unwrapKey` and `decrypt` ship in every major browser
  ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto)). The full
  derivation took 1.7 s here [test]; expect roughly 2–15 s on laptops (estimate). The costs:
  `Manifest.db` must be decrypted too, and the user must hand over the whole folder.
- Recommendation: unencrypted and single-file for the first demo, then encrypted. Users who
  ever ticked the box cannot easily go back, and asking people for an unencrypted full-phone
  backup is the worse privacy posture.

### 6. In-browser feasibility
- sql.js holds the whole file in memory
  ([README](https://github.com/sql-js/sql.js/blob/master/README.md)). Its constructor copies
  the buffer into MEMFS
  ([api.js](https://github.com/sql-js/sql.js/blob/master/src/api.js),
  [libmemfs.js](https://github.com/emscripten-core/emscripten/blob/main/src/lib/libmemfs.js)):
  a 364 MB test database used 729 MB of ArrayBuffers [test], opened in 0.9 s and scanned
  1.1 M rows in 0.5 s. It is built with `-DSQLITE_DISABLE_LFS`
  ([Makefile](https://github.com/sql-js/sql.js/blob/master/Makefile)), so 2 GB is a hard
  ceiling, and it exports no `FS`, so a `-wal` sidecar cannot be mounted.
- Lazy options:
  - A read-only VFS over the `File` using `FileReaderSync` in a Worker. Emscripten's WORKERFS
    does this "without copying the entire data into memory"
    ([docs](https://github.com/emscripten-core/emscripten/blob/main/site/source/docs/api_reference/Filesystem-API.rst)).
    Add a block cache: one project measured 14.6 s of 16 s lost to per-page Blob reads
    ([PR](https://github.com/alineacms/sqlite-wasm/pull/7)).
  - Official SQLite WASM `opfs-sahpool` with chunked `importDb(name, callback)`. It needs no
    COOP/COEP headers; the plain `opfs` VFS does
    ([sahpool](https://github.com/sqlite/sqlite/blob/master/ext/wasm/api/sqlite3-vfs-opfs-sahpool.c-pp.js),
    [opfs](https://github.com/sqlite/sqlite/blob/master/ext/wasm/api/sqlite3-vfs-opfs.c-pp.js)).
- WAL [test, sqlite-wasm 3.54.1]: a WAL-flagged file opened read-only fails with
  `SQLITE_CANTOPEN`. It opens with `immutable=1`, or with header bytes 18–19 patched to 1
  (what `importDb` does), or read-write with `locking_mode=exclusive`. Only the last merges
  a real `-wal`. sql.js opens WAL-flagged files, but given a copy without its `-wal` it
  silently drops the unmerged rows. Backups are probably checkpointed (Elcomsoft: databases
  are merged the moment a backup starts,
  [2020](https://blog.elcomsoft.com/2020/07/the-iphone-data-recovery-myth-what-you-can-and-cannot-recover/))
  — **UNVERIFIED**. Test: `SELECT relativePath FROM Files WHERE relativePath LIKE 'Library/SMS/sms.db%'`.
- Pickers (MDN compat data): `showOpenFilePicker` and `showDirectoryPicker` are Chrome and
  Edge 86+ only. `webkitdirectory` works in Chrome, Edge 13+, Firefox 50+, Safari 11.1+, but
  enumerates the entire tree, which is too slow for a backup. Dropped folders give
  `webkitGetAsEntry()` in all four, and
  [`getFile(path)`](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemDirectoryEntry/getFile)
  fetches a known path without enumeration.
- Sizes [snippet, anecdotal]: 300 MB next to 12 GB of attachments; 1.2 GB next to 79 GB.

### 7. Existing tools
- [imessage-exporter](https://github.com/ReagentX/imessage-exporter): free, GPL-3.0, reads
  encrypted and unencrypted backups. Prebuilt binaries are Mac-only; Windows needs
  `cargo install`. An escape hatch for technical users only.
- iMazing: paid desktop app with a limited trial (prices found ranged about $40–70,
  **UNVERIFIED**).
- In-browser precedent: [jsifuentes/sms.db](https://github.com/jsifuentes/sms.db) (sql.js,
  archived 2022); and, [snippet] only,
  [Essex iPhone Backup Viewer](https://essexsoftware.com/iphone-backup-viewer/), a
  [WhatsApp backup viewer](https://moritzglantz.de/blog/posts/whatsapp-ios-backup-viewer/)
  and [Story of Us](https://storyofus.app/guides/export-imessage-history/) (reads `chat.db`
  locally, sends a sample to its server).

### 8. Simplest path
There is no partial backup; the full backup is the cost. After it, the user hands over one
file (`3d\3d0d…`), or drops the device folder and the page fetches the known paths itself.

### 9. Privacy and terms (assessment, not legal advice)
The user reads their own data, made with Apple's own tool, on their own computer; no App
Store review applies and nothing is circumvented. The duties are ours: other people's
messages are in the file, so nothing may leave the page (`connect-src 'none'`, self-hosted
WASM, works offline, open source), share cards need redaction, and the page should tell
the user to delete an unencrypted backup afterwards.

## User steps (iPhone + Windows)

1. Install **Apple Devices** from the Microsoft Store.
2. Plug in the iPhone, unlock it, tap **Trust**, enter the passcode.
3. Select the iPhone → **General** → back up to this computer, leave **Encrypt local
   backup** unticked (first version) → **Back Up Now**, enter the passcode again.
4. Wait. Estimated 10–60+ minutes and free disk about equal to the phone's used storage
   (**UNVERIFIED**).
5. Press Win+R and paste `%USERPROFILE%\Apple\MobileSync\Backup` (if that fails,
   `%AppData%\Apple Computer\MobileSync\Backup`).
6. Open the long-named folder, then `3d`.
7. Drag `3d0d7e5f…3d28` onto the page (and `31\31bb7ba8…e442` for contact names).
8. Pick a group chat. Afterwards delete the backup under **Manage Backups**.

About five minutes of attention inside 20–90 minutes of waiting.

## Scores

| Criterion | Score | Reason |
|---|---|---|
| In-Messages | 0 | A desktop web page; nothing appears in Messages. |
| iPhone-only | 2 | No Mac needed, but a computer and cable are. |
| Works for everyone | 3 | Any iPhone plus any PC; iCloud question and encryption open. |
| Low setup | 1 | Install, full backup, hashed filename. |
| Usable by strangers today | 2 | Possible with a good guide; high drop-off. |
| Privacy | 4 | Nothing uploaded; an unencrypted backup sits on disk. |
| Wow factor | 3 | Full history and tapbacks, but shown on a laptop. |
| Feasibility | 4 | Every piece exists in open source; three device tests pending. |
| Cost | 5 | Static site. |
| Time to demo | 4 | Days for single-file, unencrypted; parser shared with the Mac path. |
| App Store / ToS risk | 5 | No App Store; own data; long-standing ecosystem. |

## Implications for the build

1. One SQL layer for `chat.db` and `sms.db`; aggregate in SQL and decode `attributedBody`
   only where `text` is NULL. Write our own decoder or use permissively licensed code, since
   imessage-exporter and crabapple are GPL-3.0.
2. Inputs: single-file drop, `<input type=file>`, and folder drop with `getFile()` on the
   known paths. Do not depend on `showDirectoryPicker`.
3. Sniff the first 16 bytes. If they are not `SQLite format 3\0`, say "this backup is
   encrypted" rather than "corrupt file".
4. Memory: sql.js is fine for a demo with a guard at about 500 MB. For release, run SQLite
   WASM in a Worker over a read-only `File`-backed VFS with a block cache, with
   `opfs-sahpool` `importDb` as the fallback.
5. Open backup copies with `immutable=1`. Probe for `cd/cd47480f213dba9bc38ee792775d17e3f5a73a59`
   (`sms.db-wal`) and warn if it exists. For a Mac `chat.db`, require the `-wal` and open
   read-write, exclusive, on a copy.
6. Always show a diagnostics line (messages, chats, first and last date). That is how a
   partial database from Messages in iCloud becomes visible.
7. Contacts are optional: without the second file, show numbers and let users rename.
8. Before promising this path, run the device tests in answers 2, 4 and 6, across iCloud
   Messages on/off × encrypted on/off × Apple Devices, iTunes and Finder.

## Sources

Code read: [iphone_backup_decrypt](https://github.com/jsharkey13/iphone_backup_decrypt),
[imessage-exporter](https://github.com/ReagentX/imessage-exporter)
([FAQ](https://github.com/ReagentX/imessage-exporter/blob/develop/docs/faq.md)),
[crabapple](https://github.com/ReagentX/crabapple),
[libimobiledevice](https://github.com/libimobiledevice/libimobiledevice),
[sql.js](https://github.com/sql-js/sql.js),
[Emscripten](https://github.com/emscripten-core/emscripten),
[SQLite WASM](https://github.com/sqlite/sqlite/tree/master/ext/wasm),
[Chromium](https://github.com/chromium/chromium),
[MDN compat data](https://github.com/mdn/browser-compat-data) and
[MDN content](https://github.com/mdn/content),
[alinea sqlite-wasm PR 7](https://github.com/alineacms/sqlite-wasm/pull/7).

Search snippets only (re-read before relying on them): Apple
[108771](https://support.apple.com/en-us/108771),
[108809](https://support.apple.com/en-us/108809),
[108770](https://support.apple.com/en-us/108770),
[Apple Devices guide](https://support.apple.com/guide/devices-windows/mchla3c8ed03/windows),
[platform guide](https://support.apple.com/en-la/guide/platform-support/sup77a8281a3/web);
Elcomsoft [2022](https://blog.elcomsoft.com/2022/02/dude-where-are-my-messages/),
[2020](https://blog.elcomsoft.com/2020/07/the-iphone-data-recovery-myth-what-you-can-and-cannot-recover/);
[iMazing guide](https://imazing.com/guides/how-to-export-iphone-text-messages-sms-and-imessages-to-your-computer-as-pdf-excel-csv-or-rsmf);
Eclectic Light [2025](https://eclecticlight.co/2025/02/24/gaining-access-to-privacy-protected-folders/),
[2026](https://eclecticlight.co/2026/04/08/privacy-files-folders-or-full-disk-access/);
[AAFS 2020 C9](https://www.aafs.org/sites/default/files/media/documents/AAFS-2020-C9.pdf);
size anecdotes from a
[MacRumors thread](https://forums.macrumors.com/threads/transfer-messages-attachments-from-iphone-backup-to-mac-messages-app.1938227/page-2)
and an r/DataHoarder thread.

Sandbox tests: SHA-1 fileIDs; WebCrypto PBKDF2 timing; WAL behaviour (sql.js 1.16.0,
@sqlite.org/sqlite-wasm 3.54.1); sql.js memory on a synthetic 364 MB database.
