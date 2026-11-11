/*
 * Threadback maker: the part that reads the files and counts.
 *
 * Reading a Messages database of a few hundred megabytes takes seconds, so it
 * happens off the page's main thread, in a worker: the files the person
 * picked are read, SQLite (WebAssembly) lists the group chats, and the stats
 * engine counts. Nothing is sent anywhere.
 *
 * How the worker is kept from talking to anyone. The page's own rule ("same
 * origin only", its Content-Security-Policy) does not apply to a worker that
 * is started from this file's address, and a static site cannot send that rule
 * as a header. So the page never starts this file directly. It starts a
 * worker from a blob: address, which inherits the page's policy, and that
 * worker loads this file with importScripts (see make.js). The policy then
 * binds the worker exactly as it binds the page: no request to any other
 * origin, no script from anywhere else. On top of that, once SQLite's
 * WebAssembly file has been fetched the worker removes its own network
 * functions, from the global object and from its prototypes (see lockDown),
 * before it touches a single file.
 *
 * Where a blob worker cannot be started, the page loads this same file with a
 * <script> tag and runs it on the main thread, where the page's policy holds
 * as well. Slower to look at, never less contained.
 *
 * Messages. Every request is {id, type, ...}; the answer is any number of
 *     {id, type: "progress", stage, detail}
 * and then exactly one of
 *     {id, type: "done", result}
 *     {id, type: "error", code, message, detail}
 *
 * Requests:
 *   open     {db: File, wal: File|null, contacts: [File], kind: "mac"|"backup"}
 *            -> {chats, diagnostics, warnings, contacts}
 *   chat     {chat: id from the list}        -> {people, chat_name, named}
 *   paste    {text, tz}                      -> {people, chat_name, named, format, summary, warnings}
 *   sample   {}                              -> {people, chat_name, named, summary}
 *   compute  {options: {tz, year | all_time | start + end, me, chat_name, names}}
 *            -> {stats}
 *
 * `people` is the list shown in "Tune it":
 *     [{key, name, named, handles, messages, me}]
 * `name` is what the person is called by default: a contact name, the name in
 * an export, or (for someone with no name) the masked form of their number or
 * address, "...1234". `handles` are the raw numbers and addresses behind the
 * entry. They are a hint for the person at the keyboard and exist only on
 * this device: they never go into the stats, the link or the preview.
 * `names` in compute maps a person's key to the name to show instead. Keys
 * are per raw handle for people without a name, so two numbers that end in
 * the same four digits can be told apart. Two people given the same name are
 * counted as one, because the senders are renamed before the engine sees them
 * rather than patched into its output afterwards.
 */
(function (scope) {
  'use strict';

  var inWorker = typeof scope.importScripts === 'function' && typeof scope.document === 'undefined';
  // Where this file lives. A blob worker has no address of its own to resolve
  // "engine.js" against, so the page hands the folder over.
  var BASE = typeof scope.MAKE_BASE === 'string' ? scope.MAKE_BASE : '';

  if (inWorker) {
    scope.importScripts(BASE + 'engine.js', BASE + 'vendor/sql-wasm.js', BASE + 'db.js',
      BASE + 'import-rows.js', BASE + 'sample.js');
  }

  var Engine = scope.WrappedEngine;
  var DB = scope.WrappedDB;
  var own = Object.prototype.hasOwnProperty;

  // ------------------------------------------------------------------ //
  // cutting the network off
  // ------------------------------------------------------------------ //

  var GONE = ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'WebTransport',
    'importScripts', 'Worker', 'SharedWorker', 'BroadcastChannel', 'RTCPeerConnection', 'FontFace', 'caches'];
  var locked = false;

  /**
   * Defence in depth, on top of the policy the worker inherits: after the
   * last legitimate use of the network (SQLite's WebAssembly file, from this
   * site), every function that could reach it is removed, from the global
   * object and from each object in its prototype chain, and pinned to
   * undefined so that nothing can put it back. Only ever done in a worker:
   * the page keeps its own functions, and its own policy.
   */
  function lockDown() {
    if (!inWorker || locked) return;
    locked = true;
    for (var target = scope; target && target !== Object.prototype; target = Object.getPrototypeOf(target)) {
      for (var i = 0; i < GONE.length; i++) {
        if (!own.call(target, GONE[i])) continue;
        try { delete target[GONE[i]]; } catch (error) { /* not configurable here */ }
        try {
          if (own.call(target, GONE[i])) {
            Object.defineProperty(target, GONE[i], { value: undefined, writable: false, configurable: false });
          }
        } catch (error) { /* already as closed as it gets */ }
      }
    }
    for (var j = 0; j < GONE.length; j++) {
      try {
        Object.defineProperty(scope, GONE[j], { value: undefined, writable: false, configurable: false, enumerable: false });
      } catch (error) { /* a read-only global in this browser */ }
    }
    try {
      var nav = scope.navigator;
      for (var holder = nav; holder && holder !== Object.prototype; holder = Object.getPrototypeOf(holder)) {
        if (own.call(holder, 'sendBeacon')) {
          Object.defineProperty(holder, 'sendBeacon', { value: undefined, writable: false, configurable: false });
        }
      }
    } catch (error) { /* no navigator, or no sendBeacon: nothing to remove */ }
  }

  function failure(code, message, detail) {
    var error = new Error(message);
    error.code = code;
    if (detail) error.detail = detail;
    return error;
  }

  // ------------------------------------------------------------------ //
  // reading files
  // ------------------------------------------------------------------ //

  function megabytes(bytes) {
    var mb = bytes / (1024 * 1024);
    return mb >= 10 ? Math.round(mb) + ' MB' : mb >= 0.1 ? mb.toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
  }

  /** Read a File into memory, reporting progress for big ones. */
  async function readFile(file, onProgress) {
    try {
      if (!file.stream) return new Uint8Array(await file.arrayBuffer());
      var out = new Uint8Array(file.size);
      var at = 0;
      var reader = file.stream().getReader();
      for (;;) {
        var step = await reader.read();
        if (step.done) break;
        if (at + step.value.length > out.length) {          // the file grew while we read it
          var bigger = new Uint8Array(Math.max(out.length * 2, at + step.value.length));
          bigger.set(out.subarray(0, at));
          out = bigger;
        }
        out.set(step.value, at);
        at += step.value.length;
        if (onProgress) onProgress(file.size ? Math.min(1, at / file.size) : 1);
      }
      return at === out.length ? out : out.subarray(0, at);
    } catch (error) {
      throw failure('unreadable', 'The browser could not read ' + file.name + '.',
        { file: file.name, reason: error && error.name ? error.name : String(error) });
    }
  }

  async function readHead(file) {
    try {
      return new Uint8Array(await file.slice(0, 32).arrayBuffer());
    } catch (error) {
      throw failure('unreadable', 'The browser could not read ' + file.name + '.',
        { file: file.name, reason: error && error.name ? error.name : String(error) });
    }
  }

  // ------------------------------------------------------------------ //
  // people
  // ------------------------------------------------------------------ //

  /**
   * Who a raw handle is before any renaming: {key, name, named}. `name` is
   * exactly what the engine would call them (a contact name, else the masked
   * handle). People with a contact name are keyed by that name, so someone's
   * phone number and e-mail address are one entry; everyone else is keyed by
   * the handle itself. Keys carry a prefix ("n:", "h:", "u:"), so no name,
   * whatever it is, can collide with a property every object has.
   */
  function identify(handle, names) {
    if (!handle) return { key: 'u:', name: names.handle(null), named: false };
    var name = names.handle(handle);
    var contact = Engine.contactKey(handle);
    if (contact !== null && names.table.get(contact) === name) return { key: 'n:' + name, name: name, named: true };
    // No contact name. The engine has masked the label if it held a phone number (an
    // ellipsis and four digits) or an e-mail address (the part before the @): that person
    // has no name yet. Anything else is a name as an export gave it.
    var masked = name.charAt(0) === '\u2026' || (handle.indexOf('@') !== -1 && name.indexOf('@') === -1);
    if (masked) return { key: 'h:' + (contact || handle), name: name, named: false };
    return { key: 'n:' + name, name: name, named: true };
  }

  /**
   * One reader: its open database, the chat it has loaded, and the requests
   * it answers. `send(message)` delivers an answer; `pause()` gives the screen
   * a moment to repaint between stages when this runs on the main thread.
   */
  function createSession(send, pause) {
    var state = {
      handle: null,         // open Messages database
      contacts: [],         // [[identifier, name], ...] from address books
      chats: [],            // listGroupChats().chats
      rows: null,           // rows of the chosen chat (each keeps its original handle in .h0)
      chatName: '',         // chat.display_name ("" = build one from the members)
      participants: [],     // handles from chat_handle_join
      defaults: null,       // Map(handle -> {key, name, named}): who a raw handle is by default
      names: null,          // the engine's name resolver over state.contacts
      source: 'chat.db',
      paste: null,          // {text, tz} so a new time zone can re-read zone-less dates
      stopped: false
    };

    function post(id, type, fields) {
      if (state.stopped) return;
      var message = { id: id, type: type };
      if (fields) Object.keys(fields).forEach(function (key) { message[key] = fields[key]; });
      send(message);
    }

    /** Say which stage is starting (and let the page repaint, if this is the page). */
    function stage(id, name, detail) {
      post(id, 'progress', { stage: name, detail: detail || {} });
      return pause();
    }

    /**
     * Who is in the loaded rows. Fills state.defaults and returns the list for
     * the page, busiest first, with the owner on top.
     */
    function describePeople() {
      var names = new Engine._internals.Names('', Engine.buildContactLookup(state.contacts));
      var defaults = new Map();
      var people = new Map();
      var mine = 0;

      function entry(handle) {
        var raw = handle || '';
        var who = defaults.get(raw);
        if (who === undefined) {
          who = identify(handle || null, names);
          defaults.set(raw, who);
        }
        var person = people.get(who.key);
        if (!person) {
          person = { key: who.key, name: who.name, named: who.named, handles: [], messages: 0, me: false };
          people.set(who.key, person);
        }
        if (raw && raw !== who.name && person.handles.indexOf(raw) === -1) person.handles.push(raw);
        return person;
      }

      var rows = state.rows;
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        if (row.h0 === undefined) row.h0 = typeof row.handle === 'string' ? row.handle : null;
        var kind = row.associated_message_type;
        var countable = !(kind && kind >= 1000) && !row.item_type &&
          (row.cache_has_attachments || row.keep_empty || (typeof row.text === 'string' && Engine.cleanText(row.text)));
        if (row.is_from_me) {
          if (countable) mine += 1;
        } else {
          var person = entry(row.h0);
          if (countable) person.messages += 1;
        }
      }
      state.participants.forEach(function (handle) { if (handle) entry(handle); });
      state.defaults = defaults;
      state.names = names;

      var list = Array.from(people.values()).sort(function (a, b) {
        return (b.messages - a.messages) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      });
      list.unshift({ key: 'me', name: 'Me', named: true, handles: [], messages: mine, me: true });
      return list;
    }

    async function open(id, request) {
      var file = request.db;
      var label = file.name;
      var head = await readHead(file);
      var problem = DB.precheck(file.size, head);
      if (problem) throw failure(problem.code, problem.message, { file: label, size: file.size });

      await stage(id, 'engine');
      await DB.init(BASE ? { locateFile: function (name) { return BASE + 'vendor/' + name; } } : undefined);
      lockDown();

      await stage(id, 'read', { file: label, size: megabytes(file.size), fraction: 0 });
      var last = 0;
      var bytes = await readFile(file, function (fraction) {
        if (fraction - last >= 0.04 || fraction === 1) {
          last = fraction;
          post(id, 'progress', { stage: 'read', detail: { file: label, size: megabytes(file.size), fraction: fraction } });
        }
      });
      var wal = null;
      if (request.wal) {
        await stage(id, 'read', { file: request.wal.name, size: megabytes(request.wal.size), fraction: 0 });
        wal = await readFile(request.wal);
      }

      await stage(id, 'open', { file: label });
      if (state.handle) { state.handle.close(); state.handle = null; }
      var handle = await DB.openDatabase({ db: bytes, wal: wal });
      bytes = null;
      wal = null;
      var kind = DB.kind(handle);
      if (kind !== 'messages') {
        handle.close();
        throw failure(kind === 'contacts' ? 'is_contacts' : 'schema',
          'This is a SQLite database but not a Messages database.', { file: label, kind: kind });
      }
      state.handle = handle;
      state.source = request.kind === 'backup' || /^sms/i.test(label) ? 'sms.db' : 'chat.db';

      var contacts = [];
      var warnings = [];
      var books = request.contacts || [];
      for (var i = 0; i < books.length; i++) {
        await stage(id, 'contacts', { file: books[i].name });
        try {
          var book = await DB.openDatabase({ db: await readFile(books[i]) });
          try { contacts = contacts.concat(DB.loadContacts(book)); } finally { book.close(); }
        } catch (error) {
          warnings.push({ code: 'contacts_unreadable', message: 'An address book could not be read, so it was skipped.',
            file: books[i].name });
        }
      }
      state.contacts = contacts;

      await stage(id, 'list');
      var listing = DB.listGroupChats(handle, { contacts: contacts, me: 'Me' });
      state.chats = listing.chats;
      state.rows = null;
      // Who is in each chat, for telling chats apart in the list. People without
      // a contact name are given as the raw number or address: this line is shown
      // on this device only and is never part of a recap.
      var names = new Engine._internals.Names('', Engine.buildContactLookup(contacts));
      function local(handle) {
        var who = identify(handle, names);
        return who.named ? who.name : handle;
      }
      return {
        chats: listing.chats.map(function (chat) {
          var people = Engine._internals.distinct(chat.participants.map(local));
          return {
            id: chat.id, name: chat.name, named: !!chat.display_name, members: chat.members,
            messages: chat.messages, first_unix: chat.first_unix, last_unix: chat.last_unix,
            people: people.slice(0, 8), people_more: Math.max(0, people.length - 8)
          };
        }),
        diagnostics: listing.diagnostics,
        warnings: listing.warnings.concat(warnings),
        contacts: contacts.length,
        info: handle.info
      };
    }

    async function chooseChat(id, request) {
      var chat = null;
      for (var i = 0; i < state.chats.length; i++) {
        if (state.chats[i].id === request.chat) chat = state.chats[i];
      }
      if (!chat || !state.handle) throw failure('no_chat', 'That chat is no longer loaded.');
      await stage(id, 'rows', { messages: chat.messages });
      var loaded = DB.loadChat(state.handle, chat);
      state.rows = loaded.rows;
      state.chatName = loaded.chat_name;
      state.participants = loaded.participants;
      state.paste = null;
      return { people: describePeople(), chat_name: chat.name, named: !!loaded.chat_name, rows: loaded.rows.length };
    }

    function readPaste(text, tz) {
      var parsed = scope.WrappedImport.parseExport(text, { tz: tz || undefined });
      state.rows = parsed.rows;
      state.chatName = '';
      // An export has no member list: the people who wrote, busiest first, stand
      // in for it (it is what an unnamed chat's name is built from).
      var counts = new Map();
      parsed.rows.forEach(function (row) {
        if (!row.is_from_me && row.handle) counts.set(row.handle, (counts.get(row.handle) || 0) + 1);
      });
      state.participants = Array.from(counts.keys()).sort(function (a, b) {
        return (counts.get(b) - counts.get(a)) || (a < b ? -1 : a > b ? 1 : 0);
      });
      state.paste = { text: text, tz: tz || '' };
      state.source = 'export';
      return parsed;
    }

    async function paste(id, request) {
      lockDown();
      await stage(id, 'parse');
      var parsed = readPaste(String(request.text || ''), request.tz);
      if (!parsed.rows.length) {
        state.rows = null;
        throw failure('paste_empty', 'No messages could be read from this text.',
          { warnings: parsed.warnings, format: parsed.format });
      }
      var people = describePeople();
      var I = Engine._internals;
      return {
        people: people,
        chat_name: I.fallbackName(I.resolveAll(state.names, state.participants), 'Me'),
        named: false,
        format: parsed.format,
        summary: parsed.summary,
        warnings: parsed.warnings,
        rows: parsed.rows.length
      };
    }

    async function sample(id) {
      lockDown();
      await stage(id, 'sample');
      var built = scope.WrappedSample.build({});
      state.rows = built.rows;
      state.chatName = built.chat_name;
      state.participants = built.participants;
      state.paste = null;
      state.contacts = [];
      state.source = 'sample';
      var first = null;
      var last = null;
      built.rows.forEach(function (row) {
        var unix = Engine.dateToUnix(row.date);
        if (unix === null) return;
        if (first === null || unix < first) first = unix;
        if (last === null || unix > last) last = unix;
      });
      var people = describePeople();
      return {
        people: people,
        chat_name: built.chat_name,
        named: true,
        year: built.year,
        summary: {
          messages: people.reduce(function (total, p) { return total + p.messages; }, 0),
          senders: people.length, first_unix: first, last_unix: last
        },
        rows: built.rows.length
      };
    }

    async function compute(id, request) {
      var o = request.options || {};
      if (!state.rows) throw failure('no_rows', 'Choose a chat first.');
      if (state.paste && (o.tz || '') !== state.paste.tz) {
        readPaste(state.paste.text, o.tz);              // zone-less dates depend on the zone
        describePeople();
      }
      await stage(id, 'count', { rows: state.rows.length });

      // Rename (and so merge) senders before counting: every row gets its final
      // display name as its handle, and the engine is given no contact table.
      // (The engine still masks anything that looks like a phone number or an
      // e-mail address, so typing one as a name cannot put it into the link.)
      var renames = new Map();
      if (o.names && typeof o.names === 'object') {
        Object.keys(o.names).forEach(function (key) {
          if (typeof o.names[key] === 'string') renames.set(key, Engine._internals.trim(o.names[key]));
        });
      }
      var defaults = state.defaults;
      var finals = new Map();
      function finalName(handle) {
        var raw = handle || '';
        var name = finals.get(raw);
        if (name === undefined) {
          var who = defaults.get(raw) || identify(handle || null, state.names);
          name = renames.get(who.key) || who.name;
          finals.set(raw, name);
        }
        return name;
      }
      var rows = state.rows;
      for (var i = 0; i < rows.length; i++) {
        if (!rows[i].is_from_me) rows[i].handle = finalName(rows[i].h0);
      }
      var options = {
        tz: o.tz || undefined,
        me: Engine._internals.trim(typeof o.me === 'string' ? o.me : '') || 'Me',
        chat_name: typeof o.chat_name === 'string' ? o.chat_name : state.chatName,
        participants: state.participants.filter(Boolean).map(finalName),
        source: state.source
      };
      if (o.now != null) options.now = o.now;
      if (o.all_time) options.all_time = true;
      else if (o.start || o.end) { options.start = o.start || undefined; options.end = o.end || undefined; }
      else if (o.year != null) options.year = o.year;
      return { stats: Engine.computeStats(rows, options) };
    }

    var handlers = new Map([['open', open], ['chat', chooseChat], ['paste', paste], ['sample', sample], ['compute', compute]]);

    function receive(request) {
      request = request || {};
      var id = request.id;
      var handler = handlers.get(request.type);
      if (!handler) { post(id, 'error', { code: 'unknown_request', message: 'Unknown request.' }); return; }
      Promise.resolve()
        .then(function () { return handler(id, request); })
        .then(function (result) { post(id, 'done', { result: result }); })
        .catch(function (error) {
          post(id, 'error', {
            code: (error && error.code) || (error instanceof RangeError ? 'range' : 'internal'),
            message: (error && error.message) || String(error),
            detail: (error && error.detail) || null
          });
        });
    }

    function stop() {
      state.stopped = true;
      try { if (state.handle) state.handle.close(); } catch (error) { /* already closed */ }
      state.handle = null;
      state.rows = null;
    }

    return { receive: receive, stop: stop };
  }

  if (inWorker) {
    var session = createSession(function (message) { scope.postMessage(message); }, function () { return undefined; });
    scope.onmessage = function (event) { session.receive(event.data); };
    scope.postMessage({ type: 'hello' });       // everything loaded: the page may start asking
  } else {
    // On the main thread: the page calls this instead of posting to a worker.
    scope.WrappedMakeLocal = {
      open: function (deliver) {
        var local = createSession(
          function (message) { setTimeout(function () { deliver(message); }, 0); },
          function () { return new Promise(function (resolve) { setTimeout(resolve, 30); }); });
        return { send: function (request) { local.receive(request); }, stop: local.stop };
      }
    };
  }
})(typeof self !== 'undefined' ? self : this);
