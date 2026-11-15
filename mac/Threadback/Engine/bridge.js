/*
 * Threadback for Mac: the glue between the shared JavaScript engine and Swift.
 *
 * Loaded into a JavaScriptCore context AFTER fflate.min.js, web/make/engine.js
 * and web/make/db.js (bundled unchanged from the repository). It adds:
 *
 *  - TextEncoder / TextDecoder when the context has none (plain JavaScriptCore
 *    has no Web APIs). They follow the WHATWG Encoding Standard for UTF-8,
 *    which is what Node and browsers use, so the engine reads text exactly as
 *    it does in the web maker and in the conformance tests.
 *  - NativeHandle: the `handle` object db.js expects (each/query/tables/columns),
 *    backed by Swift's SQLite reader through the global function
 *    __tbSQL(token, sql, params) -> {columns: [...], rows: [[...], ...]}
 *    (BLOBs arrive as Uint8Array, NULL as null).
 *  - ThreadbackBridge: a few JSON-in / JSON-out entry points for Swift.
 *
 * Nothing in here counts anything: every statistic comes from engine.js.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- //
  // UTF-8, per the WHATWG Encoding Standard
  // ---------------------------------------------------------------- //

  function utf8Encode(text) {
    var s = String(text);
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
        var d = s.charCodeAt(i + 1);
        if (d >= 0xDC00 && d <= 0xDFFF) {
          c = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00);
          i++;
        } else {
          c = 0xFFFD;
        }
      } else if (c >= 0xD800 && c <= 0xDFFF) {
        c = 0xFFFD;                       // a lone surrogate
      }
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      } else if (c < 0x10000) {
        out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      } else {
        out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
    }
    return new Uint8Array(out);
  }

  // The decoder algorithm of the Encoding Standard, section "UTF-8 decoder":
  // an invalid sequence becomes one U+FFFD per maximal subpart.
  function utf8Decode(bytes, fatal, ignoreBOM) {
    var codePoint = 0, needed = 0, seen = 0, lower = 0x80, upper = 0xBF;
    var units = [];
    var chunks = [];
    function emit(cp) {
      if (cp > 0xFFFF) {
        cp -= 0x10000;
        units.push(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
      } else {
        units.push(cp);
      }
      if (units.length > 8192) { chunks.push(String.fromCharCode.apply(null, units)); units = []; }
    }
    function error() {
      if (fatal) { var e = new TypeError('The encoded data was not valid utf-8'); throw e; }
      emit(0xFFFD);
    }
    var n = bytes.length;
    for (var i = 0; i <= n; i++) {
      if (i === n) {
        if (needed !== 0) { needed = 0; error(); }
        break;
      }
      var b = bytes[i];
      if (needed === 0) {
        if (b <= 0x7F) { emit(b); continue; }
        if (b >= 0xC2 && b <= 0xDF) { needed = 1; codePoint = b & 0x1F; }
        else if (b >= 0xE0 && b <= 0xEF) {
          if (b === 0xE0) lower = 0xA0;
          if (b === 0xED) upper = 0x9F;
          needed = 2; codePoint = b & 0xF;
        } else if (b >= 0xF0 && b <= 0xF4) {
          if (b === 0xF0) lower = 0x90;
          if (b === 0xF4) upper = 0x8F;
          needed = 3; codePoint = b & 0x7;
        } else { error(); }
        continue;
      }
      if (b < lower || b > upper) {
        codePoint = 0; needed = 0; seen = 0; lower = 0x80; upper = 0xBF;
        i--;                              // prepend the byte back to the stream
        error();
        continue;
      }
      lower = 0x80; upper = 0xBF;
      codePoint = (codePoint << 6) | (b & 0x3F);
      seen++;
      if (seen !== needed) continue;
      var cp = codePoint;
      codePoint = 0; needed = 0; seen = 0;
      emit(cp);
    }
    chunks.push(String.fromCharCode.apply(null, units));
    var text = chunks.join('');
    if (!ignoreBOM && text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return text;
  }

  if (typeof root.TextEncoder === 'undefined') {
    root.TextEncoder = function TextEncoder() {};
    root.TextEncoder.prototype.encode = function (text) { return utf8Encode(text === undefined ? '' : text); };
    root.TextEncoder.prototype.encoding = 'utf-8';
  }
  if (typeof root.TextDecoder === 'undefined') {
    root.TextDecoder = function TextDecoder(label, options) {
      var o = options || {};
      this.fatal = !!o.fatal;
      this.ignoreBOM = !!o.ignoreBOM;
    };
    root.TextDecoder.prototype.decode = function (bytes) {
      if (bytes == null) return '';
      var view = bytes instanceof Uint8Array ? bytes
        : (ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          : new Uint8Array(bytes));
      return utf8Decode(view, this.fatal, this.ignoreBOM);
    };
  }

  // ---------------------------------------------------------------- //
  // the database handle db.js expects, backed by Swift
  // ---------------------------------------------------------------- //

  var Engine = root.WrappedEngine;
  var DB = root.WrappedDB;

  function coded(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  function NativeHandle(token, info) {
    this._token = token;
    this.info = info || { walMode: false, walMerged: false, bytes: 0 };
    this.warnings = [];
    this._tables = null;
  }

  NativeHandle.prototype._run = function (sql, params) {
    var result;
    try {
      result = root.__tbSQL(this._token, sql, params || []);
    } catch (error) {
      var detail = String(error && error.message ? error.message : error).replace(/\s+/g, ' ').trim();
      if (/no such (column|table)/.test(detail)) throw coded('schema', 'This is not a Messages database this app can read (' + detail + ').');
      throw coded('corrupt', 'SQLite could not read this database: ' + detail);
    }
    return result;
  };

  NativeHandle.prototype.each = function (sql, params, visit) {
    var rows = this._run(sql, params).rows;
    for (var i = 0; i < rows.length; i++) visit(rows[i]);
  };

  NativeHandle.prototype.query = function (sql, params) {
    var result = this._run(sql, params);
    return result.rows.map(function (r) {
      var o = {};
      for (var i = 0; i < result.columns.length; i++) o[result.columns[i]] = r[i];
      return o;
    });
  };

  NativeHandle.prototype.close = function () {};

  NativeHandle.prototype.tables = function () {
    if (!this._tables) {
      var names = new Set();
      this.each("SELECT name FROM sqlite_master WHERE type = 'table'", null, function (r) { names.add(r[0]); });
      this._tables = names;
    }
    return this._tables;
  };

  NativeHandle.prototype.columns = function (table) {
    var names = new Set();
    this.each('PRAGMA table_info("' + table + '")', null, function (r) { names.add(r[1]); });
    return names;
  };

  // ---------------------------------------------------------------- //
  // entry points for Swift (JSON strings in, JSON strings out)
  // ---------------------------------------------------------------- //

  function handleFor(token, infoJSON) {
    return new NativeHandle(token, infoJSON ? JSON.parse(infoJSON) : null);
  }

  function errorJSON(error) {
    return JSON.stringify({ error: { code: (error && error.code) || 'error', message: String(error && error.message || error) } });
  }

  root.ThreadbackBridge = {
    engineVersion: Engine.GENERATOR,

    /** [[identifier, name], ...] from one address-book database. */
    loadContacts: function (token) {
      try { return JSON.stringify(DB.loadContacts(handleFor(token))); } catch (e) { return errorJSON(e); }
    },

    /** {chats, diagnostics} for a Messages database. opts: {contacts, me}. */
    listChats: function (token, infoJSON, optsJSON) {
      try {
        var listing = DB.listGroupChats(handleFor(token, infoJSON), JSON.parse(optsJSON || '{}'));
        return JSON.stringify({ chats: listing.chats, diagnostics: listing.diagnostics });
      } catch (e) { return errorJSON(e); }
    },

    /**
     * Stats for one chat, as canonical JSON (what `python3 -m wrapped stats
     * --compact` prints). `chat` is a ROWID, guid, identifier or name, exactly
     * as `wrapped stats CHAT` takes it. opts: the engine's computeStats options
     * (tz, year, all_time, start, end, me, contacts). shortNames: apply the
     * first-name rule (the CLI's default; --full-names turns it off).
     */
    stats: function (token, infoJSON, chat, optsJSON, shortNames) {
      try {
        var opts = JSON.parse(optsJSON || '{}');
        var handle = handleFor(token, infoJSON);
        var stats = DB.statsForChat(handle, chat, opts);
        if (shortNames) stats = Engine.shortNames(stats, opts.me);
        return Engine.canonicalJson(stats);
      } catch (e) { return errorJSON(e); }
    },

    /** "First Last", else nickname, else organisation, as db.js labels address-book rows. */
    contactLabel: function (first, last, nickname, organization) {
      var clean = function (part) { return Engine.cleanName(part || '', Engine.NAME_LIMIT); };
      var parts = [clean(first), clean(last)].filter(function (part) { return part; });
      var name = parts.length ? parts.join(' ') : (clean(nickname) || clean(organization));
      return name ? Engine._internals.personLabel(name) : '';
    },

    /**
     * Stats for the group chat that has `chatId` (a chat.ROWID) among its rows. Unlike
     * stats(), never falls back to matching a name: an id that is not there is an error.
     */
    statsById: function (token, infoJSON, chatId, optsJSON, shortNames) {
      try {
        var opts = JSON.parse(optsJSON || '{}');
        var handle = handleFor(token, infoJSON);
        var id = Number(chatId);
        var listing = DB.listGroupChats(handle, { contacts: opts.contacts, me: opts.me });
        var chat = null;
        for (var i = 0; i < listing.chats.length && !chat; i++) {
          if (listing.chats[i].chat_ids.indexOf(id) !== -1) chat = listing.chats[i];
        }
        if (!chat) throw coded('no_chat', 'that group chat is no longer in Messages');
        var stats = DB.statsForChat(handle, chat, opts);
        if (shortNames) stats = Engine.shortNames(stats, opts.me);
        return Engine.canonicalJson(stats);
      } catch (e) { return errorJSON(e); }
    },

    shortNames: function (statsJSON, me) {
      try { return Engine.canonicalJson(Engine.shortNames(JSON.parse(statsJSON), me)); } catch (e) { return errorJSON(e); }
    },

    /** The share URL (4,800-character budget; message text only with quotes). */
    buildLink: function (statsJSON, quotes) {
      try { return JSON.stringify({ url: Engine.buildLink(JSON.parse(statsJSON), { quotes: !!quotes }) }); } catch (e) { return errorJSON(e); }
    },

    /** The stats inside a share URL, as canonical JSON. */
    statsFromUrl: function (url) {
      try { return Engine.canonicalJson(Engine.statsFromUrl(url)); } catch (e) { return errorJSON(e); }
    },

    /** message.text if non-empty, else the string inside attributedBody; cleaned like the stats see it. */
    decodeText: function (text, body) {
      var t = typeof text === 'string' ? text : '';
      if (!t && body && body.length) t = Engine.decodeAttributedBody(body) || '';
      return Engine.cleanText(t);
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
