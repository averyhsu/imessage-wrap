/*
 * Threadback database layer for the browser (and Node, for the tests).
 *
 * A classic script. In a page it defines window.WrappedDB and expects
 * engine.js (window.WrappedEngine) and vendor/sql-wasm.js (window.initSqlJs)
 * to be loaded first; in Node it is the module's exports. Everything happens
 * in memory on the user's device: no network requests are made.
 *
 *   await WrappedDB.init({locateFile})             load the SQLite WebAssembly
 *   WrappedDB.precheck(size, first16Bytes)         cheap test before reading a file
 *   await WrappedDB.openDatabase({db, wal})        -> handle
 *       handle.query(sql, params) -> [{column: value}]   handle.close()
 *       handle.warnings [{code, message}]          handle.info {walMode, walMerged, ...}
 *   WrappedDB.kind(handle)                         "messages" | "contacts" | "manifest" | "unknown"
 *   WrappedDB.listGroupChats(handle, {contacts, me}) -> {chats, diagnostics, warnings}
 *   WrappedDB.findChat(chats, query)               by id, guid, identifier or name
 *   WrappedDB.loadChat(handle, chat)               -> {rows, chat_name, participants}
 *   WrappedDB.loadContacts(handle)                 -> [[identifier, name], ...]
 *   WrappedDB.statsForChat(handle, chat, options)  -> stats (engine options + contacts)
 *   WrappedDB.pickBackupFiles(files)               find sms.db / AddressBook in a file list
 *   WrappedDB.backupPaths                          the known paths inside a backup folder
 *   WrappedDB.mergeWal(dbBytes, walBytes)          apply a -wal file to a database image
 *
 * Write-ahead log. A Mac's live chat.db nearly always has recent rows that
 * exist only in chat.db-wal. sql.js cannot mount a -wal next to the database,
 * so mergeWal() does what SQLite's own recovery does: it walks the frames,
 * checks the salts and the running checksums, and copies every page of every
 * committed transaction over the database image. When a database says it is in
 * WAL mode and no -wal was supplied, openDatabase() reports the warning
 * "wal_missing" instead of silently undercounting. A merged image is checked
 * (PRAGMA quick_check) before it is trusted; a -wal that does not fit the
 * database is left out with the warning "wal_invalid".
 *
 * Errors. Everything this file rejects or throws is an Error with a `code`
 * and a sentence for the user: "empty", "not_sqlite", "too_large", "corrupt"
 * (SQLite could not read the file, at open or at any later query), "schema"
 * (a table or a column of the Messages layout is missing), "contacts_schema",
 * "no_chat", "ambiguous_chat" and "no_sqlite". Cells of an unexpected type
 * never fail: every column is CAST in SQL to the type it should have.
 */
(function (root, factory) {
  'use strict';
  var engine = (typeof module === 'object' && module && module.exports)
    ? require('./engine.js') : root.WrappedEngine;
  var api = factory(root, engine);
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  } else {
    root.WrappedDB = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (root, Engine) {
  'use strict';

  var PRODUCT_NAME = Engine ? Engine.PRODUCT_NAME : 'Threadback';
  var GROUP_STYLE = 43;
  var MB = 1024 * 1024;
  // sql.js keeps the whole file in WebAssembly memory (about twice its size
  // while loading) and cannot address more than 2 GB.
  var MAX_DB_BYTES = 900 * MB;
  var SQLITE_MAGIC = [83, 81, 76, 105, 116, 101, 32, 102, 111, 114, 109, 97, 116, 32, 51, 0];

  // fileID = SHA-1("<domain>-<relativePath>"), stored as <first 2 hex>/<fileID>
  var SMS_DB_ID = '3d0d7e5fb2ce288813306e4d4636395e047a3d28';        // Library/SMS/sms.db
  var SMS_WAL_ID = 'cd47480f213dba9bc38ee792775d17e3f5a73a59';       // Library/SMS/sms.db-wal
  var ADDRESS_BOOK_ID = '31bb7ba8914766d4ba40d6dfb6113c8b614be442';  // AddressBook.sqlitedb
  var backupPaths = {
    messages: SMS_DB_ID.slice(0, 2) + '/' + SMS_DB_ID,
    messagesWal: SMS_WAL_ID.slice(0, 2) + '/' + SMS_WAL_ID,
    contacts: ADDRESS_BOOK_ID.slice(0, 2) + '/' + ADDRESS_BOOK_ID,
    manifest: 'Manifest.db',
    manifestPlist: 'Manifest.plist'
  };

  var MESSAGES = {
    not_sqlite: 'This file is not a SQLite database. If it came out of an iPhone backup, this ' +
      'looks like an ENCRYPTED iPhone backup: untick "Encrypt local backup" in Finder or the ' +
      'Apple Devices app and back up again, or use the ' + PRODUCT_NAME + ' command-line tool.',
    too_large: 'This database is {size} MB. The in-browser reader can handle up to {limit} MB; ' +
      'use the ' + PRODUCT_NAME + ' command-line tool on your computer for this one.',
    empty: 'This file is empty.',
    wal_missing: 'This database was copied while Messages still had changes in its ' +
      'write-ahead log, so recent messages may be missing. Also select the file next to it ' +
      'whose name ends in "-wal" (chat.db-wal).',
    wal_invalid: 'The -wal file does not belong to this copy of the database (or is damaged), so it ' +
      'was ignored. Recent messages may be missing: copy chat.db and chat.db-wal again, together.',
    corrupt: 'SQLite could not read this database: ',
    schema: 'This is a SQLite database but not a Messages database (no "{table}" table).',
    layout: 'This is not a Messages database this page can read: part of the usual layout is missing ({detail}).',
    contacts_schema: 'This file is not an address book this program knows how to read.',
    no_chat: 'No group chat matches "{query}".',
    ambiguous_chat: '{count} group chats match "{query}". Pick one from the list instead.'
  };

  function fail(code, message, extra) {
    var error = new Error(message);
    error.code = code;
    if (extra) Object.keys(extra).forEach(function (key) { error[key] = extra[key]; });
    return error;
  }

  function fill(template, values) {
    return template.replace(/\{(\w+)\}/g, function (_all, key) { return String(values[key]); });
  }

  // ------------------------------------------------------------------ //
  // sniffing and the write-ahead log
  // ------------------------------------------------------------------ //

  function u32(bytes, offset) {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>> 0;
  }

  function putU32(bytes, offset, value) {
    bytes[offset] = (value >>> 24) & 255;
    bytes[offset + 1] = (value >>> 16) & 255;
    bytes[offset + 2] = (value >>> 8) & 255;
    bytes[offset + 3] = value & 255;
  }

  /**
   * Look at the first bytes of a file. Returns {sqlite, walMode, pageSize}.
   * 16 bytes are enough for `sqlite`; 20 for the rest.
   */
  function sniff(bytes) {
    var info = { sqlite: false, walMode: false, pageSize: 0 };
    if (!bytes || bytes.length < 16) return info;
    for (var i = 0; i < 16; i++) {
      if (bytes[i] !== SQLITE_MAGIC[i]) return info;
    }
    info.sqlite = true;
    if (bytes.length >= 20) {
      var size = (bytes[16] << 8) | bytes[17];
      info.pageSize = size === 1 ? 65536 : size;
      info.walMode = bytes[18] === 2 || bytes[19] === 2;
    }
    return info;
  }

  /**
   * A cheap test to run before reading a whole file into memory.
   * size: the file size in bytes; head: its first 16+ bytes (optional).
   * Returns null when the file can be opened, else {code, message}.
   */
  function precheck(size, head) {
    if (size === 0) return { code: 'empty', message: MESSAGES.empty };
    if (head && head.length >= 16 && !sniff(head).sqlite) {
      return { code: 'not_sqlite', message: MESSAGES.not_sqlite };
    }
    if (size > MAX_DB_BYTES) {
      return {
        code: 'too_large',
        message: fill(MESSAGES.too_large, { size: Math.round(size / MB), limit: Math.round(MAX_DB_BYTES / MB) })
      };
    }
    return null;
  }

  function walChecksum(bytes, offset, length, state, bigEndian) {
    var s0 = state[0];
    var s1 = state[1];
    var end = offset + length;
    var x0, x1;
    for (var i = offset; i < end; i += 8) {
      if (bigEndian) {
        x0 = ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
        x1 = ((bytes[i + 4] << 24) | (bytes[i + 5] << 16) | (bytes[i + 6] << 8) | bytes[i + 7]) >>> 0;
      } else {
        x0 = (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0;
        x1 = (bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24)) >>> 0;
      }
      s0 = (s0 + x0 + s1) >>> 0;
      s1 = (s1 + x1 + s0) >>> 0;
    }
    state[0] = s0;
    state[1] = s1;
  }

  /**
   * Apply a write-ahead log to a database image, the way SQLite recovers one.
   *
   * dbBytes / walBytes are Uint8Arrays holding the two files. Returns
   * {bytes, merged, frames, commits, pages, reason, undo}: `bytes` is the database
   * with every committed transaction applied and its header switched to
   * rollback-journal mode (it may be dbBytes itself, modified in place, or a
   * new larger array); `merged` is false when the log held nothing usable, in
   * which case `reason` says why ("empty", "bad-magic", "bad-header",
   * "page-size", "no-commit").
   */
  function mergeWal(dbBytes, walBytes) {
    var result = {
      bytes: dbBytes, merged: false, frames: 0, commits: 0, pages: 0, reason: '',
      undo: function () { /* nothing was changed */ }
    };
    if (!walBytes || walBytes.length < 32) { result.reason = 'empty'; return result; }
    var magic = u32(walBytes, 0);
    if (magic !== 0x377f0682 && magic !== 0x377f0683) { result.reason = 'bad-magic'; return result; }
    var bigEndian = (magic & 1) === 1;
    var pageSize = u32(walBytes, 8);
    var salt1 = u32(walBytes, 16);
    var salt2 = u32(walBytes, 20);
    var state = [0, 0];
    walChecksum(walBytes, 0, 24, state, bigEndian);
    if (u32(walBytes, 4) !== 3007000 || state[0] !== u32(walBytes, 24) || state[1] !== u32(walBytes, 28)) {
      result.reason = 'bad-header';
      return result;
    }
    var header = sniff(dbBytes);
    if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0 ||
        (header.sqlite && header.pageSize !== pageSize)) {
      result.reason = 'page-size';
      return result;
    }
    var frameSize = 24 + pageSize;
    var frameCount = Math.floor((walBytes.length - 32) / frameSize);
    var committed = new Map();      // page number -> offset of its newest committed image
    var pending = new Map();
    var sizeInPages = 0;
    for (var f = 0; f < frameCount; f++) {
      var offset = 32 + f * frameSize;
      var page = u32(walBytes, offset);
      var commitSize = u32(walBytes, offset + 4);
      if (page === 0 || u32(walBytes, offset + 8) !== salt1 || u32(walBytes, offset + 12) !== salt2) break;
      walChecksum(walBytes, offset, 8, state, bigEndian);
      walChecksum(walBytes, offset + 24, pageSize, state, bigEndian);
      if (state[0] !== u32(walBytes, offset + 16) || state[1] !== u32(walBytes, offset + 20)) break;
      pending.set(page, offset + 24);
      if (commitSize !== 0) {
        pending.forEach(function (where, number) { committed.set(number, where); });
        pending.clear();
        sizeInPages = commitSize;
        result.commits += 1;
        result.frames = f + 1;
      }
    }
    if (!result.commits) { result.reason = 'no-commit'; return result; }

    var length = sizeInPages * pageSize;
    var out = dbBytes;
    if (dbBytes.length < length) {
      out = new Uint8Array(length);
      out.set(dbBytes);
    } else if (dbBytes.length > length) {
      out = dbBytes.subarray(0, length);
    }
    // When the image is patched in place, keep what is overwritten so that a
    // log that turns out not to fit this database can be taken out again.
    var inPlace = out.buffer === dbBytes.buffer;
    var saved = [];
    if (inPlace) saved.push([0, dbBytes.slice(0, Math.min(100, dbBytes.length))]);
    committed.forEach(function (where, number) {
      if (number <= sizeInPages) {
        var target = (number - 1) * pageSize;
        if (inPlace) saved.push([target, dbBytes.slice(target, target + pageSize)]);
        out.set(walBytes.subarray(where, where + pageSize), target);
        result.pages += 1;
      }
    });
    result.undo = function () {
      for (var i = saved.length - 1; i >= 0; i--) dbBytes.set(saved[i][1], saved[i][0]);
      saved = [];
    };
    // The image is now a plain rollback-journal database of sizeInPages pages.
    out[18] = 1;
    out[19] = 1;
    putU32(out, 28, sizeInPages);
    out[92] = out[24]; out[93] = out[25]; out[94] = out[26]; out[95] = out[27];
    result.bytes = out;
    result.merged = true;
    return result;
  }

  // ------------------------------------------------------------------ //
  // the SQLite binding (sql.js), hidden behind a tiny interface
  // ------------------------------------------------------------------ //

  var sqlPromise = null;

  /**
   * Load the SQLite WebAssembly module once. options:
   *   SQL         an already initialised sql.js module, or
   *   initSqlJs   the sql.js loader (default: the global from vendor/sql-wasm.js)
   *   locateFile  function (name) -> URL of sql-wasm.wasm (default: "vendor/" + name)
   *   wasmBinary  the bytes of sql-wasm.wasm, to avoid a fetch
   */
  function init(options) {
    var o = options || {};
    if (o.SQL) { sqlPromise = Promise.resolve(o.SQL); return sqlPromise; }
    if (sqlPromise && !o.reload) return sqlPromise;
    var loader = o.initSqlJs || root.initSqlJs;
    if (!loader && typeof require === 'function') {
      try { loader = require('./vendor/sql-wasm.js'); } catch (error) { loader = null; }
    }
    if (!loader) {
      return Promise.reject(fail('no_sqlite', 'SQLite is not loaded: include vendor/sql-wasm.js before db.js'));
    }
    var config = {};
    if (o.wasmBinary) config.wasmBinary = o.wasmBinary;
    if (o.locateFile) config.locateFile = o.locateFile;
    else if (typeof __dirname === 'string' && typeof require === 'function') {
      config.locateFile = function (name) { return require('path').join(__dirname, 'vendor', name); };
    } else {
      config.locateFile = function (name) { return 'vendor/' + name; };
    }
    sqlPromise = Promise.resolve(loader(config));
    sqlPromise.catch(function () { sqlPromise = null; });
    return sqlPromise;
  }

  function Handle(database, info, warnings) {
    this._db = database;
    this.info = info;
    this.warnings = warnings;
    this._tables = null;
  }

  /** What SQLite (or anything else) said, on one line. */
  function said(error) {
    return String(error && error.message ? error.message : error).replace(/\s+/g, ' ').trim();
  }

  /** Whatever SQLite or this file threw, as an Error with a `code`. */
  function classify(error) {
    if (error && typeof error.code === 'string') return error;
    var detail = said(error);
    if (/no such (column|table)/.test(detail)) return fail('schema', fill(MESSAGES.layout, { detail: detail }));
    return fail('corrupt', MESSAGES.corrupt + detail.replace(/[.\s]+$/, '') + '.');
  }

  /** Run a query. Returns an array of {column: value} objects. */
  Handle.prototype.query = function (sql, params) {
    var rows = [];
    var statement = null;
    try {
      statement = this._db.prepare(sql);
      if (params && params.length) statement.bind(params);
      while (statement.step()) rows.push(statement.getAsObject());
    } catch (error) {
      throw classify(error);
    } finally {
      if (statement) statement.free();
    }
    return rows;
  };

  /** Run a query, calling visit(valuesArray) per row without building objects. */
  Handle.prototype.each = function (sql, params, visit) {
    var statement = null;
    try {
      statement = this._db.prepare(sql);
      if (params && params.length) statement.bind(params);
      while (statement.step()) visit(statement.get());
    } catch (error) {
      throw classify(error);
    } finally {
      if (statement) statement.free();
    }
  };

  Handle.prototype.close = function () {
    if (this._db) { this._db.close(); this._db = null; }
  };

  Handle.prototype.tables = function () {
    if (!this._tables) {
      var names = new Set();
      this.each("SELECT name FROM sqlite_master WHERE type = 'table'", null, function (r) { names.add(r[0]); });
      this._tables = names;
    }
    return this._tables;
  };

  Handle.prototype.columns = function (table) {
    var names = new Set();
    this.each('PRAGMA table_info("' + table + '")', null, function (r) { names.add(r[1]); });
    return names;
  };

  /**
   * Open an image with sql.js. Returns {database} or {error: message}. With
   * `verify` the b-trees are walked first (PRAGMA quick_check: about a tenth
   * of a second per 100 MB), so an image whose pages do not belong together
   * is refused here rather than half-way through a query.
   */
  function tryOpen(SQL, bytes, verify) {
    // Hand SQLite a rollback-journal header: there is no -wal for it to look
    // for. The two bytes are put back afterwards.
    var b18 = bytes[18];
    var b19 = bytes[19];
    bytes[18] = 1;
    bytes[19] = 1;
    var database = null;
    try {
      database = new SQL.Database(bytes);
      database.exec('SELECT count(*) FROM sqlite_master');
      if (verify) {
        var check = database.exec('PRAGMA quick_check(1)');
        var verdict = check.length && check[0].values.length ? String(check[0].values[0][0]) : 'ok';
        if (verdict !== 'ok') throw new Error(verdict);
      }
      return { database: database };
    } catch (error) {
      if (database) { try { database.close(); } catch (ignored) { /* already unusable */ } }
      return { error: said(error) };
    } finally {
      bytes[18] = b18;
      bytes[19] = b19;
    }
  }

  /**
   * Open a database held in memory.
   *
   * source: {db: Uint8Array, wal?: Uint8Array}. `db` is the main file
   * (chat.db, sms.db, an address book); `wal` is the "-wal" file that sat
   * next to it, when there is one. The buffers are consumed: they may be
   * modified, so pass copies if you need the originals.
   *
   * Resolves to a handle {query(sql, params), each(...), close(), info,
   * warnings}. `warnings` is a list of {code, message} the page should show:
   * "wal_missing" (the database is in WAL mode and no -wal was given) and
   * "wal_invalid" (the -wal does not fit this copy of the database: it was
   * left out, and info.walMerged is false). A merged image is checked with
   * PRAGMA quick_check before it is trusted: info.walMerged is only true when
   * the image with the log applied is as sound as the file on its own (when
   * the check fails, info.walProblem holds what SQLite said).
   *
   * Rejects with an Error whose `code` is "not_sqlite" (probably an encrypted
   * backup), "too_large", "empty" or "corrupt" and whose message is written
   * for the user. Later queries on the handle throw Errors coded "corrupt"
   * or "schema"; nothing in this file throws an error without a code.
   */
  function openDatabase(source, options) {
    var toBytes = Engine._internals.toBytes;
    var bytes = source && source.db ? toBytes(source.db) : null;
    if (!bytes) return Promise.reject(fail('empty', MESSAGES.empty));
    var problem = precheck(bytes.length, bytes);
    if (problem) return Promise.reject(fail(problem.code, problem.message, { size: bytes.length }));
    var wal = source.wal ? toBytes(source.wal) : null;
    var head = sniff(bytes);
    var info = {
      bytes: bytes.length, pageSize: head.pageSize, walMode: head.walMode, walSupplied: !!(wal && wal.length),
      walMerged: false, walFrames: 0, walPages: 0
    };
    var warnings = [];
    return init(options).then(function (SQL) {
      if (wal && wal.length) {
        var merged = mergeWal(bytes, wal);
        if (merged.merged) {
          var withLog = tryOpen(SQL, merged.bytes, true);
          if (!withLog.database) {
            // Not sound with the log applied. Is the file sound without it?
            info.walProblem = withLog.error;
            merged.undo();
            var alone = tryOpen(SQL, bytes, true);
            if (alone.database) {                 // yes: the log is from another copy
              warnings.push({ code: 'wal_invalid', message: MESSAGES.wal_invalid });
              return new Handle(alone.database, info, warnings);
            }
            if (alone.error === withLog.error) {  // the very same complaint: not the log's doing
              merged = mergeWal(bytes, wal);
              withLog = tryOpen(SQL, merged.bytes, false);
              if (!withLog.database) merged.undo();
            } else {
              warnings.push({ code: 'wal_invalid', message: MESSAGES.wal_invalid });
            }
          }
          if (withLog.database) {
            info.walMerged = true;
            info.walFrames = merged.frames;
            info.walPages = merged.pages;
            return new Handle(withLog.database, info, warnings);
          }
        } else if (merged.reason !== 'empty' && merged.reason !== 'no-commit') {
          warnings.push({ code: 'wal_invalid', message: MESSAGES.wal_invalid });
        }
      } else if (head.walMode) {
        warnings.push({ code: 'wal_missing', message: MESSAGES.wal_missing });
      }
      var plain = tryOpen(SQL, bytes, false);
      if (!plain.database) throw fail('corrupt', MESSAGES.corrupt + plain.error.replace(/[.\s]+$/, '') + '.');
      return new Handle(plain.database, info, warnings);
    });
  }

  // ------------------------------------------------------------------ //
  // Messages queries
  // ------------------------------------------------------------------ //

  // Text is read as CAST(CAST(x AS TEXT) AS BLOB) and decoded here, so a cell
  // of an unexpected type, an embedded NUL or invalid UTF-8 gives exactly the
  // string the Python engine gets. Numbers are CAST to INTEGER; a REAL date
  // is truncated.
  function asText(column) { return 'CAST(CAST(' + column + ' AS TEXT) AS BLOB)'; }
  // A name (chat name, handle id, contact name or value): the first 4,096 bytes
  // of its text, enough for the 1,024 characters the engine looks at, so a
  // name of a million characters costs no more than a short one.
  function asName(column) { return 'substr(CAST(CAST(' + column + ' AS TEXT) AS BLOB), 1, 4096)'; }
  function asDate(prefix) { return 'CAST(' + prefix + 'date AS INTEGER)'; }
  // ... and NULL instead when it cannot be a date (zero, negative, after 2100),
  // so one damaged row does not become "the first message" or "the last"
  function realDate(prefix) {
    var date = asDate(prefix);
    return 'CASE WHEN ' + date + ' > 0 AND ' + date + ' <= 3124137600000000000 THEN ' + date + ' END';
  }

  function text(value) {
    if (value == null) return null;
    if (value instanceof Uint8Array) return Engine._internals.utf8(value, 0, value.length);
    return String(value);
  }

  /** What a database is: "messages", "contacts", "manifest" or "unknown". */
  function kind(handle) {
    var tables = handle.tables();
    if (tables.has('message') && tables.has('chat') && tables.has('handle') &&
        tables.has('chat_message_join')) return 'messages';
    if (tables.has('ZABCDRECORD') || (tables.has('ABPerson') && tables.has('ABMultiValue'))) return 'contacts';
    if (tables.has('Files')) return 'manifest';
    return 'unknown';
  }

  function requireMessages(handle) {
    var tables = handle.tables();
    var needed = ['chat', 'chat_message_join', 'handle', 'message'];
    for (var i = 0; i < needed.length; i++) {
      if (!tables.has(needed[i])) throw fail('schema', fill(MESSAGES.schema, { table: needed[i] }));
    }
  }

  function countableSql(columns) {
    var parts = [];
    if (columns.has('item_type')) parts.push('(m.item_type IS NULL OR CAST(m.item_type AS INTEGER) = 0)');
    if (columns.has('associated_message_type')) {
      parts.push('(m.associated_message_type IS NULL OR CAST(m.associated_message_type AS INTEGER) < 1000)');
    }
    return parts.join(' AND ') || '1';
  }

  function isoDay(unix) {
    return unix == null ? null : new Date(unix * 1000).toISOString().slice(0, 10);
  }

  function groupRows(handle) {
    var merged = new Map();
    var order = [];
    handle.each('SELECT ROWID, ' + asText('guid') + ', ' + asText('chat_identifier') + ', ' +
      asName('display_name') + ', ' + asText('service_name') + ' FROM chat WHERE CAST(style AS INTEGER) = ? ORDER BY ROWID',
    [GROUP_STYLE], function (r) {
      var row = [r[0], text(r[1]), text(r[2]), text(r[3]), text(r[4])];
      var key = row[2] ? 'i:' + row[2] : 'r:' + row[0];
      if (!merged.has(key)) { merged.set(key, []); order.push(key); }
      merged.get(key).push(row);
    });
    return order.map(function (key) { return merged.get(key); });
  }

  /**
   * Size and date range of the whole database: {messages, chats, group_chats,
   * first_unix, last_unix, first_date, last_date (UTC dates), wal_mode,
   * wal_merged, bytes}. Show it next to the chat list: it is how a partial
   * database (Messages in iCloud keeps only recent history on some devices)
   * becomes visible.
   */
  function diagnostics(handle) {
    requireMessages(handle);
    var date = realDate('');
    var row = [0, null, null];
    handle.each('SELECT COUNT(*), CAST(MIN(' + date + ') AS TEXT), CAST(MAX(' + date + ') AS TEXT) FROM message',
      null, function (r) { row = r; });
    var chats = 0;
    handle.each('SELECT COUNT(*) FROM chat', null, function (r) { chats = r[0]; });
    var first = Engine.dateToUnix(row[1]);
    var last = Engine.dateToUnix(row[2]);
    return {
      messages: row[0],
      chats: chats,
      group_chats: groupRows(handle).length,
      first_unix: first,
      last_unix: last,
      first_date: isoDay(first),
      last_date: isoDay(last),
      wal_mode: handle.info.walMode,
      wal_merged: handle.info.walMerged,
      bytes: handle.info.bytes
    };
  }

  /**
   * Every group chat (chat.style = 43), busiest first, plus diagnostics.
   * options: {contacts, me}. Returns {chats, diagnostics, warnings}; each chat
   * is {id, chat_ids, chat_identifier, guid, display_name, name,
   * participants, members, messages, first_unix, last_unix}. `display_name`
   * is the chat's own name, cleaned and masked; `name` is what to show;
   * `participants` are raw handle ids (never show those); `messages` is a
   * quick all-time count of message rows that does not look inside the text.
   */
  function listGroupChats(handle, options) {
    requireMessages(handle);
    var o = options || {};
    var I = Engine._internals;
    var me = I.ownerName(o.me);
    var names = new I.Names(me, Engine.buildContactLookup(o.contacts));
    var columns = handle.columns('message');
    var date = realDate('m.');
    var counts = new Map();
    handle.each('SELECT j.chat_id, COUNT(*), CAST(MIN(' + date + ') AS TEXT), ' +
      'CAST(MAX(' + date + ') AS TEXT) FROM chat_message_join j JOIN message m ON m.ROWID = j.message_id ' +
      'WHERE j.chat_id IN (SELECT ROWID FROM chat WHERE CAST(style AS INTEGER) = ?) AND ' + countableSql(columns) +
      ' GROUP BY j.chat_id', [GROUP_STYLE], function (r) {
      counts.set(r[0], [r[1], Engine.dateToUnix(r[2]), Engine.dateToUnix(r[3])]);
    });
    var handles = new Map();
    if (handle.tables().has('chat_handle_join')) {     // optional: without it, members are unknown
      handle.each('SELECT j.chat_id, ' + asName('h.id') + ' FROM chat_handle_join j JOIN handle h ' +
        'ON h.ROWID = j.handle_id ORDER BY j.chat_id, j.handle_id', null, function (r) {
        var id = text(r[1]);
        if (!id) return;
        if (!handles.has(r[0])) handles.set(r[0], []);
        handles.get(r[0]).push(id);
      });
    }
    var chats = groupRows(handle).map(function (group) {
      var ids = group.map(function (r) { return r[0]; });
      var display = '';
      for (var i = 0; i < group.length && !display; i++) display = I.chatLabel(group[i][3]);
      var raw = [];
      ids.forEach(function (id) { (handles.get(id) || []).forEach(function (h) { raw.push(h); }); });
      var participants = I.distinct(raw);
      var resolved = I.resolveAll(names, participants);
      var total = 0;
      var first = null;
      var last = null;
      ids.forEach(function (id) {
        var c = counts.get(id);
        if (!c) return;
        total += c[0];
        if (c[1] !== null && (first === null || c[1] < first)) first = c[1];
        if (c[2] !== null && (last === null || c[2] > last)) last = c[2];
      });
      var memberSet = new Set(resolved);
      memberSet.add(me);
      return {
        id: ids[0],
        chat_ids: ids,
        chat_identifier: group[0][2] || '',
        guid: group[0][1] || '',
        display_name: display,
        name: display || I.fallbackName(resolved, me),
        participants: participants,
        members: memberSet.size,
        messages: total,
        first_unix: first,
        last_unix: last
      };
    });
    chats.sort(function (a, b) { return (b.messages - a.messages) || (a.id - b.id); });
    return { chats: chats, diagnostics: diagnostics(handle), warnings: handle.warnings.slice() };
  }

  /**
   * Pick one chat from listGroupChats().chats by ROWID, guid, chat_identifier
   * or (part of) its name; an exact name beats a partial match. Throws an
   * Error with code "no_chat" or "ambiguous_chat" (with .matches).
   */
  function findChat(chats, query) {
    if (query && typeof query === 'object') return query;
    var wanted = String(query).trim();
    var i;
    if (/^[0-9]+$/.test(wanted)) {
      for (i = 0; i < chats.length; i++) {
        if (chats[i].chat_ids.indexOf(Number(wanted)) !== -1) return chats[i];
      }
    }
    for (i = 0; i < chats.length; i++) {
      if (wanted && (wanted === chats[i].guid || wanted === chats[i].chat_identifier)) return chats[i];
    }
    var folded = wanted.toLowerCase();
    var exact = chats.filter(function (c) { return c.name.toLowerCase() === folded; });
    var partial = chats.filter(function (c) { return folded && c.name.toLowerCase().indexOf(folded) !== -1; });
    var matches = exact.length ? exact : partial;
    if (matches.length === 1) return matches[0];
    if (!matches.length) throw fail('no_chat', fill(MESSAGES.no_chat, { query: wanted }));
    throw fail('ambiguous_chat', fill(MESSAGES.ambiguous_chat, { count: matches.length, query: wanted }),
      { matches: matches });
  }

  /**
   * All message rows of the given chat ROWIDs in the shape computeStats takes,
   * each message once, ordered by ROWID.
   *
   * `date` is a decimal string (exact nanoseconds). `text` is already the
   * message's text: message.text decoded from its raw UTF-8 bytes (so invalid
   * sequences and embedded NULs behave as in the Python engine) or, when that
   * is empty, the string inside attributedBody. The blobs themselves are not
   * kept (`attributedBody` is null), which keeps memory use down on very
   * large chats. Columns an older database lacks come back as null: the
   * schema is probed with PRAGMA table_info, never guessed from an OS version.
   * Every column is CAST to the type it should have, so a cell of another
   * type reads the same here and in the Python engine.
   */
  function loadRows(handle, chatIds) {
    var columns = handle.columns('message');
    function integer(name) { return columns.has(name) ? 'CAST(m.' + name + ' AS INTEGER)' : 'NULL'; }
    var body = columns.has('attributedBody')
      ? "CASE WHEN m.text IS NULL OR CAST(m.text AS TEXT) = '' THEN CAST(m.attributedBody AS BLOB) END" : 'NULL';
    var sql = 'SELECT m.ROWID, ' + asText('m.guid') + ', CAST(' + asDate('m.') + ' AS TEXT), ' +
      'CAST(m.is_from_me AS INTEGER), ' + asName('h.id') + ', ' + asText('m.text') + ', ' + body + ', ' +
      integer('cache_has_attachments') + ', ' + integer('item_type') + ', ' + integer('associated_message_type') +
      ', ' + (columns.has('associated_message_guid') ? asText('m.associated_message_guid') : 'NULL') +
      ' FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id WHERE m.ROWID IN ' +
      '(SELECT message_id FROM chat_message_join WHERE chat_id IN (' +
      chatIds.map(function () { return '?'; }).join(',') + ')) ORDER BY m.ROWID';
    var rows = [];
    handle.each(sql, chatIds.map(Number), function (r) {
      var message = text(r[5]);
      if (!message) message = r[6] && r[6].length ? Engine.decodeAttributedBody(r[6]) : (message === '' ? '' : null);
      rows.push({
        rowid: r[0], guid: text(r[1]), date: r[2], is_from_me: r[3], handle: text(r[4]), text: message,
        attributedBody: null, cache_has_attachments: r[7], item_type: r[8],
        associated_message_type: r[9], associated_message_guid: text(r[10])
      });
    });
    return rows;
  }

  /** {rows, chat_name, participants} for one entry of listGroupChats().chats. */
  function loadChat(handle, chat) {
    return {
      rows: loadRows(handle, chat.chat_ids),
      chat_name: chat.display_name || '',
      participants: (chat.participants || []).slice()
    };
  }

  /**
   * Stats JSON for one group chat. `chat` is an entry from listGroupChats, or
   * anything findChat accepts. options are the engine's computeStats options
   * (tz, year, all_time, start, end, now, me, contacts, label); chat_name,
   * participants and source are filled in from the database.
   */
  function statsForChat(handle, chat, options) {
    var o = Object.assign({}, options || {});
    if (!chat || typeof chat !== 'object') {
      chat = findChat(listGroupChats(handle, { contacts: o.contacts, me: o.me }).chats, chat);
    }
    var loaded = loadChat(handle, chat);
    o.chat_name = loaded.chat_name;
    o.participants = loaded.participants;
    if (!o.source) o.source = 'chat.db';
    return Engine.computeStats(loaded.rows, o);
  }

  // ------------------------------------------------------------------ //
  // contacts
  // ------------------------------------------------------------------ //

  /**
   * "First Last", else the nickname, else the organisation: as a sender
   * label, so cleaned, capped and masked like any other.
   */
  function displayName(first, last, nickname, organization) {
    var clean = function (part) { return Engine.cleanName(part, Engine.NAME_LIMIT); };
    var parts = [clean(first), clean(last)].filter(function (part) { return part; });
    var name = parts.length ? parts.join(' ') : (clean(nickname) || clean(organization));
    return Engine._internals.personLabel(name);
  }

  /**
   * Read [[identifier, name], ...] from an address-book database: a Mac
   * AddressBook-v22.abcddb or an iPhone AddressBook.sqlitedb (detected from
   * its tables). Identifiers are phone numbers and e-mail addresses as
   * stored; the engine normalises them. The name is "First Last", else the
   * nickname, else the organisation, as a sender label: cleaned, capped at 40
   * characters and masked, because people do save contacts under a number or
   * an address.
   */
  function loadContacts(handle) {
    var tables = handle.tables();
    var queries = [];
    var nameSql;
    var columns;
    if (tables.has('ZABCDRECORD')) {
      columns = handle.columns('ZABCDRECORD');
      nameSql = ['ZFIRSTNAME', 'ZLASTNAME', 'ZNICKNAME', 'ZORGANIZATION'].map(function (c) {
        return columns.has(c) ? asName('r.' + c) : 'NULL';
      }).join(', ');
      if (tables.has('ZABCDPHONENUMBER')) {
        queries.push('SELECT ' + nameSql + ', ' + asName('p.ZFULLNUMBER') + ' FROM ZABCDPHONENUMBER p ' +
          'JOIN ZABCDRECORD r ON r.Z_PK = p.ZOWNER ORDER BY r.Z_PK, p.Z_PK');
      }
      if (tables.has('ZABCDEMAILADDRESS')) {
        var address = handle.columns('ZABCDEMAILADDRESS').has('ZADDRESS')
          ? 'COALESCE(e.ZADDRESS, e.ZADDRESSNORMALIZED)' : 'e.ZADDRESSNORMALIZED';
        queries.push('SELECT ' + nameSql + ', ' + asName(address) + ' FROM ZABCDEMAILADDRESS e ' +
          'JOIN ZABCDRECORD r ON r.Z_PK = e.ZOWNER ORDER BY r.Z_PK, e.Z_PK');
      }
    } else if (tables.has('ABPerson') && tables.has('ABMultiValue')) {
      columns = handle.columns('ABPerson');
      nameSql = ['First', 'Last', 'Nickname', 'Organization'].map(function (c) {
        return columns.has(c) ? asName('p.' + c) : 'NULL';
      }).join(', ');
      queries.push('SELECT ' + nameSql + ', ' + asName('v.value') + ' FROM ABMultiValue v JOIN ABPerson p ' +
        'ON p.ROWID = v.record_id WHERE v.property IN (3, 4) ORDER BY p.ROWID, v.UID');
    } else {
      throw fail('contacts_schema', MESSAGES.contacts_schema);
    }
    var pairs = [];
    queries.forEach(function (sql) {
      handle.each(sql, null, function (r) {
        var name = displayName(text(r[0]), text(r[1]), text(r[2]), text(r[3]));
        var value = text(r[4]);
        if (name && value && Engine._internals.trim(value)) pairs.push([value, name]);
      });
    });
    return pairs;
  }

  // ------------------------------------------------------------------ //
  // finding the right files
  // ------------------------------------------------------------------ //

  function baseName(file) {
    var path = typeof file === 'string' ? file : (file.webkitRelativePath || file.name || '');
    var parts = path.split(/[\\/]/);
    return parts[parts.length - 1];
  }

  /**
   * Sort out a list of files the user dropped or picked: File objects (their
   * `name` / `webkitRelativePath` are used) or plain path strings.
   *
   * Returns {kind, messages, messagesWal, contacts, manifest, manifestPlist,
   * others}: `kind` is "backup" (hashed iPhone-backup names were found),
   * "mac" (chat.db), "file" (some other single file to try) or "none".
   * `contacts` is a list (a Mac has several address books). Entries are the
   * original items from `files`, or null.
   *
   * Inside a backup folder the page can also fetch WrappedDB.backupPaths
   * directly ("3d/3d0d...", "31/31bb...", "cd/cd47...") without listing the
   * folder, which is far faster than enumerating a whole backup.
   */
  function pickBackupFiles(files) {
    var list = Array.prototype.slice.call(files || []);
    var found = {
      kind: 'none', messages: null, messagesWal: null, contacts: [], manifest: null,
      manifestPlist: null, others: []
    };
    var hashed = false;
    var named = null;
    var namedWal = null;
    var logs = [];              // "-wal" files of databases with other names
    list.forEach(function (file) {
      var name = baseName(file);
      var lower = name.toLowerCase();
      if (lower === SMS_DB_ID) { found.messages = file; hashed = true; }
      else if (lower === SMS_WAL_ID) { found.messagesWal = file; hashed = true; }
      else if (lower === ADDRESS_BOOK_ID) { found.contacts.push(file); hashed = true; }
      else if (lower === 'chat.db' || lower === 'sms.db') { if (!named) named = file; }
      else if (lower === 'chat.db-wal' || lower === 'sms.db-wal') { if (!namedWal) namedWal = file; }
      else if (lower === 'manifest.db') found.manifest = file;
      else if (lower === 'manifest.plist') found.manifestPlist = file;
      else if (/\.abcddb$/.test(lower) || lower === 'addressbook.sqlitedb') found.contacts.push(file);
      else if (/-wal$/.test(lower)) logs.push(file);
      else if (/-(shm|journal)$/.test(lower) || lower === '.ds_store') { /* sidecars: not needed */ }
      else found.others.push(file);
    });
    if (found.messages) {
      found.kind = 'backup';
    } else if (named) {
      found.kind = 'mac';
      found.messages = named;
      found.messagesWal = namedWal;
    } else if (found.others.length === 1 && !hashed && !found.manifest && !found.manifestPlist) {
      found.kind = 'file';
      found.messages = found.others[0];
      found.others = [];
      var wanted = baseName(found.messages).toLowerCase() + '-wal';
      logs.forEach(function (file) {
        if (baseName(file).toLowerCase() === wanted) found.messagesWal = file;
      });
    } else if (hashed || found.manifest || found.manifestPlist) {
      found.kind = 'backup';      // a backup folder without a Messages database
    }
    return found;
  }

  return {
    MAX_DB_BYTES: MAX_DB_BYTES,
    SMS_DB_ID: SMS_DB_ID,
    SMS_WAL_ID: SMS_WAL_ID,
    ADDRESS_BOOK_ID: ADDRESS_BOOK_ID,
    backupPaths: backupPaths,
    init: init,
    sniff: sniff,
    precheck: precheck,
    mergeWal: mergeWal,
    openDatabase: openDatabase,
    kind: kind,
    diagnostics: diagnostics,
    listGroupChats: listGroupChats,
    findChat: findChat,
    loadRows: loadRows,
    loadChat: loadChat,
    statsForChat: statsForChat,
    loadContacts: loadContacts,
    pickBackupFiles: pickBackupFiles
  };
});
