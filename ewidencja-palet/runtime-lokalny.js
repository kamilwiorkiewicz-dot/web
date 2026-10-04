/* =========================================================================
   EWIDENCJA PALET — runtime lokalny (wersja offline / serwer w sieci lokalnej)

   Zastępuje platformę Claude: definiuje window.claude.use('db'|'assets'|'downloads')
   oraz window.EP_LOCAL. Aplikacja (index.html) pozostaje identyczna z wersją online.

   Tryby:
   • 'server'  — strona otwarta z serwera (node server.js): wspólna baza na serwerze,
                 zmiany na żywo między urządzeniami (SSE), zapis przez POST.
   • 'browser' — strona otwarta z dysku (file://) albo z serwera bez API: dane w tej
                 przeglądarce (IndexedDB → localStorage → tylko pamięć), synchronizacja
                 między kartami (BroadcastChannel / zdarzenie storage).

   Czysty JavaScript ES2019 — działa w Safari 14+, Chrome, Firefox, także z file://.
   ========================================================================= */
(function (window, document) {
  'use strict';
  if (window.EP_LOCAL && window.EP_LOCAL.__runtime) return;

  var APP = 'ewidencja-palet';
  var VERSION = '1.0.0';
  var ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
  var OPS = ['==', '!=', '<', '<=', '>', '>=', 'in', 'not-in', 'array-contains'];
  var MAX_DOC_BYTES = 1000000;
  var MAX_ASSET_BYTES = 4 * 1024 * 1024;
  var PING_TIMEOUT_MS = 1500;
  var WRITE_TIMEOUT_MS = 30000;
  var SSE_SILENCE_MS = 70000;  // serwer wysyła „ping” co 25 s
  var BASE = window.location.pathname.replace(/[^\/]*$/, '') || '/';
  var API = BASE + 'api/';
  var LSP = APP + ':';         // prefiks kluczy localStorage
  var noop = function () {};

  /* ------------------------------------------------------------------ */
  /* narzędzia                                                          */
  /* ------------------------------------------------------------------ */
  function err(code, message) { var e = new Error(message); e.code = code; return e; }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function isDel(v) { return isObj(v) && v.__delete__ === true && Object.keys(v).length === 1; }
  function defProp(o, k, v) { Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true }); }
  function stripDel(d) { var o = {}; Object.keys(d).forEach(function (k) { if (!isDel(d[k])) defProp(o, k, d[k]); }); return o; }
  function merge(base, patch) {
    var o = {};
    Object.keys(base).forEach(function (k) { defProp(o, k, base[k]); });
    Object.keys(patch).forEach(function (k) { if (isDel(patch[k])) delete o[k]; else defProp(o, k, patch[k]); });
    return o;
  }
  function genId(len) {
    var abc = 'abcdefghijklmnopqrstuvwxyz0123456789', s = '', c = window.crypto || window.msCrypto;
    while (s.length < len) {
      var buf = new Uint8Array(len * 2);
      if (c && c.getRandomValues) c.getRandomValues(buf);
      else for (var j = 0; j < buf.length; j++) buf[j] = Math.floor(Math.random() * 256);
      for (var i = 0; i < buf.length && s.length < len; i++) if (buf[i] < 252) s += abc[buf[i] % 36];
    }
    return s;
  }
  // dane dokumentu → kanoniczny JSON (walidacja: obiekt, serializowalny, ≤ 1 MB)
  function toDocJson(data, allowDelete) {
    if (!isObj(data)) throw err('invalid_argument', 'Dane dokumentu muszą być obiektem.');
    var json;
    try { json = JSON.stringify(data); } catch (e) { throw err('invalid_argument', 'Dane dokumentu nie dają się zapisać (' + e.message + ').'); }
    if (json.length > MAX_DOC_BYTES) throw err('invalid_argument', 'Dokument jest za duży (maks. 1 MB).');
    var parsed = JSON.parse(json);
    return allowDelete ? parsed : stripDel(parsed);
  }
  function checkId(kind, v) {
    if (typeof v !== 'string' || !ID_RE.test(v)) throw err('invalid_argument', 'Nieprawidłowa nazwa ' + kind + ': "' + v + '"');
    return v;
  }
  function onBody(fn) {
    if (document.body) fn();
    else document.addEventListener('DOMContentLoaded', function () { fn(); });
  }
  function warn() { try { console.warn.apply(console, ['[Ewidencja Palet]'].concat([].slice.call(arguments))); } catch (e) { /* ignore */ } }

  /* ------------------------------------------------------------------ */
  /* paski komunikatów (własny, mały element DOM w kolorach aplikacji)   */
  /* ------------------------------------------------------------------ */
  var bannerBox = null, banners = {};
  function showBanner(key, text) {
    onBody(function () {
      if (!bannerBox) {
        bannerBox = document.createElement('div');
        bannerBox.id = 'ep-local-banners';
        bannerBox.setAttribute('style', 'position:fixed;top:calc(env(safe-area-inset-top,0px) + 8px);left:50%;transform:translateX(-50%);' +
          'z-index:2147483000;display:flex;flex-direction:column;gap:6px;align-items:center;width:max-content;max-width:calc(100vw - 24px);pointer-events:none;');
        document.body.appendChild(bannerBox);
      }
      var el = banners[key];
      if (!el) {
        el = document.createElement('div');
        el.setAttribute('data-ep-banner', key);
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        el.setAttribute('style', 'box-sizing:border-box;max-width:100%;padding:7px 12px;border-radius:9px;' +
          'background:var(--panel,#fff);color:var(--text,#12161B);border:1px solid var(--bad,#C2570A);border-left-width:4px;' +
          'font:600 12.5px/1.35 "Space Grotesk",system-ui,-apple-system,"Segoe UI",sans-serif;text-align:center;' +
          'box-shadow:0 4px 16px rgba(0,0,0,.18);backdrop-filter:var(--blur,none);-webkit-backdrop-filter:var(--blur,none);');
        banners[key] = el;
      }
      el.textContent = text;
      if (!el.parentNode) bannerBox.appendChild(el);
    });
  }
  function hideBanner(key) { var el = banners[key]; if (el && el.parentNode) el.parentNode.removeChild(el); }

  /* ------------------------------------------------------------------ */
  /* lustro danych w pamięci + nasłuchy                                 */
  /* ------------------------------------------------------------------ */
  var colls = new Map();   // coll -> Map(id -> {json, obj})
  var listeners = [];

  function entry(coll, id) { var m = colls.get(coll); return (m && m.get(id)) || null; }
  function putEntry(coll, id, json) {             // zwraca true, jeśli coś się zmieniło
    var m = colls.get(coll), cur = m ? m.get(id) : undefined;
    if (json === null) { if (!cur) return false; m.delete(id); return true; }
    if (cur && cur.json === json) return false;
    if (!m) { m = new Map(); colls.set(coll, m); }
    m.set(id, { json: json, obj: JSON.parse(json) });
    return true;
  }
  function applyChange(coll, id, json, force) {
    var changed = putEntry(coll, id, json);
    if (changed || force) touch(coll, id);
    return changed;
  }
  // zastępuje całe lustro (np. po ponownym wczytaniu z serwera); keep(coll,id) → zostaw wersję lokalną
  function replaceMirror(next, keep) {
    var names = new Set(); colls.forEach(function (_, c) { names.add(c); }); next.forEach(function (_, c) { names.add(c); });
    names.forEach(function (c) {
      var ids = new Set(), cur = colls.get(c), nx = next.get(c);
      if (cur) cur.forEach(function (_, id) { ids.add(id); });
      if (nx) nx.forEach(function (_, id) { ids.add(id); });
      ids.forEach(function (id) { if (!keep || !keep(c, id)) putEntry(c, id, (nx && nx.has(id)) ? nx.get(id) : null); });
    });
  }

  function touch(coll, id) {
    for (var i = 0; i < listeners.length; i++) {
      var l = listeners[i];
      if (l.coll === coll && (l.id === null || l.id === id)) schedule(l);
    }
  }
  function touchAll() { listeners.slice().forEach(schedule); }
  // najwyżej jedno dostarczenie na zadanie (task) na nasłuch; nigdy synchronicznie w trakcie zapisu
  function schedule(l) {
    if (l.pending || !l.active) return;
    l.pending = true;
    setTimeout(function () { l.pending = false; if (l.active) deliver(l); }, 0);
  }
  function deliver(l) {
    var snap;
    try {
      if (l.id !== null) { var e = entry(l.coll, l.id); snap = docSnap(l.coll, l.id, e ? e.json : null); }
      else { var rows = runQuery(l.q); snap = querySnap(rows, l.last); l.last = rows; }
    } catch (e2) { if (l.error) l.error(e2); else warn(e2); return; }
    l.next(snap);
  }
  function listen(l, next, error) {
    if (isObj(next) && typeof next.next === 'function') { error = next.error ? next.error.bind(next) : null; next = next.next.bind(next); }
    if (typeof next !== 'function') throw err('invalid_argument', 'onSnapshot wymaga funkcji.');
    l.next = next; l.error = typeof error === 'function' ? error : null;
    l.active = true; l.pending = false; l.last = null;
    listeners.push(l);
    ready.then(function () { schedule(l); });
    return function unsubscribe() {
      l.active = false;
      var i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1);
    };
  }

  /* ---------------------------- migawki ---------------------------- */
  function getPath(obj, field) {
    if (Object.prototype.hasOwnProperty.call(obj, field)) return obj[field];
    if (field.indexOf('.') < 0) return undefined;
    var parts = field.split('.'), v = obj;
    for (var i = 0; i < parts.length; i++) {
      if (!isObj(v) || !Object.prototype.hasOwnProperty.call(v, parts[i])) return undefined;
      v = v[parts[i]];
    }
    return v;
  }
  function docSnap(coll, id, json) {
    return {
      id: id,
      exists: json !== null,
      ref: new DocRef(coll, id),
      metadata: {},
      data: function () { return json === null ? undefined : JSON.parse(json); },
      get: function (field) { if (json === null) return undefined; var v = getPath(JSON.parse(json), field); return v; },
    };
  }
  function querySnap(rows, prev) {
    var docs = rows.map(function (r) { return docSnap(r.coll, r.id, r.json); });
    return {
      docs: docs,
      size: docs.length,
      empty: docs.length === 0,
      metadata: {},
      forEach: function (cb, thisArg) { docs.forEach(cb, thisArg); },
      docChanges: function () {
        if (!prev) return docs.map(function (d, i) { return { type: 'added', doc: d, oldIndex: -1, newIndex: i }; });
        var oldPos = new Map(), newPos = new Map(), out = [];
        prev.forEach(function (r, i) { oldPos.set(r.id, i); });
        rows.forEach(function (r, i) { newPos.set(r.id, i); });
        prev.forEach(function (r, i) { if (!newPos.has(r.id)) out.push({ type: 'removed', doc: docSnap(r.coll, r.id, r.json), oldIndex: i, newIndex: -1 }); });
        rows.forEach(function (r, i) {
          if (!oldPos.has(r.id)) out.push({ type: 'added', doc: docs[i], oldIndex: -1, newIndex: i });
          else if (prev[oldPos.get(r.id)].json !== r.json) out.push({ type: 'modified', doc: docs[i], oldIndex: oldPos.get(r.id), newIndex: i });
        });
        return out;
      },
    };
  }

  /* ---------------------------- zapytania ---------------------------- */
  function same(a, b) {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    return JSON.stringify(a) === JSON.stringify(b);
  }
  function rank(v) {
    if (v === null) return 0;
    switch (typeof v) { case 'boolean': return 1; case 'number': return 2; case 'string': return 3; default: return Array.isArray(v) ? 4 : 5; }
  }
  function cmpVal(a, b) {
    var ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 2) return a - b;
    if (ra === 1 || ra === 3) return a < b ? -1 : (a > b ? 1 : 0);
    if (ra === 0) return 0;
    var ja = JSON.stringify(a), jb = JSON.stringify(b);
    return ja < jb ? -1 : (ja > jb ? 1 : 0);
  }
  function cmpId(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }
  function comparable(a, b) { var t = typeof a; return (t === 'number' || t === 'string' || t === 'boolean') && t === typeof b; }
  function matches(v, op, value) {
    if (v === undefined) return false; // dokument bez tego pola nie spełnia żadnego warunku
    switch (op) {
      case '==': return same(v, value);
      case '!=': return !same(v, value);
      case '<': return comparable(v, value) && v < value;
      case '<=': return comparable(v, value) && v <= value;
      case '>': return comparable(v, value) && v > value;
      case '>=': return comparable(v, value) && v >= value;
      case 'in': return value.some(function (x) { return same(v, x); });
      case 'not-in': return !value.some(function (x) { return same(v, x); });
      case 'array-contains': return Array.isArray(v) && v.some(function (x) { return same(x, value); });
      default: return false;
    }
  }
  function runQuery(q) {
    var m = colls.get(q._coll), rows = [];
    if (m) m.forEach(function (e, id) {
      for (var i = 0; i < q._filters.length; i++) {
        var f = q._filters[i];
        if (!matches(getPath(e.obj, f[0]), f[1], f[2])) return;
      }
      rows.push({ coll: q._coll, id: id, json: e.json, obj: e.obj });
    });
    if (q._order) {
      var field = q._order[0], desc = q._order[1] === 'desc';
      rows.sort(function (a, b) {
        var va = getPath(a.obj, field), vb = getPath(b.obj, field);
        var ma = va === undefined, mb = vb === undefined;
        if (ma || mb) return ma && mb ? cmpId(a.id, b.id) : (ma ? 1 : -1); // brak pola → na koniec
        var c = cmpVal(va, vb);
        if (desc) c = -c;
        return c || cmpId(a.id, b.id);
      });
    } else rows.sort(function (a, b) { return cmpId(a.id, b.id); });
    if (q._limit !== null) rows = rows.slice(0, q._limit);
    return rows;
  }

  function Query(coll, filters, order, limit) {
    this._coll = coll; this._filters = filters; this._order = order; this._limit = limit;
  }
  Query.prototype.where = function (field, op, value) {
    if (typeof field !== 'string' || !field) throw err('invalid_argument', 'where(): nazwa pola musi być tekstem.');
    if (OPS.indexOf(op) < 0) throw err('invalid_argument', 'where(): nieobsługiwany operator "' + op + '".');
    if ((op === 'in' || op === 'not-in') && !Array.isArray(value)) throw err('invalid_argument', 'where(): operator "' + op + '" wymaga tablicy.');
    if (value === undefined) throw err('invalid_argument', 'where(): brak wartości.');
    var v = JSON.parse(JSON.stringify(value));
    return new Query(this._coll, this._filters.concat([[field, op, v]]), this._order, this._limit);
  };
  Query.prototype.orderBy = function (field, dir) {
    if (this._order) throw err('invalid_argument', 'orderBy(): dozwolone jest tylko jedno sortowanie.');
    if (typeof field !== 'string' || !field) throw err('invalid_argument', 'orderBy(): nazwa pola musi być tekstem.');
    dir = dir === undefined ? 'asc' : dir;
    if (dir !== 'asc' && dir !== 'desc') throw err('invalid_argument', 'orderBy(): kierunek "asc" albo "desc".');
    return new Query(this._coll, this._filters, [field, dir], this._limit);
  };
  Query.prototype.limit = function (n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0 || Math.floor(n) !== n) throw err('invalid_argument', 'limit(): liczba całkowita ≥ 0.');
    return new Query(this._coll, this._filters, this._order, n);
  };
  Query.prototype.get = function () {
    var q = this;
    return ready.then(function () { return querySnap(runQuery(q), null); });
  };
  Query.prototype.onSnapshot = function (next, error) {
    return listen({ coll: this._coll, id: null, q: this }, next, error);
  };

  function CollectionRef(coll) {
    Query.call(this, checkId('kolekcji', coll), [], null, null);
    this.id = coll; this.path = coll;
  }
  CollectionRef.prototype = Object.create(Query.prototype);
  CollectionRef.prototype.constructor = CollectionRef;
  CollectionRef.prototype.doc = function (id) {
    return new DocRef(this._coll, id === undefined || id === null ? genId(20) : checkId('dokumentu', id));
  };
  CollectionRef.prototype.add = function (data) {
    var coll = this._coll;
    return ready.then(function () {
      var clean = toDocJson(data, false), id;
      do { id = genId(20); } while (entry(coll, id));
      return enqueueWrite([{ op: 'set', coll: coll, id: id, data: clean }]).then(function () { return new DocRef(coll, id); });
    });
  };

  function DocRef(coll, id) { this._coll = coll; this.id = id; this.path = coll + '/' + id; }
  DocRef.prototype.get = function () {
    var self = this;
    return ready.then(function () { var e = entry(self._coll, self.id); return docSnap(self._coll, self.id, e ? e.json : null); });
  };
  DocRef.prototype.set = function (data) {
    var self = this;
    return ready.then(function () {
      return enqueueWrite([{ op: 'set', coll: self._coll, id: self.id, data: toDocJson(data, false) }]);
    }).then(noop);
  };
  DocRef.prototype.update = function (data) {
    var self = this;
    return ready.then(function () {
      return enqueueWrite([{ op: 'update', coll: self._coll, id: self.id, data: toDocJson(data, true) }]);
    }).then(noop);
  };
  DocRef.prototype.delete = function () {
    var self = this;
    return ready.then(function () { return enqueueWrite([{ op: 'delete', coll: self._coll, id: self.id }]); }).then(noop);
  };
  DocRef.prototype.onSnapshot = function (next, error) {
    return listen({ coll: this._coll, id: this.id, q: null }, next, error);
  };
  Object.defineProperty(DocRef.prototype, 'parent', { get: function () { return new CollectionRef(this._coll); } });

  // Paczka zapisów (atomowo: wszystkie albo żaden) — db.batch().set(ref, data).update(...).delete(ref).commit()
  function WriteBatch() { this._w = []; this._done = false; }
  WriteBatch.prototype._add = function (op, ref, data) {
    if (this._done) throw err('invalid_argument', 'Ta paczka została już wysłana.');
    if (!(ref instanceof DocRef)) throw err('invalid_argument', 'Oczekiwano referencji dokumentu.');
    var w = { op: op, coll: ref._coll, id: ref.id };
    if (op !== 'delete') w.data = toDocJson(data, op === 'update');
    this._w.push(w); return this;
  };
  WriteBatch.prototype.set = function (ref, data) { return this._add('set', ref, data); };
  WriteBatch.prototype.update = function (ref, data) { return this._add('update', ref, data); };
  WriteBatch.prototype.delete = function (ref) { return this._add('delete', ref); };
  WriteBatch.prototype.commit = function () {
    var w = this._w; this._done = true;
    return ready.then(function () { return w.length ? enqueueWrite(w) : null; }).then(noop);
  };

  var dbApi = {
    collection: function (name) { return new CollectionRef(name); },
    doc: function (p) {
      var parts = String(p).split('/');
      if (parts.length !== 2) throw err('invalid_argument', 'db.doc(): oczekiwano ścieżki "kolekcja/id".');
      return new DocRef(checkId('kolekcji', parts[0]), checkId('dokumentu', parts[1]));
    },
    batch: function () { return new WriteBatch(); },
  };

  /* ---------------------------- kolejność zapisów ---------------------------- */
  // Zapisy dotyczące TEGO SAMEGO dokumentu wykonują się po kolei (np. szybkie przełączanie kuriera),
  // a zapisy różnych dokumentów mogą iść równolegle (np. wczytywanie kopii sześcioma „wątkami”).
  var keyChains = new Map(); // 'coll/id' -> obietnica ostatniego zapisu tego dokumentu (zawsze rozstrzygnięta)
  function enqueueWrite(writes) {
    var keys = [];
    writes.forEach(function (w) { var k = w.coll + '/' + w.id; if (keys.indexOf(k) < 0) keys.push(k); });
    var before = [];
    keys.forEach(function (k) { if (keyChains.has(k)) before.push(keyChains.get(k)); });
    var p = Promise.all(before).then(function () { return backend.write(writes); });
    var settled = p.then(noop, noop);
    keys.forEach(function (k) { keyChains.set(k, settled); });
    settled.then(function () { keys.forEach(function (k) { if (keyChains.get(k) === settled) keyChains.delete(k); }); });
    return p;
  }
  // wspólna logika scalania dla trybów localStorage/pamięć: current(coll,id) → obiekt|null
  function planWrites(writes, current) {
    var overlay = new Map(), out = [];
    writes.forEach(function (w) {
      var key = w.coll + '/' + w.id;
      var cur = overlay.has(key) ? overlay.get(key) : current(w.coll, w.id);
      var next;
      if (w.op === 'set') next = w.data;
      else if (w.op === 'update') {
        if (!cur) throw err('not_found', 'Dokument ' + key + ' nie istnieje.');
        next = merge(cur, w.data);
      } else next = null;
      overlay.set(key, next);
      out.push({ coll: w.coll, id: w.id, data: next, json: next === null ? null : JSON.stringify(next) });
    });
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* zasoby (loga) i pobieranie plików                                   */
  /* ------------------------------------------------------------------ */
  var EXT_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon' };
  function blobType(blob) {
    var t = (blob.type || '').toLowerCase();
    if (!t && blob.name) { var m = /\.([a-z0-9]+)$/i.exec(blob.name); if (m) t = EXT_MIME[m[1].toLowerCase()] || ''; }
    return t;
  }
  function checkUpload(blob) {
    if (!blob || typeof blob.size !== 'number' || typeof blob.slice !== 'function') throw err('invalid_argument', 'Oczekiwano pliku (Blob).');
    var type = blobType(blob);
    if (!/^image\/[a-z0-9.+-]+$/.test(type)) throw err('invalid_argument', 'Dozwolone są tylko obrazy (PNG, JPG, WEBP, SVG…).');
    if (blob.size > MAX_ASSET_BYTES) throw err('invalid_argument', 'Plik jest za duży (maks. 4 MB).');
    if (blob.size === 0) throw err('invalid_argument', 'Plik jest pusty.');
    return type;
  }
  function readDataUrl(blob, type) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () {
        var s = String(r.result);
        resolve(s.replace(/^data:[^;,]*/, 'data:' + type)); // poprawny typ nawet, gdy przeglądarka go nie zna
      };
      r.onerror = function () { reject(err('invalid_argument', 'Nie udało się odczytać pliku.')); };
      r.readAsDataURL(blob);
    });
  }
  var assetsApi = {
    upload: function (blob) { return ready.then(function () { var type = checkUpload(blob); return backend.uploadAsset(blob, type); }); },
    list: function () { return ready.then(function () { return backend.listAssets(); }); },
    delete: function (id) { return ready.then(function () { return backend.deleteAsset(String(id)); }).then(noop); },
  };

  function mimeFor(name, isText) {
    var ext = (/\.([a-z0-9]+)$/i.exec(name || '') || [])[1];
    ext = ext ? ext.toLowerCase() : '';
    var map = { csv: 'text/csv', json: 'application/json', txt: 'text/plain', html: 'text/html', xml: 'application/xml', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    var t = map[ext] || (isText ? 'text/plain' : 'application/octet-stream');
    return isText && /^(text\/|application\/(json|xml))/.test(t) ? t + ';charset=utf-8' : t;
  }
  var downloadsApi = {
    save: function (opts) {
      return new Promise(function (resolve, reject) {
        if (!opts || typeof opts.filename !== 'string' || !opts.filename.trim()) { reject(err('invalid_argument', 'Brak nazwy pliku.')); return; }
        var name = opts.filename.replace(/[\/\\?%*:|"<>\u0000-\u001f]/g, '_').trim();
        var data = opts.data, type = opts.mimeType || opts.contentType, blob;
        if (typeof Blob !== 'undefined' && data instanceof Blob) blob = type ? new Blob([data], { type: type }) : data;
        else if (typeof data === 'string') blob = new Blob([data], { type: type || mimeFor(name, true) });
        else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) blob = new Blob([data], { type: type || mimeFor(name, false) });
        else { reject(err('invalid_argument', 'Nieobsługiwany typ danych pliku.')); return; }
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = name; a.rel = 'noopener'; a.style.display = 'none';
        (document.body || document.documentElement).appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 60000);
        resolve();
      });
    },
  };

  /* ------------------------------------------------------------------ */
  /* TRYB SERWERA                                                       */
  /* ------------------------------------------------------------------ */
  function fetchJson(url, opts, timeoutMs) {
    opts = opts || {};
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = null;
    var init = { method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body, cache: 'no-store', credentials: 'same-origin' };
    if (ctrl) init.signal = ctrl.signal;
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () { if (ctrl) ctrl.abort(); reject(err('unavailable', 'Serwer nie odpowiada.')); }, timeoutMs || WRITE_TIMEOUT_MS);
    });
    var req = fetch(url, init).then(function (r) {
      return r.text().then(function (t) {
        var body = null; try { body = t ? JSON.parse(t) : null; } catch (e) { body = null; }
        if (r.ok) return body;
        var code = body && body.error;
        var msg = (body && body.message) || ('HTTP ' + r.status);
        if (r.status === 404 && code === 'not_found') throw err('not_found', msg);
        if (r.status === 400 || r.status === 413 || r.status === 415) throw err('invalid_argument', msg);
        if (r.status === 507 || code === 'quota_exceeded') throw err('quota_exceeded', msg);
        if (r.status === 401) throw err('unavailable', 'Wymagane hasło — odśwież stronę i zaloguj się ponownie.');
        throw err('unavailable', msg);
      });
    }).then(null, function (e) {
      if (e && typeof e.code === 'string') throw e;
      throw err('unavailable', 'Brak połączenia z serwerem.'); // sieć, przerwane połączenie, przekroczony czas
    });
    return Promise.race([req, timeout]).then(function (v) { clearTimeout(timer); return v; }, function (e) { clearTimeout(timer); throw e; });
  }

  function pingServer() {
    if (!/^https?:$/.test(window.location.protocol) || typeof fetch !== 'function') return Promise.resolve('none');
    function once() {
      return fetchJson(API + 'ping', { headers: { Accept: 'application/json' } }, PING_TIMEOUT_MS).then(function (j) {
        return j && j.app === APP ? 'server' : 'none';
      }, function (e) { return e.code === 'unavailable' && !/HTTP \d/.test(e.message) ? 'unreachable' : 'none'; });
    }
    // jeden ponowny strzał przy braku odpowiedzi (np. NAS wybudzający się) — 404 itp. rozstrzyga od razu
    return once().then(function (r) { return r === 'unreachable' ? once() : r; });
  }

  function ServerBackend() {
    this.kind = 'server';
    this.clientId = genId(16);
    this.snapRev = 0;
    this.docRev = new Map();     // 'coll/id' -> rev ostatnio zastosowanej zmiany
    this.es = null;
    this.everConnected = false;
    this.online = false;
    this.buffer = null;          // zdarzenia odebrane w trakcie ponownego wczytywania
    this.lastSeen = 0;
    this.retry = 0;
    this.reconnectTimer = null;
    this.offlineTimer = null;
    this.assets = new Map();
  }
  ServerBackend.prototype.init = function () {
    var self = this;
    return new Promise(function (resolve) {
      var attempt = 0;
      (function tryLoad() {
        self.loadSnapshot().then(function () {
          self.connect();
          self.startWatchdog();
          resolve();
        }, function () {
          attempt++;
          self.setOnline(false, true);
          setTimeout(tryLoad, Math.min(10000, 1000 * Math.pow(2, Math.min(attempt, 4))));
        });
      })();
    });
  };
  ServerBackend.prototype.loadSnapshot = function () {
    var self = this;
    return fetchJson(API + 'snapshot', {}, 20000).then(function (snap) {
      if (!snap || !isObj(snap.collections)) throw err('unavailable', 'Nieprawidłowa odpowiedź serwera.');
      var next = new Map();
      Object.keys(snap.collections).forEach(function (c) {
        var docs = snap.collections[c], m = new Map();
        Object.keys(docs).forEach(function (id) { m.set(id, JSON.stringify(docs[id])); });
        next.set(c, m);
      });
      var rev = Number(snap.rev) || 0;
      replaceMirror(next, function (c, id) { var r = self.docRev.get(c + '/' + id); return r !== undefined && r > rev; });
      self.docRev.forEach(function (r, k) { if (r <= rev) self.docRev.delete(k); });
      self.snapRev = rev;
      self.assets = new Map();
      (snap.assets || []).forEach(function (a) { self.assets.set(a.id, a); });
      return rev;
    });
  };
  ServerBackend.prototype.applyEvent = function (ev) {
    if (!ev || typeof ev.coll !== 'string' || typeof ev.id !== 'string') return;
    var key = ev.coll + '/' + ev.id, known = this.docRev.get(key);
    if (ev.rev <= this.snapRev || (known !== undefined && ev.rev <= known)) return; // echo / stare
    this.docRev.set(key, ev.rev);
    applyChange(ev.coll, ev.id, ev.data === null || ev.data === undefined ? null : JSON.stringify(ev.data), false);
  };
  ServerBackend.prototype.connect = function () {
    var self = this;
    clearTimeout(this.reconnectTimer);
    if (this.es) { this.es.onerror = null; this.es.close(); }
    if (typeof EventSource !== 'function') { warn('Brak EventSource — zmiany z innych urządzeń pojawią się po odświeżeniu.'); this.setOnline(true); return; }
    var es = this.es = new EventSource(API + 'events');
    this.lastSeen = Date.now();
    es.onopen = function () { self.lastSeen = Date.now(); };
    es.addEventListener('hello', function (e) {
      self.lastSeen = Date.now();
      var h = {}; try { h = JSON.parse(e.data); } catch (x) { /* ignore */ }
      var reconnect = self.everConnected;
      self.everConnected = true; self.retry = 0;
      if (reconnect || Number(h.rev) !== self.snapRev) self.resync();
      else self.setOnline(true);
    });
    es.addEventListener('change', function (e) {
      self.lastSeen = Date.now();
      var ev; try { ev = JSON.parse(e.data); } catch (x) { return; }
      if (self.buffer) self.buffer.push(ev); else self.applyEvent(ev);
    });
    es.addEventListener('ping', function () { self.lastSeen = Date.now(); });
    es.addEventListener('reset', function () { self.lastSeen = Date.now(); self.resync(); });
    es.onerror = function () {
      if (self.es !== es) return;
      self.setOnline(false);
      if (es.readyState === 2) self.scheduleReconnect(); // CLOSED — przeglądarka sama już nie spróbuje
    };
  };
  ServerBackend.prototype.scheduleReconnect = function () {
    var self = this;
    clearTimeout(this.reconnectTimer);
    this.retry++;
    this.reconnectTimer = setTimeout(function () { self.connect(); }, Math.min(10000, 500 * Math.pow(2, Math.min(this.retry, 5))));
  };
  ServerBackend.prototype.resync = function () {
    var self = this;
    if (this.buffer) return; // już trwa
    this.buffer = [];
    this.loadSnapshot().then(function () {
      var buf = self.buffer; self.buffer = null;
      buf.forEach(function (ev) { self.applyEvent(ev); });
      touchAll(); // ponowne dostarczenie wszystkim nasłuchom
      self.setOnline(true);
    }, function () {
      self.buffer = null;
      self.setOnline(false);
      if (self.es) { self.es.onerror = null; self.es.close(); self.es = null; }
      self.scheduleReconnect();
    });
  };
  ServerBackend.prototype.startWatchdog = function () {
    var self = this;
    setInterval(function () {
      if (self.es && Date.now() - self.lastSeen > SSE_SILENCE_MS) { self.setOnline(false); self.connect(); }
    }, 10000);
    var kick = function () { if (!self.online) { self.retry = 0; self.connect(); } };
    window.addEventListener('online', kick);
    window.addEventListener('pageshow', function (e) { if (e.persisted) { self.everConnected = true; self.connect(); } });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') kick(); });
  };
  ServerBackend.prototype.setOnline = function (on, immediate) {
    var self = this;
    this.online = on;
    if (window.EP_LOCAL) window.EP_LOCAL.online = on;
    clearTimeout(this.offlineTimer);
    if (on) { hideBanner('offline'); return; }
    var show = function () { if (!self.online) showBanner('offline', 'Brak połączenia z serwerem — zmiany nie są zapisywane'); };
    if (immediate) show(); else this.offlineTimer = setTimeout(show, 1000); // bez migania przy krótkiej przerwie
  };
  ServerBackend.prototype.post = function (path, body) {
    var self = this;
    return fetchJson(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, WRITE_TIMEOUT_MS)
      .then(null, function (e) {
        if (e.code === 'unavailable') { self.setOnline(false, true); if (!self.es || self.es.readyState === 2) self.scheduleReconnect(); }
        throw e;
      });
  };
  ServerBackend.prototype.write = function (writes) {
    var self = this;
    var single = writes.length === 1;
    var req = single
      ? this.post('write', { op: writes[0].op, coll: writes[0].coll, id: writes[0].id, data: writes[0].data, clientId: this.clientId })
      : this.post('batch', { writes: writes, clientId: this.clientId });
    return req.then(function (res) {
      var results = single
        ? [{ coll: writes[0].coll, id: writes[0].id, rev: res.changed === false ? null : res.rev, data: res.data }]
        : (res.results || []);
      results.forEach(function (r) {
        var key = r.coll + '/' + r.id;
        if (r.rev !== null && r.rev !== undefined) {
          var known = self.docRev.get(key);
          if (known !== undefined && known > r.rev) { touch(r.coll, r.id); return; } // nowsza zmiana już dotarła
          self.docRev.set(key, r.rev);
        }
        applyChange(r.coll, r.id, r.data === null || r.data === undefined ? null : JSON.stringify(r.data), true);
      });
      if (!single) writes.forEach(function (w) { touch(w.coll, w.id); });
      return results;
    });
  };
  ServerBackend.prototype.assetUrl = function (id) { return BASE + '_blob/' + encodeURIComponent(id); };
  ServerBackend.prototype.uploadAsset = function (blob, type) {
    var self = this;
    return fetchJson(API + 'assets', { method: 'POST', headers: { 'Content-Type': type }, body: blob }, WRITE_TIMEOUT_MS).then(function (res) {
      var a = { id: res.id, url: self.assetUrl(res.id), sizeBytes: res.sizeBytes, contentType: res.contentType };
      self.assets.set(a.id, a);
      return a;
    }, function (e) { if (e.code === 'unavailable') self.setOnline(false, true); throw e; });
  };
  ServerBackend.prototype.listAssets = function () {
    var self = this;
    return fetchJson(API + 'assets', {}, 20000).then(function (res) {
      var list = (res.assets || []).map(function (a) { return { id: a.id, url: self.assetUrl(a.id), sizeBytes: a.sizeBytes, contentType: a.contentType }; });
      return { assets: list, usage: { bytes: (res.usage && res.usage.bytes) || 0 } };
    });
  };
  ServerBackend.prototype.deleteAsset = function (id) {
    var self = this;
    return fetchJson(API + 'assets/' + encodeURIComponent(id), { method: 'DELETE' }, WRITE_TIMEOUT_MS).then(function () { self.assets.delete(id); });
  };

  /* ------------------------------------------------------------------ */
  /* TRYB PRZEGLĄDARKI                                                  */
  /* ------------------------------------------------------------------ */
  var tabId = genId(12);
  var seenMsgs = [];
  var channel = null;
  try { if (typeof BroadcastChannel === 'function') channel = new BroadcastChannel(APP); } catch (e) { channel = null; }

  function lsAvailable() {
    try { var k = LSP + 'test'; window.localStorage.setItem(k, '1'); window.localStorage.removeItem(k); return true; } catch (e) { return false; }
  }
  function isQuota(e) { return !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014); }

  // powiadomienie innych kart: BroadcastChannel, a gdy go brak (Safari < 15.4) — zdarzenie storage
  function broadcast(msg) {
    msg.app = APP; msg.from = tabId; msg.n = genId(10);
    if (channel) { try { channel.postMessage(msg); return; } catch (e) { /* spróbuj localStorage */ } }
    try { window.localStorage.setItem(LSP + 'sygnal', JSON.stringify(msg)); } catch (e) { /* trudno */ }
  }
  var inbox = Promise.resolve();
  function onMessage(msg) {
    if (!msg || msg.app !== APP || msg.from === tabId || !backend || !backend.onRemote) return;
    if (seenMsgs.indexOf(msg.n) >= 0) return;
    seenMsgs.push(msg.n); if (seenMsgs.length > 200) seenMsgs.shift();
    // komunikaty obsługujemy po kolei: logo trafia do pamięci podręcznej przed kurierem, który go używa
    inbox = inbox.then(function () { return backend.onRemote(msg); }).then(null, function (e) { warn('synchronizacja kart:', e); });
  }
  if (channel) channel.onmessage = function (e) { onMessage(e.data); };

  /* ---------------------------- IndexedDB ---------------------------- */
  function idbOpen() {
    return new Promise(function (resolve, reject) {
      var idb; try { idb = window.indexedDB; } catch (e) { idb = null; }
      if (!idb) { reject(new Error('Brak IndexedDB')); return; }
      var done = false, req;
      var timer = setTimeout(function () { if (!done) { done = true; reject(new Error('IndexedDB nie odpowiada')); } }, 8000);
      try { req = idb.open(APP, 1); } catch (e) { clearTimeout(timer); reject(e); return; }
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs');
        if (!d.objectStoreNames.contains('assets')) d.createObjectStore('assets');
      };
      req.onsuccess = function () {
        var d = req.result;
        if (done) { try { d.close(); } catch (e) { /* ignore */ } return; }
        done = true; clearTimeout(timer);
        d.onversionchange = function () { d.close(); };
        resolve(d);
      };
      req.onerror = function () { if (!done) { done = true; clearTimeout(timer); reject(req.error || new Error('IndexedDB: błąd')); } };
    });
  }
  function idbErr(e) {
    if (e && e.code && typeof e.code === 'string') return e;
    if (isQuota(e)) return err('quota_exceeded', 'Brak miejsca w pamięci przeglądarki.');
    return err('unavailable', 'Nie udało się zapisać w pamięci przeglądarki' + (e && e.message ? ' (' + e.message + ')' : '') + '.');
  }
  function rwTx(db, stores) {
    try { return db.transaction(stores, 'readwrite', { durability: 'strict' }); }
    catch (e) { return db.transaction(stores, 'readwrite'); }
  }
  function splitKey(key) { var i = key.indexOf('/'); return [key.slice(0, i), key.slice(i + 1)]; }

  function IdbBackend(db) { this.kind = 'indexeddb'; this.db = db; this.assets = new Map(); }
  IdbBackend.prototype.load = function () {
    var self = this;
    return new Promise(function (resolve, reject) {
      var tx = self.db.transaction(['docs', 'assets'], 'readonly');
      var docs = null, assets = null;
      tx.objectStore('docs').getAll().onsuccess = function (e) { docs = e.target.result; };
      tx.objectStore('assets').getAll().onsuccess = function (e) { assets = e.target.result; };
      tx.oncomplete = function () {
        var next = new Map();
        (docs || []).forEach(function (r) {
          if (!r || typeof r.coll !== 'string' || typeof r.id !== 'string' || !isObj(r.data)) return;
          if (!next.has(r.coll)) next.set(r.coll, new Map());
          next.get(r.coll).set(r.id, JSON.stringify(r.data));
        });
        replaceMirror(next, null);
        self.assets = new Map();
        (assets || []).forEach(function (a) { if (a && a.id) self.assets.set(a.id, a); });
        resolve();
      };
      tx.onabort = function () { reject(tx.error || new Error('IndexedDB: odczyt przerwany')); };
    });
  };
  IdbBackend.prototype.write = function (writes) {
    var db = this.db;
    return new Promise(function (resolve, reject) {
      var tx, abortErr = null, results = [], overlay = new Map(), now = Date.now();
      try { tx = rwTx(db, ['docs']); } catch (e) { reject(idbErr(e)); return; }
      var st = tx.objectStore('docs');
      function put(w, data) {
        var key = w.coll + '/' + w.id;
        if (data === null) st.delete(key);
        else st.put({ coll: w.coll, id: w.id, data: data, updatedAt: now }, key);
        overlay.set(key, data);
        results.push({ coll: w.coll, id: w.id, json: data === null ? null : JSON.stringify(data) });
      }
      // po kolei w jednej transakcji; update czyta aktualną wersję z IndexedDB (zmiany innych kart też)
      function step(i) {
        while (i < writes.length) {
          var w = writes[i], key = w.coll + '/' + w.id;
          if (w.op === 'set') put(w, w.data);
          else if (w.op === 'delete') put(w, null);
          else if (overlay.has(key)) {
            if (!overlay.get(key)) { abortErr = err('not_found', 'Dokument ' + key + ' nie istnieje.'); tx.abort(); return; }
            put(w, merge(overlay.get(key), w.data));
          } else {
            var r = st.get(key);
            r.onsuccess = (function (w2, i2) {
              return function (e) {
                var rec = e.target.result;
                if (!rec || !isObj(rec.data)) { abortErr = err('not_found', 'Dokument ' + w2.coll + '/' + w2.id + ' nie istnieje.'); try { tx.abort(); } catch (x) { /* ignore */ } return; }
                put(w2, merge(rec.data, w2.data));
                step(i2 + 1);
              };
            })(w, i);
            return;
          }
          i++;
        }
      }
      tx.oncomplete = function () {
        results.forEach(function (r) { applyChange(r.coll, r.id, r.json, true); });
        broadcast({ t: 'docs', keys: results.map(function (r) { return r.coll + '/' + r.id; }) });
        resolve(results);
      };
      tx.onabort = function () { reject(abortErr || idbErr(tx.error)); };
      try { step(0); } catch (e) { abortErr = idbErr(e); try { tx.abort(); } catch (x) { reject(abortErr); } }
    });
  };
  IdbBackend.prototype.onRemote = function (msg) {
    var self = this;
    if (msg.t === 'reset') return this.load().then(touchAll);
    return new Promise(function (resolve) {
      var tx = self.db.transaction(['docs', 'assets'], 'readonly');
      var docs = [], assets = [];
      (msg.keys || []).forEach(function (key) {
        tx.objectStore('docs').get(key).onsuccess = function (e) { docs.push([key, e.target.result]); };
      });
      (msg.assets || []).forEach(function (id) {
        tx.objectStore('assets').get(id).onsuccess = function (e) { assets.push([id, e.target.result]); };
      });
      tx.oncomplete = function () {
        assets.forEach(function (a) { if (a[1]) self.assets.set(a[0], a[1]); else self.assets.delete(a[0]); });
        docs.forEach(function (d) {
          var kc = splitKey(d[0]), rec = d[1];
          applyChange(kc[0], kc[1], rec && isObj(rec.data) ? JSON.stringify(rec.data) : null, false);
        });
        resolve();
      };
      tx.onabort = function () { resolve(); };
    });
  };
  IdbBackend.prototype.putAsset = function (rec) {
    var db = this.db;
    return new Promise(function (resolve, reject) {
      var tx; try { tx = rwTx(db, ['assets']); } catch (e) { reject(idbErr(e)); return; }
      if (rec.dataUrl === null) tx.objectStore('assets').delete(rec.id); else tx.objectStore('assets').put(rec, rec.id);
      tx.oncomplete = function () { resolve(); };
      tx.onabort = function () { reject(idbErr(tx.error)); };
    });
  };

  /* ---------------------------- localStorage / pamięć ---------------------------- */
  function LsBackend() { this.kind = 'localstorage'; this.assets = new Map(); }
  LsBackend.prototype.load = function () {
    var ls = window.localStorage, next = new Map(), self = this;
    for (var i = 0; i < ls.length; i++) {
      var k = ls.key(i);
      if (!k || k.indexOf(LSP) !== 0) continue;
      try {
        var v = JSON.parse(ls.getItem(k));
        if (k.indexOf(LSP + 'd:') === 0 && v && isObj(v.data)) {
          if (!next.has(v.coll)) next.set(v.coll, new Map());
          next.get(v.coll).set(v.id, JSON.stringify(v.data));
        } else if (k.indexOf(LSP + 'a:') === 0 && v && v.id) self.assets.set(v.id, v);
      } catch (e) { warn('pominięto uszkodzony wpis', k); }
    }
    replaceMirror(next, null);
    return Promise.resolve();
  };
  LsBackend.prototype.current = function (coll, id) {
    try { var v = JSON.parse(window.localStorage.getItem(LSP + 'd:' + coll + '/' + id)); return v && isObj(v.data) ? v.data : null; }
    catch (e) { var en = entry(coll, id); return en ? JSON.parse(en.json) : null; }
  };
  LsBackend.prototype.write = function (writes) {
    var self = this;
    return new Promise(function (resolve) {
      var plan = planWrites(writes, function (c, id) { return self.current(c, id); });
      var ls = window.localStorage, undo = [], now = Date.now();
      try {
        plan.forEach(function (p) {
          var k = LSP + 'd:' + p.coll + '/' + p.id;
          undo.push([k, ls.getItem(k)]);
          if (p.data === null) ls.removeItem(k);
          else ls.setItem(k, JSON.stringify({ coll: p.coll, id: p.id, data: p.data, updatedAt: now }));
        });
      } catch (e) {
        undo.reverse().forEach(function (u) { try { if (u[1] === null) ls.removeItem(u[0]); else ls.setItem(u[0], u[1]); } catch (x) { /* ignore */ } });
        throw isQuota(e) ? err('quota_exceeded', 'Brak miejsca w pamięci przeglądarki (localStorage).') : err('unavailable', 'Nie udało się zapisać danych: ' + e.message);
      }
      plan.forEach(function (p) { applyChange(p.coll, p.id, p.json, true); });
      resolve(plan);
    });
  };
  LsBackend.prototype.putAsset = function (rec) {
    try {
      if (rec.dataUrl === null) window.localStorage.removeItem(LSP + 'a:' + rec.id);
      else window.localStorage.setItem(LSP + 'a:' + rec.id, JSON.stringify(rec));
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(isQuota(e) ? err('quota_exceeded', 'Brak miejsca w pamięci przeglądarki (localStorage) na to logo.') : err('unavailable', e.message));
    }
  };

  function MemBackend() { this.kind = 'memory'; this.assets = new Map(); }
  MemBackend.prototype.load = function () { return Promise.resolve(); };
  MemBackend.prototype.write = function (writes) {
    return new Promise(function (resolve) {
      var plan = planWrites(writes, function (c, id) { var e = entry(c, id); return e ? JSON.parse(e.json) : null; });
      plan.forEach(function (p) { applyChange(p.coll, p.id, p.json, true); });
      resolve(plan);
    });
  };
  MemBackend.prototype.putAsset = function () { return Promise.resolve(); };

  // wspólne dla trybów przeglądarki: loga jako data URL w pamięci podręcznej (assetUrl musi być synchroniczne)
  [IdbBackend, LsBackend, MemBackend].forEach(function (B) {
    B.prototype.assetUrl = function (id) {
      // null dla nieznanego logo: aplikacja pobiera loga przez fetch(assetSrc(id)) do kopii zapasowej,
      // więc nie wolno podsuwać „zastępczego” obrazka — trafiłby do kopii jako prawdziwe logo
      var a = this.assets.get(id);
      return a && a.dataUrl ? a.dataUrl : null;
    };
    B.prototype.uploadAsset = function (blob, type) {
      var self = this;
      return readDataUrl(blob, type).then(function (dataUrl) {
        var id; do { id = genId(20); } while (self.assets.has(id));
        var rec = { id: id, dataUrl: dataUrl, contentType: type, sizeBytes: blob.size };
        return self.putAsset(rec).then(function () {
          self.assets.set(id, rec);
          if (self.kind === 'indexeddb') broadcast({ t: 'assets', assets: [id] });
          return { id: id, url: dataUrl, sizeBytes: rec.sizeBytes, contentType: type };
        });
      });
    };
    B.prototype.listAssets = function () {
      var list = [], bytes = 0;
      this.assets.forEach(function (a) { list.push({ id: a.id, url: a.dataUrl, sizeBytes: a.sizeBytes, contentType: a.contentType }); bytes += a.sizeBytes || 0; });
      return Promise.resolve({ assets: list, usage: { bytes: bytes } });
    };
    B.prototype.deleteAsset = function (id) {
      var self = this;
      if (!this.assets.has(id)) return Promise.resolve();
      return this.putAsset({ id: id, dataUrl: null }).then(function () {
        self.assets.delete(id);
        if (self.kind === 'indexeddb') broadcast({ t: 'assets', assets: [id] });
      });
    };
  });

  // zdarzenie storage: sygnały z innych kart (gdy brak BroadcastChannel) + zmiany w trybie localStorage
  window.addEventListener('storage', function (e) {
    if (!backend || !e.key || e.key.indexOf(LSP) !== 0) return;
    if (e.key === LSP + 'sygnal') { try { onMessage(JSON.parse(e.newValue)); } catch (x) { /* ignore */ } return; }
    if (backend.kind !== 'localstorage') return;
    try {
      var v = e.newValue ? JSON.parse(e.newValue) : null;
      if (e.key.indexOf(LSP + 'd:') === 0) {
        var kc = splitKey(e.key.slice(LSP.length + 2));
        applyChange(kc[0], kc[1], v && isObj(v.data) ? JSON.stringify(v.data) : null, false);
      } else if (e.key.indexOf(LSP + 'a:') === 0) {
        var id = e.key.slice(LSP.length + 2);
        if (v) backend.assets.set(id, v); else backend.assets.delete(id);
      }
    } catch (x) { warn('synchronizacja kart (localStorage):', x); }
  });

  function initBrowser(serverUnreachable) {
    var isFirefox = /firefox/i.test(navigator.userAgent || '');
    function persist() { try { if (!isFirefox && navigator.storage && navigator.storage.persist) navigator.storage.persist().then(noop, noop); } catch (e) { /* ignore */ } }
    function useMemory(reason) {
      backend = new MemBackend();
      warn('Dane tylko w pamięci:', reason);
      showBanner('pamiec', 'Uwaga: ta przeglądarka nie pozwala zapisywać danych — zmiany znikną po zamknięciu karty');
      return backend.load();
    }
    function useLs() {
      if (!lsAvailable()) return useMemory('brak IndexedDB i localStorage');
      backend = new LsBackend();
      persist();
      return backend.load().then(null, function (e) { return useMemory(e && e.message); });
    }
    return idbOpen().then(function (db) {
      var b = new IdbBackend(db);
      return b.load().then(function () { backend = b; persist(); });
    }).then(null, function (e) {
      warn('IndexedDB niedostępne (' + (e && e.message) + ') — używam localStorage.');
      return useLs();
    }).then(function () {
      if (serverUnreachable) showBanner('tryb', 'Serwer nie odpowiada — dane zapisywane tylko w tej przeglądarce. Odśwież stronę, gdy serwer będzie dostępny.');
    });
  }

  /* ------------------------------------------------------------------ */
  /* start                                                              */
  /* ------------------------------------------------------------------ */
  var backend = null;
  var LABELS = {
    server: function () { return 'Tryb serwera — wspólne dane zapisywane na serwerze ' + window.location.host; },
    indexeddb: function () { return 'Tryb przeglądarki — dane zapisywane w tej przeglądarce na tym urządzeniu (IndexedDB)'; },
    localstorage: function () { return 'Tryb przeglądarki — dane w pamięci lokalnej tej przeglądarki (localStorage, ograniczona pojemność)'; },
    memory: function () { return 'Tryb tymczasowy — dane NIE są zapisywane i znikną po zamknięciu karty'; },
  };

  var EP = {
    __runtime: true,
    version: VERSION,
    mode: /^https?:$/.test(window.location.protocol) ? null : 'browser',
    storage: null,
    label: 'Uruchamianie…',
    online: null,
    assetUrl: function (id) {
      try { return backend && id ? backend.assetUrl(String(id)) : null; } catch (e) { return null; }
    },
    ready: null,
  };

  var ready = pingServer().then(function (r) {
    if (r === 'server') { var b = new ServerBackend(); backend = b; return b.init(); }
    return initBrowser(r === 'unreachable');
  }).then(function () {
    EP.mode = backend.kind === 'server' ? 'server' : 'browser';
    EP.storage = backend.kind;
    EP.label = LABELS[backend.kind]();
    if (EP.mode === 'browser') EP.online = null;
    return { mode: EP.mode, storage: EP.storage, label: EP.label };
  });
  ready.then(null, function (e) { warn('start nie powiódł się:', e); });
  EP.ready = ready;

  window.EP_LOCAL = EP;
  window.claude = {
    use: function (name) {
      return ready.then(function () {
        if (name === 'db') return dbApi;
        if (name === 'assets') return assetsApi;
        if (name === 'downloads') return downloadsApi;
        return null;
      });
    },
  };
})(window, document);
