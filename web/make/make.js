/*
 * Threadback maker: the controller for make/index.html.
 *
 * Four steps on one page: add your messages (a Mac's chat.db, an iPhone backup, a pasted
 * export, or the invented sample chat), choose the chat, tune it, and get the recap link.
 * The heavy work (SQLite, counting) happens in worker.js; this file is the interface and
 * builds the links with the engine's own fitLink(), so the 4,800-character budget and the
 * "no quotes" rule are the ones in docs/SCHEMA.md section 5.
 *
 * Privacy rules this file keeps:
 *  - nothing is requested from any other origin, and nothing is stored;
 *  - message text goes into the link only after the person switches it on (default off);
 *  - the preview frame is given exactly the payload of the link, never more: the story in
 *    it can copy and share its own link, so what it holds is what could be sent;
 *  - people go by first names unless the person asks for the full ones (a full name in an
 *    address book is the owner's own label);
 *  - raw phone numbers and e-mail addresses are shown on this device as a hint for naming
 *    people and telling chats apart, and never enter the stats, the link or the preview.
 *
 * Every string put into the page goes through textContent. The only innerHTML is the
 * constant icon markup below.
 */
(function (root) {
  'use strict';

  var doc = root.document;

  // Opened inside our own preview frame (the story's "Make one for your chat" link was
  // tapped there): stay inert. The outer page puts the story back.
  try {
    if (root.parent !== root && root.parent.WrappedMake) return;
  } catch (error) { /* a foreign parent: carry on as a normal page */ }

  var Config = root.WrappedConfig;
  var Engine = root.WrappedEngine;
  var DB = root.WrappedDB;
  var Glyphs = root.WrappedGlyphs;

  var MAX_LINK = Config.MAX_URL_LENGTH;
  var HELP_URL = 'https://github.com/averyhsu/imessage-wrap/blob/main/docs/MAC.md';
  var DEVICE_TZ = (function () {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (error) { return ''; }
  })();
  var REDUCED = !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);

  var S = {
    tab: 'mac',
    files: null,        // {db, wal, contacts: [File], kind: "mac" | "backup", backups}
    source: null,       // {kind, title, detail, notes: [{text, quiet, action}]}
    chats: [],
    chat: null,         // {id, name, named, members, messages, last_unix, single}
    people: [],         // from the worker: [{key, name, named, handles, messages, me}]
    names: {},          // person key -> the name to show for them (typed, or a first name)
    shortened: null,    // person key -> {short, before}: who was switched to a first name
    me: 'Me',
    chatName: '',       // typed chat name ("" = the chat's own)
    period: 'year',
    start: '',
    end: '',
    tz: DEVICE_TZ,
    created: false,
    copied: false,
    stats: null,
    statsJson: '',
    fits: null,         // {off, on}: the link without and with message text
    quotes: false,
    previewUrl: '',
    rechoose: null,
    bigPaste: null      // an export file too large to show in the box
  };

  // -- small helpers --------------------------------------------------------------------

  function $(id) { return doc.getElementById(id); }

  function el(tag, className, text) {
    var node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function num(n) { return Number(n || 0).toLocaleString('en-US'); }

  function plural(n, one, many) { return num(n) + ' ' + (n === 1 ? one : (many || one + 's')); }

  function problem(code, message, detail) {
    var error = new Error(message || code);
    error.code = code;
    error.detail = detail || null;
    return error;
  }

  var dayFormats = {};
  function dayFormat(tz) {
    var key = tz || 'local';
    if (!dayFormats[key]) {
      var options = { month: 'short', day: 'numeric', year: 'numeric' };
      if (tz) options.timeZone = tz;
      try { dayFormats[key] = new Intl.DateTimeFormat('en-US', options); }
      catch (error) { dayFormats[key] = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
    }
    return dayFormats[key];
  }

  /** Unix seconds -> "Nov 10, 2026" in the chosen time zone. */
  function day(unix) {
    return unix == null ? '' : dayFormat(S.tz).format(new Date(unix * 1000));
  }

  /** "2026-11-10" -> "Nov 10, 2026". */
  function isoDay(text) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text || '');
    if (!m) return text || '';
    return dayFormat('UTC').format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))));
  }

  function span(start, end) {
    if (!start || !end) return '';
    if (start === end) return isoDay(start);
    var a = isoDay(start);
    var b = isoDay(end);
    if (start.slice(0, 4) === end.slice(0, 4)) a = a.replace(/, \d{4}$/, '');
    return a + ' \u2013 ' + b;
  }

  /** Today's {year, month} in the chosen time zone. */
  function today() {
    var now = new Date();
    try {
      var parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: S.tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(now).split('-');
      return { year: Number(parts[0]), month: Number(parts[1]) };
    } catch (error) {
      return { year: now.getFullYear(), month: now.getMonth() + 1 };
    }
  }

  function yearOf(unix) {
    try {
      return Number(new Intl.DateTimeFormat('en-US', { timeZone: S.tz || undefined, year: 'numeric' }).format(new Date(unix * 1000)));
    } catch (error) {
      return new Date(unix * 1000).getFullYear();
    }
  }

  function initial(name) {
    var chars = Array.from(String(name || '').replace(/^[\s\u2026+(]+/, ''));
    var first = chars[0] || '#';
    return /[0-9]/.test(first) ? '#' : first.toUpperCase();
  }

  var statusText = '';
  function say(text) {
    if (text === statusText) return;
    statusText = text;
    $('status').textContent = text;
  }

  // -- icons (constants; see also ../js/glyphs.js) --------------------------------------

  var LINE = ' fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"';
  function svg(body) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + body + '</svg>';
  }
  var ICONS = {
    lock: svg('<rect x="4.500" y="10.500" width="15" height="10.500" rx="3" fill="currentColor"/><path d="M8 10.500V7.500a4 4 0 0 1 8 0v3"' + LINE + '/>'),
    laptop: svg('<rect x="4" y="4.500" width="16" height="11.500" rx="2.400"' + LINE + '/><path d="M1.800 19.800h20.400"' + LINE + '/>'),
    phone: svg('<rect x="6.500" y="2.500" width="11" height="19" rx="3.200"' + LINE + '/><path d="M10.600 5.700h2.800"' + LINE + '/>'),
    clipboard: svg('<rect x="5" y="4.500" width="14" height="17" rx="2.800"' + LINE + '/><rect x="8.800" y="2.300" width="6.400" height="4.400" rx="1.500" fill="currentColor"/><path d="M9 12h6M9 16h3.500"' + LINE + '/>'),
    database: svg('<ellipse cx="12" cy="6" rx="7.500" ry="3.300"' + LINE + '/><path d="M4.500 6v6c0 1.800 3.400 3.300 7.500 3.300s7.500-1.500 7.500-3.300V6M4.500 12v6c0 1.800 3.400 3.300 7.500 3.300s7.500-1.500 7.500-3.300v-6"' + LINE + '/>'),
    folder: svg('<path d="M3 7.500A2.500 2.500 0 0 1 5.500 5h3.600c.7 0 1.300.3 1.800.8l1.200 1.400h6.400A2.500 2.500 0 0 1 21 9.700v7.800a2.500 2.500 0 0 1-2.500 2.500h-13A2.500 2.500 0 0 1 3 17.500z"' + LINE + '/>'),
    copy: svg('<rect x="8.500" y="8.500" width="11.500" height="12" rx="2.600"' + LINE + '/><path d="M15.500 5.300V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8.500a2 2 0 0 0 2 2h.300"' + LINE + '/>'),
    sparkle: svg('<path fill="currentColor" d="M10 2.500c.6 4.700 2.800 6.900 7.500 7.500-4.700.6-6.900 2.800-7.500 7.500-.6-4.700-2.800-6.900-7.500-7.500 4.700-.6 6.900-2.800 7.500-7.500zM18.500 14.500c.3 2 1.200 2.900 3.200 3.200-2 .3-2.900 1.200-3.200 3.200-.3-2-1.200-2.900-3.200-3.200 2-.3 2.900-1.200 3.200-3.200z"/>'),
    search: svg('<circle cx="10.500" cy="10.500" r="6.500"' + LINE + '/><path d="m15.600 15.600 5 5"' + LINE + '/>'),
    warning: svg('<path d="M12 3.800 2.800 19.800h18.400z"' + LINE + '/><path d="M12 10v4.300"' + LINE + '/><circle cx="12" cy="17" r="1.200" fill="currentColor"/>'),
    info: svg('<circle cx="12" cy="12" r="9"' + LINE + '/><path d="M12 11v5.500"' + LINE + '/><circle cx="12" cy="7.600" r="1.200" fill="currentColor"/>'),
    people: svg('<circle cx="9" cy="8" r="3.400"' + LINE + '/><path d="M2.800 19.500c.5-3.400 3-5.300 6.200-5.300s5.700 1.900 6.200 5.300M15.500 4.900a3.400 3.400 0 0 1 0 6.300M17.700 14.600c1.900.7 3.200 2.300 3.500 4.900"' + LINE + '/>'),
    chart: svg('<path d="M4.500 20V11M10 20V4.500M15.500 20v-6.500M21 20V8.500"' + LINE + ' stroke-width="2.800"/>'),
    quote: svg('<path d="M12 3.500c5 0 9 3.300 9 7.500s-4 7.500-9 7.500c-.9 0-1.800-.1-2.600-.3-1.200.9-2.700 1.500-4.400 1.600.6-.9 1.100-1.900 1.300-2.900C4.300 15.500 3 13.400 3 11c0-4.200 4-7.500 9-7.500z"' + LINE + '/><path d="M8.500 9.500h7M8.500 12.800h4.500"' + LINE + '/>')
  };

  function icon(name) {
    var holder = el('span', 'mk-ico');
    holder.setAttribute('aria-hidden', 'true');
    holder.innerHTML = ICONS[name] || (Glyphs && Glyphs.ICONS[name]) || '';
    return holder;
  }

  function setIcon(holder, name) {
    holder.innerHTML = ICONS[name] || (Glyphs && Glyphs.ICONS[name]) || '';
    holder.setAttribute('data-icon', name);
    holder.setAttribute('aria-hidden', 'true');
  }

  // -- the worker -----------------------------------------------------------------------

  var worker = null;
  var nextId = 1;
  var waiting = {};

  function stopWorker() {
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      worker = null;
    }
    waiting = {};
  }

  function startWorker() {
    stopWorker();
    worker = new Worker('worker.js');
    worker.onmessage = function (event) {
      var message = event.data || {};
      var entry = waiting[message.id];
      if (!entry) return;
      if (message.type === 'progress') {
        if (entry.progress) entry.progress(message.stage, message.detail || {});
        return;
      }
      delete waiting[message.id];
      if (message.type === 'done') entry.resolve(message.result);
      else entry.reject(problem(message.code, message.message, message.detail));
    };
    worker.onerror = function (event) {
      if (event && event.preventDefault) event.preventDefault();
      var all = waiting;
      waiting = {};
      Object.keys(all).forEach(function (id) { all[id].reject(problem('worker', (event && event.message) || '')); });
    };
  }

  /** Send a request to the worker. Resolves with its result, rejects with a coded Error. */
  function ask(type, fields, progress) {
    return new Promise(function (resolve, reject) {
      try {
        if (!worker) startWorker();
        var id = nextId++;
        var message = { id: id, type: type };
        Object.keys(fields || {}).forEach(function (key) { message[key] = fields[key]; });
        waiting[id] = { resolve: resolve, reject: reject, progress: progress };
        worker.postMessage(message);
      } catch (error) {
        reject(problem('worker', error && error.message));
      }
    });
  }

  // -- "working" and error boxes --------------------------------------------------------

  function working(slot, text, fraction) {
    var box = $('work-' + slot);
    if (!box.firstChild) {
      var dots = el('span', 'mk-typing');
      dots.setAttribute('aria-hidden', 'true');
      dots.appendChild(el('i'));
      dots.appendChild(el('i'));
      dots.appendChild(el('i'));
      var words = el('span', 'mk-work__text');
      words.appendChild(el('span', 'mk-work__label'));
      var bar = el('span', 'mk-work__bar');
      bar.appendChild(el('i'));
      words.appendChild(bar);
      box.appendChild(dots);
      box.appendChild(words);
    }
    var fresh = box.hidden;
    box.hidden = false;
    box.querySelector('.mk-work__label').textContent = text;
    var track = box.querySelector('.mk-work__bar');
    track.hidden = fraction == null;
    if (fraction != null) track.firstChild.style.transform = 'scaleX(' + Math.max(0.02, Math.min(1, fraction)).toFixed(3) + ')';
    if (fresh) {
      box.closest('.mk-step').classList.add('is-busy');
      keepInView(box);
    }
    say(text);
  }

  function idle(slot) {
    var box = $('work-' + slot);
    box.hidden = true;
    box.closest('.mk-step').classList.remove('is-busy');
  }

  /** Scroll just enough to show `node` when it is off screen. */
  function keepInView(node) {
    var rect = node.getBoundingClientRect();
    if (rect.top < 8 || rect.bottom > root.innerHeight - 8) {
      node.scrollIntoView({ block: 'center', behavior: REDUCED ? 'auto' : 'smooth' });
    }
  }

  /** Progress messages from the worker, in plain words. */
  function progressFor(slot) {
    return function (stage, detail) {
      if (stage === 'engine') working(slot, 'Loading the database reader\u2026');
      else if (stage === 'read') working(slot, 'Reading ' + detail.file + ' (' + detail.size + ')\u2026', detail.fraction);
      else if (stage === 'open') working(slot, 'Opening the database\u2026');
      else if (stage === 'contacts') working(slot, 'Reading contact names\u2026');
      else if (stage === 'list') working(slot, 'Finding your group chats\u2026');
      else if (stage === 'rows') working(slot, 'Reading ' + plural(detail.messages, 'message') + '\u2026');
      else if (stage === 'parse') working(slot, 'Reading your export\u2026');
      else if (stage === 'sample') working(slot, 'Making up a group chat\u2026');
      else if (stage === 'count') working(slot, 'Counting ' + plural(detail.rows, 'message and tapback', 'messages and tapbacks') + '\u2026');
    };
  }

  /** Parts of a sentence: strings, {code}, {link, text} or {b}. */
  function rich(target, parts) {
    (Array.isArray(parts) ? parts : [parts]).forEach(function (part) {
      if (typeof part === 'string') target.appendChild(doc.createTextNode(part));
      else if (part.code) target.appendChild(el('code', '', part.code));
      else if (part.b) target.appendChild(el('b', '', part.b));
      else if (part.link) {
        var a = el('a', '', part.text);
        a.href = part.link;
        a.rel = 'noopener';
        a.target = '_blank';
        target.appendChild(a);
      }
    });
    return target;
  }

  /** spec: {title, body: [sentence parts...], actions: [{label, run, primary}], info} */
  function showError(slot, spec) {
    var box = $('error-' + slot);
    box.textContent = '';
    box.classList.toggle('is-info', !!spec.info);
    var title = el('h3');
    title.appendChild(icon(spec.info ? 'info' : 'warning'));
    title.appendChild(el('span', '', spec.title));
    box.appendChild(title);
    (spec.body || []).forEach(function (parts) { box.appendChild(rich(el('p'), parts)); });
    if (spec.actions && spec.actions.length) {
      var row = el('div', 'mk-alert__actions');
      spec.actions.forEach(function (action) {
        var button = el('button', 'mk-btn mk-btn--small' + (action.primary ? ' mk-btn--primary' : ''), action.label);
        button.type = 'button';
        button.addEventListener('click', action.run);
        row.appendChild(button);
      });
      box.appendChild(row);
    }
    box.hidden = false;
    keepInView(box);
  }

  function clearError(slot) {
    var box = $('error-' + slot);
    box.hidden = true;
    box.textContent = '';
  }

  /** Turn a failure into a title, an explanation and a next step. */
  function explain(error, context) {
    var code = error && error.code;
    var detail = (error && error.detail) || {};
    var c = context || {};
    var file = detail.file || (c.file && c.file.name) || 'That file';
    if (code === 'not_sqlite' && c.hashed) {
      return {
        title: 'This iPhone backup is encrypted',
        body: [
          'An encrypted backup cannot be read in a browser. Make one without encryption: connect the iPhone, open Finder (on a Mac) or Apple Devices (on Windows), untick \u201CEncrypt local backup\u201D and back up again. Then choose the new backup here.',
          'On a Mac that is signed in to Messages you do not need a backup at all: use \u201CA Mac\u201D instead.'
        ],
        actions: [{ label: 'Use a Mac instead', run: function () { clearError('source'); selectTab('mac', true); } }]
      };
    }
    if (code === 'not_sqlite') {
      return {
        title: 'That is not a Messages database',
        body: [[{ b: file }, ' is not the kind of file this page can read. On a Mac the one you want is called ', { code: 'chat.db' },
          ' and sits in ', { code: '~/Library/Messages' }, '. In an iPhone backup it is ', { code: '3d/3d0d7e5f\u20263d28' }, '.']]
      };
    }
    if (code === 'is_contacts') {
      return {
        title: 'That is an address book, not your messages',
        body: [[{ b: file }, ' holds contact names. Add it together with ', { code: 'chat.db' }, ' and ', { code: 'chat.db-wal' },
          ' from ', { code: '~/Library/Messages' }, '.']]
      };
    }
    if (code === 'schema') {
      return {
        title: 'That is a database, but not the Messages one',
        body: [[{ b: file }, ' does not contain any conversations. The file to add is ', { code: 'chat.db' }, ' from ',
          { code: '~/Library/Messages' }, '.']]
      };
    }
    if (code === 'too_large') {
      return {
        title: 'This database is too big for a browser tab',
        body: [
          [{ b: file }, ' is ' + num(Math.round((detail.size || 0) / 1048576)) + ' MB. The limit here is ' +
            num(Math.round(DB.MAX_DB_BYTES / 1048576)) + ' MB, because the whole file has to fit in this tab\u2019s memory.'],
          ['The command-line tool has no such limit. Install it on your Mac, then run ', { code: 'wrapped link "Your chat name"' },
            ' in Terminal to get the same link. ', { link: HELP_URL, text: 'How to install it' }, '.']
        ]
      };
    }
    if (code === 'empty') {
      return { title: 'That file is empty', body: [[{ b: file }, ' has nothing in it. Pick it again from the original folder; if you made a copy, the copy may not have finished.']] };
    }
    if (code === 'corrupt') {
      return {
        title: 'The database could not be opened',
        body: [
          [{ b: file }, ' looks like a database, but it could not be read. If Messages was busy while the file was copied, quit Messages and try again with both ', { code: 'chat.db' }, ' and ', { code: 'chat.db-wal' }, '.'],
          'What the reader said: ' + String(error.message || '').replace(/^SQLite could not read this database:\s*/, '')
        ]
      };
    }
    if (code === 'unreadable') {
      return {
        title: 'The browser was not allowed to read that file',
        body: [
          [{ b: file }, ' could not be read. Either it changed while it was being read (Messages writes to it whenever a message arrives), or your computer is protecting the folder it is in.'],
          ['What usually works: in Finder, copy ', { code: 'chat.db' }, ' and ', { code: 'chat.db-wal' }, ' to your Desktop, then add the two copies here.']
        ]
      };
    }
    if (code === 'worker') {
      return {
        title: 'The reader could not start',
        body: ['This page does its work in a background helper, and your browser did not start it. Reload the page and try again. If you opened this page as a file on your computer, open it from the website instead.'],
        actions: [{ label: 'Reload the page', run: function () { root.location.reload(); } }]
      };
    }
    if (code === 'range') {
      return { title: 'That period does not work', body: [String(error.message || '') + '. Pick other dates in step 3.'] };
    }
    return {
      title: 'Something went wrong',
      body: ['That did not work, and it is not clear why. Nothing was sent anywhere. Try again; if it keeps happening, start over.',
        'Details: ' + String((error && error.message) || error || 'unknown')]
    };
  }

  // -- steps ----------------------------------------------------------------------------

  function setStep(name, state) {
    var section = $('step-' + name);
    section.classList.toggle('is-active', state === 'active');
    section.classList.toggle('is-done', state === 'done');
    section.classList.toggle('is-locked', state === 'locked');
    $(name + '-body').hidden = state !== 'active';
    var done = $(name + '-done');
    if (done) done.hidden = state !== 'done';
    return state;
  }

  function bubble(node, title, detail) {
    node.textContent = '';
    node.appendChild(el('strong', '', title));
    if (detail) node.appendChild(el('span', '', detail));
  }

  function render() {
    var hasSource = !!S.source;
    var hasChat = !!S.chat;
    var states = [
      setStep('source', hasSource ? 'done' : 'active'),
      setStep('chat', !hasSource ? 'locked' : hasChat ? 'done' : 'active'),
      setStep('tune', hasChat ? 'active' : 'locked'),
      setStep('recap', hasChat && S.created ? 'active' : 'locked')
    ];
    var doneFlags = [hasSource, hasChat, hasChat && S.created, hasChat && S.created && S.copied];
    var current = doneFlags.indexOf(false);
    var rail = $('rail').children;
    for (var i = 0; i < rail.length; i++) {
      rail[i].classList.toggle('is-done', doneFlags[i]);
      rail[i].classList.toggle('is-current', i === current);
      if (i === current) rail[i].setAttribute('aria-current', 'step'); else rail[i].removeAttribute('aria-current');
    }

    if (hasSource) {
      bubble($('source-summary'), S.source.title, S.source.detail);
      renderNotes();
    }
    if (hasChat) {
      var c = S.chat;
      bubble($('chat-summary'), c.name, plural(c.members, 'person', 'people') + ' \u00B7 ' + plural(c.messages, 'message'));
      $('chat-meta').textContent = c.single ? (S.source.kind === 'sample' ? 'The sample has one chat.' : 'An export holds one chat.') : '';
    }
    var single = !hasChat || S.chat.single;
    $('change-chat').hidden = single;
    $('another').hidden = single;
    $('create-row').hidden = S.created;
    $('live-note').hidden = !S.created;
    return states;
  }

  function focusStep(name) {
    var heading = $('h-' + name);
    var section = $('step-' + name);
    try { heading.focus({ preventScroll: true }); } catch (error) { heading.focus(); }
    root.requestAnimationFrame(function () {
      var top = section.getBoundingClientRect().top;
      if (top < 0 || top > root.innerHeight * 0.45) {
        root.scrollTo({ top: root.pageYOffset + top - 14, behavior: REDUCED ? 'auto' : 'smooth' });
      }
    });
  }

  function renderNotes() {
    var list = $('source-notes');
    list.textContent = '';
    (S.source.notes || []).forEach(function (note) {
      var item = el('li', note.quiet ? 'is-quiet' : '');
      item.appendChild(icon(note.quiet ? 'info' : 'warning'));
      item.appendChild(el('span', '', note.text));
      if (note.code) item.setAttribute('data-note', note.code);
      if (note.action) {
        var button = el('button', 'mk-linkbtn', note.action.label);
        button.type = 'button';
        button.addEventListener('click', note.action.run);
        item.appendChild(button);
      }
      list.appendChild(item);
    });
  }

  /** Forget everything from step `from` on (1 = the source itself). */
  function reset(from) {
    if (from <= 1) {
      S.source = null;
      S.chats = [];
      $('chat-search').value = '';
    }
    if (from <= 2) {
      S.chat = null;
      S.people = [];
      S.names = {};
      S.shortened = null;
      S.me = 'Me';
      S.chatName = '';
    }
    S.created = false;
    S.copied = false;
    S.stats = null;
    S.statsJson = '';
    S.fits = null;
    S.quotes = false;
    $('quotes').checked = false;
    $('recap').hidden = true;
    clearTimeout(computeTimer);
    computeTimer = 0;
    computeRun += 1;
    computePending = false;
    computeBusy = false;
    computeAgain = false;
    ['source', 'chat', 'tune', 'recap'].forEach(clearError);
    ['source', 'chat', 'recap'].forEach(idle);
  }

  function startOver() {
    stopWorker();
    S.files = null;
    S.rechoose = null;
    S.bigPaste = null;
    reset(1);
    render();
    say('Started over.');
    focusStep('source');
  }

  function chooseAnother() {
    reset(2);
    render();
    renderChats();
    focusStep('chat');
  }

  // -- step 1: tabs ---------------------------------------------------------------------

  var TABS = ['mac', 'backup', 'paste'];

  function selectTab(name, focus) {
    S.tab = name;
    TABS.forEach(function (tab) {
      var on = tab === name;
      var button = $('tab-' + tab);
      button.setAttribute('aria-selected', on ? 'true' : 'false');
      button.tabIndex = on ? 0 : -1;
      $('panel-' + tab).hidden = !on;
    });
    if (focus) $('tab-' + name).focus();
  }

  function onTabKey(event) {
    var at = TABS.indexOf(S.tab);
    var to = at;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') to = (at + 1) % TABS.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') to = (at + TABS.length - 1) % TABS.length;
    else if (event.key === 'Home') to = 0;
    else if (event.key === 'End') to = TABS.length - 1;
    else return;
    event.preventDefault();
    selectTab(TABS[to], true);
  }

  // -- step 1: files --------------------------------------------------------------------

  function baseName(file) {
    var parts = String(file.webkitRelativePath || file.name || '').split(/[\\/]/);
    return parts[parts.length - 1];
  }

  function isMessagesHash(file) { return baseName(file).toLowerCase() === DB.SMS_DB_ID; }

  function isWal(file) {
    var name = baseName(file).toLowerCase();
    return name === DB.SMS_WAL_ID || /-wal$/.test(name);
  }

  /** A folder that holds several backups was picked: keep the files of the newest one. */
  function newestBackup(files) {
    var hits = files.filter(isMessagesHash);
    if (hits.length < 2) return { files: files, count: hits.length };
    hits.sort(function (a, b) { return (b.lastModified || 0) - (a.lastModified || 0); });
    var path = hits[0].webkitRelativePath || '';
    var cut = path.lastIndexOf('/' + DB.backupPaths.messages);
    if (cut < 0) {
      return { files: files.filter(function (f) { return !isMessagesHash(f) || f === hits[0]; }), count: hits.length };
    }
    var prefix = path.slice(0, cut + 1);
    return { files: files.filter(function (f) { return (f.webkitRelativePath || '').indexOf(prefix) === 0; }), count: hits.length };
  }

  function sameFile(a, b) {
    return a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
  }

  function looksLikeExport(file) {
    return /\.(txt|csv|tsv|json|jsonl|ndjson)$/i.test(file.name || '') || /^text\//.test(file.type || '') ||
      file.type === 'application/json';
  }

  /** Files arrived (picked or dropped): work out what they are and open them. */
  function takeFiles(list, dropped) {
    var files = Array.prototype.slice.call(list || []).filter(Boolean);
    dropped = dropped || {};
    if (!files.length) return;
    clearError('source');
    var chosen = newestBackup(files);
    var found = DB.pickBackupFiles(chosen.files);
    var wals = chosen.files.filter(isWal);
    if (files.length === 1 && found.kind === 'file' && (S.tab === 'paste' || looksLikeExport(files[0])) && !dropped.sqlite) {
      // one loose file that is not a database: a text export
      if (!looksLikeExport(files[0]) && !dropped.sniffed) {
        var only = files[0];
        only.slice(0, 16).arrayBuffer().then(function (head) {
          takeFiles([only], { sniffed: true, sqlite: DB.sniff(new Uint8Array(head)).sqlite });
        }, function () { takeFiles([only], { sniffed: true, sqlite: false }); });
        return;
      }
      if (S.source) startOverQuietly();
      selectTab('paste', false);
      readExportFile(files[0]);
      return;
    }

    if (found.messages) {
      S.files = {
        db: found.messages,
        wal: found.messagesWal || null,
        contacts: found.contacts.slice(),
        kind: found.kind === 'backup' ? 'backup' : 'mac',
        backups: Math.max(chosen.count, dropped.backups || 0)
      };
      S.rechoose = null;
      openFiles();
      return;
    }
    if (S.files && S.source && (wals.length || found.contacts.length)) {
      // more files for the database that is already open: its -wal, or address books
      if (wals.length) S.files.wal = wals[0];
      // An address book added twice is read once. Only books that were already here count
      // as "twice": a Mac keeps several files with the same name (one per account), and
      // two of them arriving together are two different books even if they look alike.
      var held = S.files.contacts.slice();
      found.contacts.forEach(function (book) {
        if (!held.some(function (have) { return sameFile(have, book); })) S.files.contacts.push(book);
      });
      S.rechoose = S.chat && !S.chat.single ? S.chat.id : null;
      openFiles();
      return;
    }
    if (S.source) {
      // something is already open and these files add nothing to it: leave it alone
      S.source.notes = S.source.notes.filter(function (note) { return note.code !== 'ignored'; });
      S.source.notes.push({ code: 'ignored', quiet: true, text: 'The files you just added were not recognised, so nothing changed. To switch to other messages, start over.' });
      renderNotes();
      say('Those files were not recognised, so nothing changed.');
      return;
    }
    if (found.kind === 'backup') {
      showError('source', {
        title: 'No messages in that folder',
        body: [['This looks like part of an iPhone backup, but the file with the messages (', { code: '3d/3d0d7e5f\u20263d28' },
          ') is not in it. Choose the folder with the long name of letters and numbers inside the Backup folder. If the backup is still running, wait until it has finished.']]
      });
    } else if (wals.length && !found.contacts.length) {
      showError('source', {
        title: 'That is only half of it',
        body: [[{ b: baseName(wals[0]) }, ' holds the newest messages, but the rest are in ', { code: 'chat.db' }, ' next to it. Add both files together.']]
      });
    } else if (found.contacts.length) {
      showError('source', {
        title: 'That is an address book, not your messages',
        body: [['Contact names are a nice extra, but the messages themselves are in ', { code: 'chat.db' }, ' and ', { code: 'chat.db-wal' },
          ' in ', { code: '~/Library/Messages' }, '. Add those too.']]
      });
    } else {
      showError('source', {
        title: 'None of those files look like your messages',
        body: [['On a Mac the files to add are ', { code: 'chat.db' }, ' and ', { code: 'chat.db-wal' }, ' from ', { code: '~/Library/Messages' },
          '. For an iPhone backup, choose the backup folder itself.']]
      });
    }
  }

  function startOverQuietly() {
    stopWorker();
    S.files = null;
    reset(1);
    render();
  }

  function openFiles() {
    var files = S.files;
    reset(1);
    startWorker();
    render();
    working('source', 'Getting ready\u2026');
    ask('open', { db: files.db, wal: files.wal, contacts: files.contacts, kind: files.kind }, progressFor('source'))
      .then(function (result) {
        idle('source');
        sourceReady(files, result);
      }, function (error) {
        idle('source');
        S.files = null;
        showError('source', explain(error, { file: files.db, hashed: isMessagesHash(files.db) }));
        say('That did not work. See the message on the page.');
      });
  }

  function sourceReady(files, result) {
    var d = result.diagnostics;
    if (!result.chats.length) {
      S.files = null;
      showError('source', {
        title: 'No group chats in there',
        body: ['The database opened fine: it holds ' + plural(d.messages, 'message') + ' in ' + plural(d.chats, 'conversation') +
          ', but none of them is a group chat. A recap needs a chat with three or more people.',
          'If your group chats live on another device, add the messages from that one instead.']
      });
      return;
    }
    var notes = [];
    result.warnings.forEach(function (warning) {
      if (warning.code === 'wal_missing') {
        notes.push({
          code: 'wal_missing',
          text: files.kind === 'backup'
            ? 'Recent messages may be missing: this backup keeps its newest messages in a second file. Add cd/cd47480f\u20263a59 from the same backup folder too.'
            : 'Recent messages may be missing: your newest messages are in a second file. Add chat.db-wal too (it sits right next to chat.db).',
          action: {
            label: files.kind === 'backup' ? 'Add the second file' : 'Add chat.db-wal',
            run: function () { $(files.kind === 'backup' ? 'input-backup-files' : 'input-mac').click(); }
          }
        });
      } else if (warning.code === 'wal_invalid') {
        notes.push({
          code: 'wal_invalid',
          text: 'The -wal file does not belong to this database (or is damaged), so it was left out and recent messages may be missing. Add both files again, straight from the same folder.'
        });
      } else if (warning.code === 'contacts_unreadable') {
        notes.push({ code: 'contacts_unreadable', text: 'One address book file could not be read and was skipped.' });
      } else if (warning.message) {
        notes.push({ code: warning.code, text: warning.message });
      }
    });
    if (files.backups > 1) {
      notes.push({ code: 'backups', quiet: true, text: 'That folder holds ' + files.backups + ' backups. The newest one was used.' });
    }
    if (!result.contacts) {
      notes.push({
        code: 'no_contacts',
        quiet: true,
        text: 'No contact names were added, so people without a name show as the last four digits of their number. You can name them in step 3.'
      });
    }
    var label = files.kind === 'backup' ? 'iPhone backup' : baseName(files.db) + (files.wal ? ' + ' + baseName(files.wal) : '');
    if (result.contacts) label += ' + ' + plural(result.contacts, 'contact');
    S.source = {
      kind: files.kind,
      title: label,
      detail: plural(d.messages, 'message') + (d.first_unix ? ', ' + day(d.first_unix) + ' to ' + day(d.last_unix) : ''),
      notes: notes
    };
    S.chats = result.chats;
    var diag = $('diag');
    diag.textContent = '';
    rich(diag, ['Found ', { b: plural(d.messages, 'message') }, ' in ' + plural(d.chats, 'conversation') + ', ' +
      plural(result.chats.length, 'of them a group chat', 'of them group chats') +
      (d.first_unix ? ', from ' + day(d.first_unix) + ' to ' + day(d.last_unix) : '') +
      '. If that looks like too little, this device may hold only part of your history.']);
    render();
    renderChats();
    say('Found ' + plural(result.chats.length, 'group chat') + '. Choose one.');
    var again = S.rechoose;
    S.rechoose = null;
    if (again != null && S.chats.some(function (chat) { return chat.id === again; })) pickChat(again);
    else focusStep('chat');
  }

  // Dropped folders: ask for the known paths instead of listing a whole backup.
  var PATHS = DB.backupPaths;
  var KNOWN = ['chat.db', 'chat.db-wal', 'sms.db', 'sms.db-wal', PATHS.messages, PATHS.messagesWal,
    PATHS.contacts, PATHS.manifestPlist, 'AddressBook-v22.abcddb'];
  var IN_BACKUP = [PATHS.messages, PATHS.messagesWal, PATHS.contacts, PATHS.manifestPlist];

  function entryFile(entry) {
    return new Promise(function (resolve) {
      try { entry.file(resolve, function () { resolve(null); }); } catch (error) { resolve(null); }
    });
  }

  function fileAt(folder, path) {
    return new Promise(function (resolve) {
      try {
        folder.getFile(path, {}, function (entry) { entryFile(entry).then(resolve); }, function () { resolve(null); });
      } catch (error) { resolve(null); }
    });
  }

  function probe(folder, paths) {
    return Promise.all(paths.map(function (path) { return fileAt(folder, path); }))
      .then(function (files) { return files.filter(Boolean); });
  }

  function childrenOf(folder) {
    return new Promise(function (resolve) {
      var all = [];
      var reader;
      try { reader = folder.createReader(); } catch (error) { resolve(all); return; }
      (function more() {
        reader.readEntries(function (batch) {
          if (!batch.length || all.length > 2000) { resolve(all); return; }
          all = all.concat(Array.prototype.slice.call(batch));
          more();
        }, function () { resolve(all); });
      })();
    });
  }

  function flatten(sets) { return Array.prototype.concat.apply([], sets); }

  /** The useful files inside a dropped folder. Resolves to {files, backups}. */
  function probeFolder(folder) {
    return probe(folder, KNOWN).then(function (found) {
      var direct = found.some(function (f) { return /^(chat|sms)\.db$/i.test(f.name) || isMessagesHash(f); });
      if (direct) return { files: found, backups: 0 };
      return childrenOf(folder).then(function (kids) {
        var folders = kids.filter(function (kid) { return kid.isDirectory; }).slice(0, 40);
        var loose = kids.filter(function (kid) { return kid.isFile; }).slice(0, 24);
        return Promise.all(folders.map(function (kid) {
          if (kid.name === 'Sources') {                       // ~/Library/Application Support/AddressBook
            return childrenOf(kid).then(function (subs) {
              return Promise.all(subs.filter(function (s) { return s.isDirectory; }).slice(0, 40)
                .map(function (s) { return probe(s, ['AddressBook-v22.abcddb']); })).then(flatten);
            });
          }
          return probe(kid, IN_BACKUP);                       // a folder holding several backups
        })).then(function (sets) {
          var backups = sets.filter(function (set) { return set.some(isMessagesHash); });
          var stamp = function (set) { return (set.filter(isMessagesHash)[0] || {}).lastModified || 0; };
          backups.sort(function (a, b) { return stamp(b) - stamp(a); });
          var out = found.slice();
          if (backups.length) out = out.concat(backups[0]);
          sets.forEach(function (set) { if (backups.indexOf(set) === -1) out = out.concat(set); });
          return Promise.all(loose.map(entryFile)).then(function (files) {
            files.filter(Boolean).forEach(function (file) {
              if (!out.some(function (have) { return have.name === file.name; })) out.push(file);
            });
            return { files: out, backups: backups.length };
          });
        });
      });
    });
  }

  function collectDropped(transfer) {
    var items = transfer.items ? Array.prototype.slice.call(transfer.items) : [];
    var folders = [];
    var plain = [];
    items.forEach(function (item) {
      if (item.kind && item.kind !== 'file') return;
      var entry = null;
      try { entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null; } catch (error) { entry = null; }
      if (entry && entry.isDirectory) { folders.push(entry); return; }
      var file = item.getAsFile ? item.getAsFile() : null;
      if (file) plain.push(file);
    });
    if (!folders.length && !plain.length) plain = Array.prototype.slice.call(transfer.files || []);
    return Promise.all(folders.map(probeFolder)).then(function (sets) {
      var backups = 0;
      sets.forEach(function (set) { plain = plain.concat(set.files); backups = Math.max(backups, set.backups); });
      return { files: plain, backups: backups };
    });
  }

  var dragDepth = 0;

  function carriesFiles(event) {
    var types = event.dataTransfer && event.dataTransfer.types;
    return !!types && Array.prototype.indexOf.call(types, 'Files') !== -1;
  }

  function setDragging(on) {
    $('page').classList.toggle('is-dragging', on);
    $('drop-mac').classList.toggle('is-over', on);
    $('drop-backup').classList.toggle('is-over', on);
  }

  // -- step 1: paste and sample ---------------------------------------------------------

  var FORMATS = { columnar: 'two lists', jsonl: 'one message per line', json: 'a JSON list', csv: 'CSV', tsv: 'TSV' };

  function pasteNote(text) {
    var note = $('paste-note');
    note.hidden = !text;
    note.textContent = text || '';
    if (text) say(text);
  }

  function onPasteInput() {
    S.bigPaste = null;
    $('paste-go').disabled = !$('paste-text').value.trim();
    pasteNote('');
  }

  function pasteFromClipboard() {
    var box = $('paste-text');
    function blocked() {
      box.focus();
      pasteNote('Your browser did not let this page read the clipboard. Tap in the box and paste there instead.');
    }
    if (!navigator.clipboard || !navigator.clipboard.readText) { blocked(); return; }
    navigator.clipboard.readText().then(function (text) {
      if (!text || !text.trim()) {
        box.focus();
        pasteNote('The clipboard is empty. Copy your export first, then tap Paste again.');
        return;
      }
      box.value = text;
      onPasteInput();
      readPaste();
    }, blocked);
  }

  function readExportFile(file) {
    if (!file) return;
    clearError('source');
    var reader = file.text ? file.text() : new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result)); };
      r.onerror = reject;
      r.readAsText(file);
    });
    reader.then(function (text) {
      if (text.length <= 400000) {
        $('paste-text').value = text;
        onPasteInput();
      } else {
        $('paste-text').value = '';
        S.bigPaste = text;
        $('paste-go').disabled = false;
        pasteNote('');
      }
      readPaste(file.name);
    }, function () {
      showError('source', { title: 'That file could not be read', body: [[{ b: file.name }, ' could not be opened. Try choosing it again, or open it and paste its contents into the box.']] });
    });
  }

  function readPaste(fileName) {
    var text = S.bigPaste || $('paste-text').value;
    if (!text.trim()) {
      pasteNote('There is nothing to read yet. Paste your export into the box first.');
      return;
    }
    S.files = null;
    reset(1);
    startWorker();
    render();
    working('source', 'Reading your export\u2026');
    ask('paste', { text: text, tz: S.tz }, progressFor('source')).then(function (result) {
      idle('source');
      var s = result.summary;
      var range = s.first_unix ? ', ' + day(s.first_unix) + ' to ' + day(s.last_unix) : '';
      S.source = {
        kind: 'paste',
        title: (typeof fileName === 'string' && fileName ? fileName : 'Pasted export') + ' (' + (FORMATS[result.format] || result.format) + ')',
        detail: plural(s.messages, 'message') + ' from ' + plural(s.senders, 'person', 'people') + range,
        notes: result.warnings.slice(0, 6).map(function (warning) { return { code: 'import', text: warning }; })
      };
      if (result.warnings.length > 6) {
        S.source.notes.push({ code: 'import', quiet: true, text: 'And ' + (result.warnings.length - 6) + ' more notes like these.' });
      }
      S.chat = { id: null, name: result.chat_name, named: false, members: result.people.length, messages: s.messages, last_unix: s.last_unix, single: true };
      S.people = result.people;
      startTune();
      say('Read ' + plural(s.messages, 'message') + '. Check the names, then create the recap.');
    }, function (error) {
      idle('source');
      if (error.code === 'paste_empty') {
        var warnings = ((error.detail && error.detail.warnings) || []).slice(0, 3);
        showError('source', {
          title: 'No messages could be read from that',
          body: warnings.concat(['Each message needs a date and a sender. Open \u201CWhat can I paste?\u201D below to see the shapes that work.'])
        });
        var help = $('panel-paste').querySelector('details');
        if (help) help.open = true;
      } else {
        showError('source', explain(error));
      }
      say('That did not work. See the message on the page.');
    });
  }

  function trySample() {
    S.files = null;
    reset(1);
    startWorker();
    render();
    working('source', 'Making up a group chat\u2026');
    ask('sample', {}, progressFor('source')).then(function (result) {
      idle('source');
      var s = result.summary;
      S.source = {
        kind: 'sample',
        title: 'Sample chat',
        detail: 'Invented people and messages, made up on this device',
        notes: []
      };
      S.chat = { id: null, name: result.chat_name, named: true, members: result.people.length, messages: s.messages, last_unix: s.last_unix, single: true };
      S.people = result.people;
      startTune(result.year);
      say('The sample chat is ready. Create the recap when you like.');
    }, function (error) {
      idle('source');
      showError('source', explain(error));
    });
  }

  // -- step 2: chats --------------------------------------------------------------------

  function renderChats() {
    var list = $('chats');
    var query = $('chat-search').value.trim().toLowerCase();
    list.textContent = '';
    var shown = 0;
    S.chats.forEach(function (chat, index) {
      var hay = (chat.name + ' ' + chat.people.join(' ')).toLowerCase();
      if (query && hay.indexOf(query) === -1) return;
      shown += 1;
      var item = el('li');
      var button = el('button', 'mk-chat');
      button.type = 'button';
      button.setAttribute('data-chat-id', chat.id);
      button.setAttribute('data-messages', chat.messages);
      button.setAttribute('data-members', chat.members);
      button.setAttribute('data-last-unix', chat.last_unix == null ? '' : chat.last_unix);
      var avatar = el('span', 'mk-av', initial(chat.name));
      avatar.setAttribute('data-tone', index % 8);
      avatar.setAttribute('aria-hidden', 'true');
      var main = el('span', 'mk-chat__main');
      main.appendChild(el('span', 'mk-chat__name', chat.name));
      main.appendChild(el('span', 'mk-chat__meta', plural(chat.members, 'person', 'people') +
        (chat.last_unix ? ' \u00B7 last active ' + day(chat.last_unix) : '')));
      if (chat.people.length) {
        main.appendChild(el('span', 'mk-chat__with', 'With ' + chat.people.join(', ') +
          (chat.people_more ? ' and ' + chat.people_more + ' more' : '')));
      }
      var count = el('span', 'mk-chat__count', num(chat.messages));
      count.appendChild(el('small', '', chat.messages === 1 ? 'message' : 'messages'));
      button.appendChild(avatar);
      button.appendChild(main);
      button.appendChild(count);
      button.addEventListener('click', function () { pickChat(chat.id); });
      item.appendChild(button);
      list.appendChild(item);
    });
    $('chats-empty').hidden = shown > 0;
    list.classList.toggle('is-long', S.chats.length > 8);
    $('chat-search-wrap').hidden = S.chats.length <= 7;
  }

  function pickChat(id) {
    var chat = null;
    S.chats.forEach(function (candidate) { if (candidate.id === id) chat = candidate; });
    if (!chat) return;
    clearError('chat');
    var buttons = $('chats').querySelectorAll('.mk-chat');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].disabled = true;
      buttons[i].classList.toggle('is-picked', buttons[i].getAttribute('data-chat-id') === String(id));
    }
    working('chat', 'Reading ' + plural(chat.messages, 'message') + '\u2026');
    ask('chat', { chat: id }, progressFor('chat')).then(function (result) {
      idle('chat');
      S.chat = { id: chat.id, name: chat.name, named: chat.named, members: chat.members, messages: chat.messages, last_unix: chat.last_unix, single: false };
      S.people = result.people;
      startTune();
      say('Chat chosen: ' + chat.name + '. Tune it, then create the recap.');
    }, function (error) {
      idle('chat');
      for (var j = 0; j < buttons.length; j++) { buttons[j].disabled = false; buttons[j].classList.remove('is-picked'); }
      showError('chat', explain(error));
    });
  }

  // -- step 3: tune ---------------------------------------------------------------------

  /** Open step 3 for S.chat. `year` (optional): the calendar year the chat is known to cover. */
  function startTune(year) {
    S.names = {};
    S.shortened = null;
    // First names to begin with. A full name from an address book ("Dave plumber") is the
    // owner's private label for someone, not something to hand to the whole chat.
    useFirstNames();
    S.me = 'Me';
    S.chatName = S.chat.named ? S.chat.name : '';
    S.start = '';
    S.end = '';
    S.created = false;
    S.copied = false;
    S.stats = null;
    // The engine's default: this year, or last year while it is still January. A chat that
    // went quiet before that starts on "All time" instead of an empty recap.
    var now = today();
    var wanted = now.month === 1 ? now.year - 1 : now.year;
    if (year === now.year || year === now.year - 1) wanted = year;
    S.period = wanted === now.year ? 'year' : 'last';
    if (S.chat.last_unix && yearOf(S.chat.last_unix) < wanted) S.period = 'all';

    var name = $('chat-name');
    name.value = S.chatName;
    name.placeholder = S.chat.name;
    $('chat-name-hint').textContent = S.chat.named
      ? 'The title of the recap.'
      : 'This chat has no name of its own. Leave this empty to use its members\u2019 names, or give it one.';
    $('period-start').value = '';
    $('period-end').value = '';
    fillPeriod();
    renderPeople();
    render();
    periodHint();
    focusStep('tune');
  }

  function fillPeriod() {
    var now = today();
    $('period-year').textContent = String(now.year);
    $('period-last').textContent = String(now.year - 1);
    var radios = doc.querySelectorAll('input[name="period"]');
    for (var i = 0; i < radios.length; i++) radios[i].checked = radios[i].value === S.period;
    $('range').hidden = S.period !== 'custom';
  }

  function periodProblem() {
    if (S.period !== 'custom') return '';
    if (!S.start && !S.end) return 'Pick a start date, an end date, or both.';
    if (S.start && S.end && S.start > S.end) return 'The start date is after the end date.';
    return '';
  }

  function periodHint() {
    var hint = $('period-hint');
    var trouble = periodProblem();
    hint.classList.toggle('is-error', !!trouble);
    if (trouble) hint.textContent = trouble;
    else if (S.stats) hint.textContent = plural(S.stats.totals.messages, 'message') + ' in this period (' + span(S.stats.period.start, S.stats.period.end) + ').';
    else if (S.chat) hint.textContent = plural(S.chat.messages, 'message') + ' in this chat in total.';
    else hint.textContent = '';
    return !trouble;
  }

  function shownName(person) {
    if (person.me) return S.me.trim() || 'Me';
    return (S.names[person.key] || '').trim() || person.name;
  }

  function renderPeople() {
    var list = $('people');
    list.textContent = '';
    var unnamed = 0;
    S.people.forEach(function (person, index) {
      var item = el('li', 'mk-person' + (person.me ? ' is-me' : '') + (person.named ? '' : ' is-unnamed'));
      item.setAttribute('data-person', person.key);
      var avatar = el('span', 'mk-av');
      avatar.setAttribute('data-tone', index % 8);
      avatar.setAttribute('aria-hidden', 'true');
      var input = el('input', 'mk-input');
      input.type = 'text';
      input.maxLength = 40;
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.id = 'person-' + index;
      if (person.me) {
        input.value = S.me;
        input.placeholder = 'Me';
        input.setAttribute('aria-label', 'Your name in the recap');
      } else if (person.named) {
        input.value = S.names[person.key] || person.name;
        input.placeholder = person.name;
        input.setAttribute('aria-label', 'Name shown for ' + person.name);
      } else {
        unnamed += 1;
        input.value = S.names[person.key] || '';
        input.placeholder = 'Who is ' + person.name + '?';
        input.setAttribute('aria-label', 'Name for ' + (person.handles[0] || person.name));
      }
      input.addEventListener('input', function () {
        var typed = input.value.trim();
        var first = S.shortened && S.shortened[person.key] ? S.shortened[person.key].short : '';
        if (person.me) S.me = input.value;
        else if (typed && typed !== person.name) S.names[person.key] = input.value;
        else if (!typed && first && person.named) S.names[person.key] = first;   // emptied: back to the first name
        else {
          delete S.names[person.key];
          if (S.shortened) delete S.shortened[person.key];
        }
        peopleTags();
        changed();
      });
      var meta = el('span', 'mk-person__meta');
      item.appendChild(avatar);
      item.appendChild(input);
      item.appendChild(meta);
      list.appendChild(item);
    });
    list.classList.toggle('is-long', S.people.length > 9);
    var hint = $('unnamed-hint');
    hint.hidden = !unnamed;
    if (unnamed) {
      hint.textContent = (unnamed === 1 ? 'One person has' : unnamed + ' people have') +
        ' no name yet, so they would show as the last four digits of their number, like \u201C\u20261234\u201D. Type a name to replace it. ' +
        'The full numbers shown next to each field are only there to help you: they never go into the recap.';
    }
    peopleTags();
  }

  /** Avatars, the small print under each name, and who is being counted together. */
  function peopleTags() {
    var counts = {};
    S.people.forEach(function (person) {
      var name = shownName(person);
      counts[name] = (counts[name] || 0) + 1;
    });
    var spaced = false;
    var items = $('people').children;
    S.people.forEach(function (person, index) {
      var item = items[index];
      var name = shownName(person);
      item.querySelector('.mk-av').textContent = initial(name);
      if (!person.me && person.named) {
        item.querySelector('input').placeholder = S.shortened && S.shortened[person.key] ? S.shortened[person.key].short : person.name;
      }
      var meta = item.querySelector('.mk-person__meta');
      meta.textContent = '';
      if (person.me) meta.appendChild(el('span', 'mk-tag mk-tag--you', 'You'));
      if (!person.me && !person.named && !(S.names[person.key] || '').trim()) meta.appendChild(el('span', 'mk-tag mk-tag--new', 'No name yet'));
      if (counts[name] > 1) meta.appendChild(el('span', 'mk-tag mk-tag--merge', 'Counted together'));
      // Hints for the person at the keyboard only: the name as their address book has it,
      // and the raw number or address. Neither goes into the recap.
      if (!person.me && person.named && name !== person.name) meta.appendChild(el('span', 'mk-raw-handle', person.name));
      if (person.handles.length) meta.appendChild(el('span', 'mk-raw-handle', person.handles.join(', ')));
      meta.appendChild(el('span', '', plural(person.messages, 'message')));
      if (!person.me && /\s/.test(name)) spaced = true;
    });
    var shortened = S.shortened && Object.keys(S.shortened).length > 0;
    $('names-row').hidden = !(spaced || shortened);
    $('names-note').textContent = shortened
      ? 'First names to start with: the names in your address book are your own labels for people.'
      : 'Full names are your own labels for people. The recap can use first names instead.';
    $('first-names').textContent = shortened ? 'Use the full names' : 'Use first names only';
  }

  /**
   * The short form of each name, by the rule in docs/SCHEMA.md section 2 ("Short names"):
   * the first word; when two different people share it, each gets the first word, a space,
   * the first character of their last word and a full stop ("Sam R."); and if that still
   * clashes, those people keep their full names. `names` are distinct display names, the
   * owner and masked labels left out. Returns {name: short name}.
   *
   * This runs before counting, on everyone in the chat, because the page lets each name be
   * edited; the engine's own helper renames a finished recap instead.
   */
  function shortNames(names) {
    var groups = {};
    names.forEach(function (name) {
      var first = name.split(/\s+/)[0];
      if (!groups[first]) groups[first] = [];
      groups[first].push(name);
    });
    var short = {};
    Object.keys(groups).forEach(function (first) {
      var group = groups[first];
      if (group.length === 1) { short[group[0]] = first; return; }
      var initialled = {};
      group.forEach(function (name) {
        var words = name.split(/\s+/);
        var form = words[0] + ' ' + Array.from(words[words.length - 1])[0] + '.';
        if (!initialled[form]) initialled[form] = [];
        initialled[form].push(name);
      });
      Object.keys(initialled).forEach(function (form) {
        var same = initialled[form];
        same.forEach(function (name) { short[name] = same.length === 1 ? form : name; });
      });
    });
    return short;
  }

  /** Switch everyone to the short form of their name. Remembers what it replaced. */
  function useFirstNames() {
    var names = [];
    S.people.forEach(function (person) {
      var name = shownName(person);
      if (!person.me && name.charAt(0) !== '\u2026' && names.indexOf(name) === -1) names.push(name);
    });
    var short = shortNames(names);
    S.shortened = {};
    S.people.forEach(function (person, index) {
      if (person.me) return;
      var from = shownName(person);
      var to = short[from];
      if (!to || to === from) return;
      S.shortened[person.key] = { short: to, before: S.names[person.key] };
      S.names[person.key] = to;
      var input = $('person-' + index);
      if (input) input.value = to;
    });
  }

  /** Undo useFirstNames for every name that has not been changed by hand since. */
  function useFullNames() {
    var record = S.shortened || {};
    S.people.forEach(function (person, index) {
      var was = record[person.key];
      if (!was || S.names[person.key] !== was.short) return;
      if (was.before === undefined) delete S.names[person.key]; else S.names[person.key] = was.before;
      var input = $('person-' + index);
      if (input) input.value = S.names[person.key] || person.name;
    });
    S.shortened = null;
  }

  function toggleFirstNames() {
    if (S.shortened && Object.keys(S.shortened).length) useFullNames(); else useFirstNames();
    peopleTags();
    changed();
  }

  function fillZones() {
    var select = $('tz');
    if (select.options.length > 1) return;
    var zones = [];
    try { zones = Intl.supportedValuesOf('timeZone'); } catch (error) { zones = []; }
    if (zones.indexOf('UTC') === -1) zones.push('UTC');
    if (DEVICE_TZ && zones.indexOf(DEVICE_TZ) === -1) zones.unshift(DEVICE_TZ);
    select.textContent = '';
    zones.forEach(function (zone) {
      var option = el('option', '', zone.replace(/_/g, ' ') + (zone === DEVICE_TZ ? ' (this device)' : ''));
      option.value = zone;
      select.appendChild(option);
    });
    select.value = S.tz;
  }

  var computeTimer = 0;
  var computeRun = 0;
  var computePending = false;     // a recount is scheduled or running
  var computeBusy = false;        // the worker is counting right now
  var computeAgain = false;       // ... and something changed since it started

  /** Something in step 3 changed. */
  function changed() {
    var fine = periodHint();
    if (!S.created || !fine) return;
    $('recap').classList.add('is-stale');
    clearTimeout(computeTimer);
    computePending = true;
    computeTimer = setTimeout(function () { computeTimer = 0; compute(); }, 320);
  }

  function computeOptions() {
    var options = { tz: S.tz || '', me: S.me.trim() || 'Me', names: {} };
    Object.keys(S.names).forEach(function (key) {
      if (S.names[key].trim()) options.names[key] = S.names[key].trim();
    });
    if (S.chatName.trim()) options.chat_name = S.chatName.trim();
    var now = today();
    if (S.period === 'all') options.all_time = true;
    else if (S.period === 'custom') { options.start = S.start || ''; options.end = S.end || ''; }
    else options.year = S.period === 'last' ? now.year - 1 : now.year;
    return options;
  }

  function createRecap() {
    clearError('tune');
    if (!periodHint()) { $('period-hint').scrollIntoView({ block: 'center', behavior: REDUCED ? 'auto' : 'smooth' }); return; }
    S.created = true;
    render();
    compute();
    focusStep('recap');
  }

  /**
   * Count again with what step 3 says now. One count at a time: on a very large chat a
   * count takes a moment, and changes made meanwhile are picked up by one more run at the
   * end instead of queueing a run per keystroke.
   */
  function compute() {
    clearTimeout(computeTimer);
    computeTimer = 0;
    computePending = true;
    if (computeBusy) { computeAgain = true; return; }
    computeBusy = true;
    computeAgain = false;
    var run = ++computeRun;
    if (!S.stats) working('recap', 'Counting\u2026');
    ask('compute', { options: computeOptions() }, function (stage, detail) {
      if (run === computeRun && !S.stats) progressFor('recap')(stage, detail);
    }).then(function (result) {
      if (run !== computeRun) return;
      computeBusy = false;
      if (computeAgain) { compute(); return; }
      computePending = computeTimer !== 0;       // a newer change may already be waiting
      idle('recap');
      onStats(result.stats);
    }, function (error) {
      if (run !== computeRun) return;
      computeBusy = false;
      if (computeAgain) { compute(); return; }
      computePending = computeTimer !== 0;       // a newer change may already be waiting
      idle('recap');
      $('recap').hidden = true;
      S.stats = null;
      showError('recap', explain(error));
    });
  }

  // -- step 4: the recap ----------------------------------------------------------------

  function fit(stats, quotes) {
    try {
      return Engine.fitLink(stats, { quotes: quotes, base_url: Config.BASE_URL, max_length: MAX_LINK });
    } catch (error) {
      return null;
    }
  }

  /**
   * The address the preview frame plays: this site's own story page with EXACTLY the
   * payload of the link being shared. What you see is what you send. The story can copy
   * and share its own link, so it must never be handed more than the link holds: with the
   * quotes switch off there is no message text in the frame at all.
   */
  function previewAddress(link) {
    var base = new URL('../index.html', root.location.href).href.split('#')[0];
    return base + '#' + link.url.slice(link.url.indexOf('#') + 1);
  }

  function onStats(stats) {
    S.stats = stats;
    S.statsJson = JSON.stringify(stats);
    $('recap').classList.remove('is-stale');
    if (!S.chatName.trim()) $('chat-name').placeholder = stats.chat.name;
    periodHint();
    if (!stats.totals.messages) {
      S.fits = null;
      $('recap').hidden = true;
      var actions = S.period === 'all' ? [] : [{ label: 'Use all time instead', primary: true, run: function () { setPeriod('all'); } }];
      showError('recap', {
        info: true,
        title: 'No messages in this period',
        body: ['Nobody wrote anything in this chat between ' + isoDay(stats.period.start) + ' and ' + isoDay(stats.period.end) +
          ', so there is nothing to recap. Choose another period in step 3.'],
        actions: actions
      });
      say('No messages in this period.');
      return;
    }
    var hasText = (stats.most_reacted || []).some(function (m) { return m && m.text; });
    S.fits = { off: fit(stats, false), on: hasText ? fit(stats, true) : null, hasText: hasText };
    if (!S.fits.off) {
      $('recap').hidden = true;
      showError('recap', {
        title: 'This recap does not fit in a link',
        body: ['A link can hold ' + num(MAX_LINK) + ' characters, and even the shortest version of this recap is longer. ' +
          'Very long names are the usual reason: shorten the chat name or people\u2019s names in step 3.']
      });
      return;
    }
    if (!S.fits.on) S.quotes = false;
    clearError('recap');
    $('recap').hidden = false;
    renderRecap();
    say('Your recap is ready: ' + plural(stats.totals.messages, 'message') + '.');
  }

  function setPeriod(value) {
    S.period = value;
    fillPeriod();
    clearError('recap');
    changed();
  }

  function showPreview(url) {
    var frame = $('preview');
    if (S.previewUrl === url) return;
    S.previewUrl = url;
    try {
      var inner = frame.contentWindow;
      if (frame.getAttribute('src') && inner && /index\.html$/.test(inner.location.pathname)) {
        inner.location.replace(url);            // a new #w1= only: the story re-reads it
        return;
      }
    } catch (error) { /* fall through to a fresh load */ }
    frame.src = url;
  }

  function replayPreview() {
    var frame = $('preview');
    try {
      frame.contentWindow.WrappedApp.route();   // the story page: start over
    } catch (error) {
      if (S.previewUrl) frame.src = S.previewUrl;   // anything else in the frame: load the story
    }
  }

  /** The story's own "Make one for your chat" link was followed inside the frame. */
  function onPreviewLoad() {
    var frame = $('preview');
    try {
      if (S.previewUrl && /\/make\/(index\.html)?$/.test(frame.contentWindow.location.pathname)) {
        frame.src = S.previewUrl;
      }
    } catch (error) { /* not ours to look at */ }
  }

  function currentFit() {
    if (!S.fits) return null;
    return S.quotes && S.fits.on ? S.fits.on : S.fits.off;
  }

  function namesIn(stats) {
    var seen = {};
    var out = [];
    function add(name) {
      if (typeof name === 'string' && name && !seen[name]) { seen[name] = true; out.push(name); }
    }
    (stats.senders || []).forEach(function (s) { add(s.name); });
    if (stats.late_night && stats.late_night.top) add(stats.late_night.top.name);
    (stats.most_reacted || []).forEach(function (m) { add(m.sender); });
    (stats.awards || []).forEach(function (a) { add(a.winner); });
    if (stats.reactions) {
      if (stats.reactions.top_giver) add(stats.reactions.top_giver.name);
      if (stats.reactions.top_receiver) add(stats.reactions.top_receiver.name);
    }
    return out;
  }

  /** What the length budget cost, in words. */
  function describeTrim(full, link, quotesOn) {
    var cuts = [];
    if (!link.steps) return cuts;
    var cut = link.stats;
    var awards = full.awards || [];
    if (awards.length && !cut.awards) cuts.push('the awards');
    else if (awards.some(function (a) { return a.detail; }) && (cut.awards || []).every(function (a) { return !a.detail; })) {
      cuts.push('the one-line descriptions under the awards');
    }
    var quotes = full.most_reacted || [];
    var kept = cut.most_reacted || [];
    if (quotesOn && kept.some(function (m, i) { return quotes[i] && m.text !== quotes[i].text; })) {
      cuts.push('the ends of long messages (each quote is cut to 60 characters)');
    }
    if (kept.length < quotes.length) cuts.push('all but the single most-reacted message');
    if ((cut.senders || []).length < (full.senders || []).length) {
      cuts.push('everyone below the top ' + cut.senders.length + ' in the ranking (the totals still count them)');
    }
    return cuts;
  }

  function insideItem(list, iconName, parts, className) {
    var item = el('li', className || '');
    item.appendChild(icon(iconName));
    item.appendChild(rich(el('span'), parts));
    list.appendChild(item);
  }

  /**
   * Where "Open story" goes. The link people copy always points at the public site. When
   * this page is served from somewhere else (a local copy, a fork), open the story that
   * sits next to this page instead, so the button works before the public site exists.
   */
  function storyHere(url) {
    try {
      if (new URL(Config.BASE_URL).origin === root.location.origin) return url;
    } catch (error) { /* fall through to the local story */ }
    var hash = url.indexOf('#');
    return (root.location.protocol === 'file:' ? '../index.html' : '../') + (hash === -1 ? '' : url.slice(hash));
  }

  function renderRecap() {
    var stats = S.stats;
    var link = currentFit();
    if (!stats || !link) return;
    var quotesOn = S.quotes && !!S.fits.on;

    $('recap-title').textContent = stats.chat.name;
    $('recap-facts').textContent = plural(stats.totals.messages, 'message') + ' \u00B7 ' +
      plural(stats.chat.members, 'person', 'people') + ' \u00B7 ' + span(stats.period.start, stats.period.end);

    $('link').value = link.url;
    $('open').href = storyHere(link.url);
    $('open-card').href = storyHere(link.url);
    linkMeta();

    var cuts = describeTrim(stats, link, quotesOn);
    var trim = $('trim');
    trim.hidden = !cuts.length;
    trim.textContent = cuts.length
      ? 'To fit in a link (' + num(MAX_LINK) + ' characters at most), a few things were left out: ' + cuts.join('; ') + '.'
      : '';
    trim.setAttribute('data-steps', link.steps);

    var list = $('inside-list');
    list.textContent = '';
    var names = namesIn(link.stats);
    insideItem(list, 'bubble', ['The chat\u2019s name: ', { b: link.stats.chat.name }]);
    insideItem(list, 'people', [{ b: plural(names.length, 'name') }, ': ' + names.join(', ')]);
    insideItem(list, 'chart', [{ b: 'Counts, not conversations' }, ': messages, words, photos and tapbacks per person and by hour, weekday and month, plus the busiest day, streaks and awards.']);
    if (quotesOn) {
      var n = (link.stats.most_reacted || []).filter(function (m) { return m.text; }).length;
      insideItem(list, 'quote', [{ b: 'The text of ' + plural(n, 'message') }, ', word for word. You switched this on below.'], 'is-text');
    } else {
      insideItem(list, 'check', [{ b: 'No message text' }, '. Not a word anyone wrote.']);
    }
    var masked = names.some(function (name) { return name.charAt(0) === '\u2026'; });
    insideItem(list, 'lock', [{ b: 'No phone numbers or e-mail addresses' }, masked
      ? '. People without a name show as the last four digits of their number; name them in step 3 if you like.'
      : '.']);

    renderQuotes(quotesOn);
    $('raw-json').textContent = JSON.stringify(link.stats, null, 2);

    // The frame plays the very link shown here: flipping the switch rebuilds both.
    showPreview(previewAddress(link));

    $('share').hidden = typeof navigator.share !== 'function';
  }

  function linkMeta(text) {
    var link = currentFit();
    var meta = $('link-meta');
    meta.textContent = '';
    if (text) { meta.textContent = text; return; }
    if (!link) return;
    rich(meta, ['The link is ', { b: num(link.length) }, ' of the ' + num(MAX_LINK) + ' characters a message link can be.']);
    meta.setAttribute('data-length', link.length);
  }

  function renderQuotes(quotesOn) {
    var box = $('quotes-box');
    var toggle = $('quotes');
    var list = $('quotes-list');
    box.hidden = !S.fits.hasText;
    if (!S.fits.hasText) return;
    toggle.checked = quotesOn;
    toggle.disabled = !S.fits.on;
    box.classList.toggle('is-on', quotesOn);
    list.textContent = '';
    if (!S.fits.on) {
      $('quotes-note').textContent = 'There is no room left in this link for message text, so it stays out.';
      return;
    }
    $('quotes-note').textContent = quotesOn
      ? 'On. These words now travel inside the link, exactly as shown. Anyone who gets the link can read them.'
      : 'Off. The link says how many tapbacks these messages got, but not what they said. Switch it on to include the words below, exactly as shown.';
    (S.fits.on.stats.most_reacted || []).forEach(function (m) {
      var item = el('li', 'mk-quote');
      item.appendChild(el('span', 'mk-quote__who', m.sender + ' \u00B7 ' + isoDay(m.date) + ' \u00B7 ' + plural(m.reactions, 'tapback')));
      var text = el('span', 'mk-quote__text' + (m.text ? '' : ' is-empty'), m.text || 'A photo or attachment, with no words');
      item.appendChild(text);
      list.appendChild(item);
    });
  }

  function legacyCopy(text) {
    var holder = el('textarea', 'sr-only');
    holder.value = text;
    holder.setAttribute('readonly', '');
    doc.body.appendChild(holder);
    holder.select();
    var ok = false;
    try { ok = doc.execCommand('copy'); } catch (error) { ok = false; }
    holder.remove();
    return ok;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  var copyTimer = 0;

  function copyLink() {
    var link = currentFit();
    if (!link) return;
    copyText(link.url).then(function (ok) {
      var button = $('copy');
      var field = $('link');
      clearTimeout(copyTimer);
      if (!ok) {
        field.focus();
        field.select();
        linkMeta('Copying did not work here. The link is selected below: press \u2318C or Ctrl+C.');
        say('Copying did not work. The link is selected: copy it by hand.');
        return;
      }
      S.copied = true;
      button.classList.add('is-done');
      setIcon(button.querySelector('.mk-ico'), 'check');
      $('copy-label').textContent = 'Copied';
      var thread = $('thread');
      thread.classList.remove('is-sent');
      void thread.offsetWidth;                   // restart the animation
      thread.classList.add('is-sent');
      linkMeta('Copied. Paste it into the chat on its own line.');
      say('Link copied.');
      render();
      copyTimer = setTimeout(function () {
        button.classList.remove('is-done');
        setIcon(button.querySelector('.mk-ico'), 'link');
        $('copy-label').textContent = 'Copy link';
        linkMeta();
      }, 2600);
    });
  }

  function shareLink() {
    var link = currentFit();
    if (!link || typeof navigator.share !== 'function') return;
    // The link alone, so that it lands in the chat as its own message.
    navigator.share({ url: link.url }).then(function () {
      S.copied = true;
      render();
    }, function () { /* the person closed the share sheet */ });
  }

  function onQuotes() {
    S.quotes = $('quotes').checked && !!(S.fits && S.fits.on);
    renderRecap();
    say(S.quotes ? 'Message text is now included in the link.' : 'Message text is no longer in the link.');
  }

  function copyPath(button) {
    copyText(button.getAttribute('data-copy')).then(function (ok) {
      if (!ok) return;
      var holder = button.querySelector('.mk-ico');
      button.classList.add('is-done');
      setIcon(holder, 'check');
      say('Copied ' + button.getAttribute('data-copy'));
      setTimeout(function () {
        button.classList.remove('is-done');
        setIcon(holder, 'copy');
      }, 1600);
    });
  }

  // -- start ----------------------------------------------------------------------------

  function fillStatic() {
    var brands = doc.querySelectorAll('[data-brand]');
    for (var i = 0; i < brands.length; i++) brands[i].textContent = Config.PRODUCT_NAME;
    var holders = doc.querySelectorAll('[data-icon]');
    for (var j = 0; j < holders.length; j++) setIcon(holders[j], holders[j].getAttribute('data-icon'));
    var host = '';
    try { host = new URL(Config.BASE_URL).host; } catch (error) { host = ''; }
    // No mouse, only fingers: a phone or a tablet, which cannot reach a Messages history.
    if (root.matchMedia && root.matchMedia('(hover: none) and (pointer: coarse)').matches) $('page').classList.add('is-touch');
    var hosts = doc.querySelectorAll('[data-host]');
    for (var k = 0; k < hosts.length; k++) hosts[k].textContent = host;
    var select = $('tz');
    var option = el('option', '', (DEVICE_TZ || 'This device').replace(/_/g, ' ') + ' (this device)');
    option.value = DEVICE_TZ;
    select.appendChild(option);
  }

  function onHash() {
    if (/^#paste\b/.test(root.location.hash || '') && !S.source) {
      selectTab('paste', false);
      $('paste-btn').focus();
    }
  }

  function wire() {
    TABS.forEach(function (tab) {
      $('tab-' + tab).addEventListener('click', function () { selectTab(tab, false); });
      $('tab-' + tab).addEventListener('keydown', onTabKey);
    });

    [['pick-mac', 'input-mac'], ['pick-backup-folder', 'input-backup-folder'], ['pick-backup-files', 'input-backup-files'],
      ['pick-export', 'input-export']].forEach(function (pair) {
      $(pair[0]).addEventListener('click', function () { $(pair[1]).click(); });
    });
    ['input-mac', 'input-backup-folder', 'input-backup-files'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        var files = Array.prototype.slice.call($(id).files || []);
        $(id).value = '';
        takeFiles(files);
      });
    });
    $('input-export').addEventListener('change', function () {
      var file = $('input-export').files && $('input-export').files[0];
      $('input-export').value = '';
      readExportFile(file);
    });

    root.addEventListener('dragenter', function (event) {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      dragDepth += 1;
      setDragging(true);
    });
    root.addEventListener('dragover', function (event) {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });
    root.addEventListener('dragleave', function (event) {
      if (!carriesFiles(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) setDragging(false);
    });
    root.addEventListener('drop', function (event) {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      dragDepth = 0;
      setDragging(false);
      collectDropped(event.dataTransfer).then(function (dropped) { takeFiles(dropped.files, dropped); });
    });

    $('paste-btn').addEventListener('click', pasteFromClipboard);
    $('paste-text').addEventListener('input', onPasteInput);
    $('paste-go').addEventListener('click', function () { readPaste(); });
    $('try-sample').addEventListener('click', trySample);
    $('start-over').addEventListener('click', startOver);
    $('restart').addEventListener('click', startOver);
    $('change-chat').addEventListener('click', chooseAnother);
    $('another').addEventListener('click', chooseAnother);
    $('chat-search').addEventListener('input', renderChats);

    var radios = doc.querySelectorAll('input[name="period"]');
    for (var i = 0; i < radios.length; i++) {
      radios[i].addEventListener('change', function (event) {
        if (!event.target.checked) return;
        S.period = event.target.value;
        $('range').hidden = S.period !== 'custom';
        changed();
      });
    }
    $('period-start').addEventListener('change', function () { S.start = $('period-start').value; changed(); });
    $('period-end').addEventListener('change', function () { S.end = $('period-end').value; changed(); });
    $('chat-name').addEventListener('input', function () { S.chatName = $('chat-name').value; changed(); });
    $('advanced').addEventListener('toggle', function () { if ($('advanced').open) fillZones(); });
    $('tz').addEventListener('change', function () {
      S.tz = $('tz').value;
      fillPeriod();
      changed();
    });
    $('first-names').addEventListener('click', toggleFirstNames);
    $('create').addEventListener('click', createRecap);

    $('copy').addEventListener('click', copyLink);
    $('share').addEventListener('click', shareLink);
    $('quotes').addEventListener('change', onQuotes);
    $('replay').addEventListener('click', replayPreview);
    $('preview').addEventListener('load', onPreviewLoad);
    $('link').addEventListener('focus', function () { $('link').select(); });

    doc.addEventListener('click', function (event) {
      var button = event.target.closest ? event.target.closest('.mk-copy') : null;
      if (button) copyPath(button);
    });
    root.addEventListener('hashchange', onHash);
  }

  fillStatic();
  wire();
  render();
  onHash();

  /** For the end-to-end tests and for anyone poking at the page in the console. */
  root.WrappedMake = {
    /** A copy of where the maker stands: steps, the stats as computed, the link. */
    snapshot: function () {
      var link = currentFit();
      return {
        source: S.source ? { kind: S.source.kind, title: S.source.title, detail: S.source.detail, notes: S.source.notes.map(function (n) { return n.code; }) } : null,
        chats: S.chats.length,
        chat: S.chat ? JSON.parse(JSON.stringify(S.chat)) : null,
        people: JSON.parse(JSON.stringify(S.people)),
        options: S.chat ? computeOptions() : null,
        created: S.created,
        busy: computePending || Object.keys(waiting).length > 0,
        stats: S.stats ? JSON.parse(S.statsJson) : null,
        statsJson: S.statsJson,
        quotes: S.quotes,
        link: link ? { url: link.url, length: link.length, steps: link.steps } : null,
        preview: S.previewUrl
      };
    }
  };
})(window);
