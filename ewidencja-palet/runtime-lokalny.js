/* =========================================================================
   EWIDENCJA PALET — runtime lokalny (wersja offline / serwer w sieci lokalnej)

   Zastępuje platformę Claude: definiuje window.claude.use('db'|'assets'|'downloads')
   oraz window.EP_LOCAL. Aplikacja (index.html) pozostaje identyczna z wersją online.

   Tryby:
   • 'server'  — strona otwarta z serwera (node server.js): wspólna baza na serwerze,
                 zmiany na żywo między urządzeniami (SSE), zapis przez POST. Gdy serwer
                 nie odpowiada — pasek „Brak połączenia z serwerem — zmiany nie są
                 zapisywane” (znika po pierwszym udanym żądaniu) i ponowne próby; NIGDY ciche
                 przejście na zapis w przeglądarce. get() i acquire() nie odpowiadają z
                 nieaktualnego lustra (karta z tła, zawieszone połączenie, trwające wczytywanie):
                 porównują numer zmian z serwerem (GET /api/rev) i w razie potrzeby wczytują stan.
   • 'browser' — strona otwarta z dysku (file://) albo ze zwykłego serwera WWW bez API:
                 dane w tej przeglądarce (IndexedDB → localStorage → tylko pamięć z
                 ostrzeżeniem), synchronizacja między kartami (BroadcastChannel / storage,
                 paczkami). get() czyta prosto z IndexedDB / localStorage; dzierżawa w trybie
                 localStorage przez Web Locks (atomowo między kartami).

   Semantyka jak baza artefaktu w Claude (umowa runtime 0.2.x): collection/doc/where/orderBy/
   limit/get/onSnapshot (asynchronicznie, scalane, docChanges)/set/update (rekurencyjne scalanie,
   {__delete__:true} usuwa pole, brak dokumentu → kod not_found)/delete/add/acquire (dzierżawa);
   zapis kończy się dopiero po trwałym zapisie (dysk serwera / transakcja IndexedDB).

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
  var BASE = window.location.pathname.replace(/[^\/]*$/, '') || '/';
  var API = BASE + 'api/';
  var LSP = APP + ':';         // prefiks kluczy localStorage
  var noop = function () {};

  /* ------------------------------------------------------------------ */
  /* narzędzia                                                          */
  /* ------------------------------------------------------------------ */
  function err(code, message) { var e = new Error(message); e.code = code; return e; }
  // błąd budowania ścieżki: jak na platformie — TypeError rzucany synchronicznie (z kodem dla wygody)
  function typeErr(message) { var e = new TypeError(message); e.code = 'invalid_argument'; return e; }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function isDel(v) { return isObj(v) && v.__delete__ === true && Object.keys(v).length === 1; }
  function defProp(o, k, v) { Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true }); }
  // usuwa znaczniki {__delete__:true} na każdym poziomie (set zapisuje dokument bez nich)
  function stripDel(d) {
    var o = {};
    Object.keys(d).forEach(function (k) { if (!isDel(d[k])) defProp(o, k, isObj(d[k]) ? stripDel(d[k]) : d[k]); });
    return o;
  }
  // update: zagnieżdżone obiekty scalają się rekurencyjnie (jak na platformie), tablice i reszta
  // zastępują pole w całości, {__delete__:true} usuwa pole (także zagnieżdżone)
  function merge(base, patch) {
    var o = {};
    Object.keys(base).forEach(function (k) { defProp(o, k, base[k]); });
    Object.keys(patch).forEach(function (k) {
      var v = patch[k];
      if (isDel(v)) delete o[k];
      else if (isObj(v) && isObj(o[k])) defProp(o, k, merge(o[k], v));
      else defProp(o, k, isObj(v) ? stripDel(v) : v);
    });
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
    if (typeof v !== 'string' || !ID_RE.test(v) || v === '.' || v === '..') throw typeErr('Nieprawidłowa nazwa ' + kind + ': "' + v + '"');
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
  // opts.button + opts.onClose: komunikat z przyciskiem (np. „Rozumiem”), który trzeba świadomie zamknąć
  function showBanner(key, text, opts) {
    onBody(function () {
      if (!bannerBox) {
        // klasa ep-runtime-banner: aplikacja ukrywa ją w @media print (wydruk WZ/PZ, rozliczenia);
        // własna reguła druku na wypadek starszej wersji aplikacji bez tej reguły
        var css = document.createElement('style');
        css.textContent = '@media print{#ep-local-banners,.ep-runtime-banner{display:none !important;}}';
        (document.head || document.documentElement).appendChild(css);
        bannerBox = document.createElement('div');
        bannerBox.id = 'ep-local-banners';
        bannerBox.className = 'ep-runtime-banner';
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
      if (opts && opts.button) {
        el.setAttribute('role', 'alert');
        el.style.pointerEvents = 'auto';
        el.style.textAlign = 'left';
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = opts.button;
        btn.setAttribute('data-ep-banner-zamknij', key);
        btn.setAttribute('style', 'display:block;margin:6px 0 0 auto;padding:5px 12px;border-radius:7px;cursor:pointer;' +
          'border:1px solid var(--bad,#C2570A);background:var(--bad,#C2570A);color:#fff;font:600 12.5px/1.2 "Space Grotesk",system-ui,-apple-system,"Segoe UI",sans-serif;');
        btn.addEventListener('click', function () { hideBanner(key); if (opts.onClose) opts.onClose(); });
        el.appendChild(btn);
      }
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
  // zastępuje całe lustro (np. po ponownym wczytaniu z serwera); keep(coll,id) → zostaw wersję lokalną;
  // notify → powiadom nasłuchy o dokumentach, które się zmieniły
  function replaceMirror(next, keep, notify) {
    var names = new Set(); colls.forEach(function (_, c) { names.add(c); }); next.forEach(function (_, c) { names.add(c); });
    names.forEach(function (c) {
      var ids = new Set(), cur = colls.get(c), nx = next.get(c);
      if (cur) cur.forEach(function (_, id) { ids.add(id); });
      if (nx) nx.forEach(function (_, id) { ids.add(id); });
      ids.forEach(function (id) {
        if (keep && keep(c, id)) return;
        if (putEntry(c, id, (nx && nx.has(id)) ? nx.get(id) : null) && notify) touch(c, id);
      });
    });
  }
  // jedna kolekcja z aktualnymi danymi z magazynu (fresh: Map id → json): dopasuj lustro i powiadom nasłuchy
  function reconcileColl(coll, fresh) {
    var cur = colls.get(coll), gone = [];
    if (cur) cur.forEach(function (_, id) { if (!fresh.has(id)) gone.push(id); });
    gone.forEach(function (id) { applyChange(coll, id, null, false); });
    fresh.forEach(function (json, id) { applyChange(coll, id, json, false); });
  }
  // przed odpowiedzią na get(): w trybie serwera lustro musi obejmować wszystkie zmiany z serwera,
  // w trybie przeglądarki czytamy prosto z IndexedDB / localStorage (inna karta mogła właśnie coś zapisać)
  function syncBeforeRead(coll, id) {
    return backend && backend.sync ? backend.sync(coll, id) : null;
  }

  function touch(coll, id) {
    for (var i = 0; i < listeners.length; i++) {
      var l = listeners[i];
      if (l.coll === coll && (l.id === null || l.id === id)) schedule(l);
    }
  }
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
      metadata: { fromCache: false, hasPendingWrites: false },
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
      metadata: { fromCache: false, hasPendingWrites: false },
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
    return ready.then(function () { return syncBeforeRead(q._coll, null); }).then(function () { return querySnap(runQuery(q), null); });
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
    return ready.then(function () { return syncBeforeRead(self._coll, self.id); })
      .then(function () { var e = entry(self._coll, self.id); return docSnap(self._coll, self.id, e ? e.json : null); });
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
  // Krótka, kooperacyjna dzierżawa dokumentu (jak acquire() na platformie): „zajęte” → {acquired:false},
  // ten sam holder może ją odnowić, wygasa sama (ttlMs 1–600 s, domyślnie 30 s), brak zwalniania.
  // data (opcjonalnie) jest scalane z dokumentem przy przyznaniu (tworzy go, gdy go nie ma).
  DocRef.prototype.acquire = function (options) {
    var self = this;
    return ready.then(function () {
      if (!isObj(options) || typeof options.holder !== 'string' || !options.holder) throw err('invalid_argument', 'acquire(): wymagane {holder: "…"}.');
      var ttl = Number(options.ttlMs) || 30000;
      ttl = Math.min(600000, Math.max(1000, ttl));
      var data = options.data === undefined || options.data === null ? null : toDocJson(options.data, true);
      var holder = options.holder.slice(0, 200);
      return enqueueKeys([self._coll + '/' + self.id], function () { return backend.acquire(self._coll, self.id, holder, ttl, data); });
    });
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
    return enqueueKeys(keys, function () { return backend.write(writes); });
  }
  function enqueueKeys(keys, fn) {
    var before = [];
    keys.forEach(function (k) { if (keyChains.has(k)) before.push(keyChains.get(k)); });
    var p = Promise.all(before).then(fn);
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
      } else if (w.op === 'merge') next = merge(cur || {}, w.data); // wewnętrzne: dane z acquire()
      else next = null;
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
  // kody błędów jak w umowie platformy (assets): invalid_request / unsupported_type / too_large
  function checkUpload(blob, options) {
    if (!blob || typeof blob.size !== 'number' || typeof blob.slice !== 'function') throw err('invalid_request', 'Oczekiwano pliku (Blob).');
    if (options !== undefined && options !== null && !isObj(options)) throw err('invalid_request', 'Nieprawidłowe opcje wysyłania.');
    var type = options && typeof options.type === 'string' && options.type ? options.type.toLowerCase() : blobType(blob);
    if (!/^image\/[a-z0-9.+-]+$/.test(type)) throw err('unsupported_type', 'Dozwolone są tylko obrazy (PNG, JPG, WEBP, SVG…).');
    if (blob.size === 0) throw err('invalid_request', 'Plik jest pusty.');
    if (blob.size > MAX_ASSET_BYTES) throw err('too_large', 'Plik jest za duży (maks. 4 MB).');
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
  var ASSET_LIMITS = { maxFiles: 1000, maxBytes: 500 * 1024 * 1024 };
  function usageOf(list) {
    var bytes = 0; list.forEach(function (a) { bytes += a.sizeBytes || 0; });
    return { files: list.length, bytes: bytes, maxFiles: ASSET_LIMITS.maxFiles, maxBytes: ASSET_LIMITS.maxBytes };
  }
  function isoTime(ms) { return new Date(Number(ms) || 0).toISOString(); }
  // delete(ref): identyfikator albo adres dokładnie taki, jaki zwróciły upload()/list()
  function assetIdFromRef(ref) {
    if (typeof ref !== 'string' || !ref) throw err('invalid_request', 'Oczekiwano identyfikatora logo.');
    var found = null;
    if (backend && backend.assets) backend.assets.forEach(function (a, id) { if (!found && (id === ref || (a.url && a.url === ref) || (a.dataUrl && a.dataUrl === ref))) found = id; });
    if (found) return found;
    var m = /\/_blob\/([^\/?#]+)$/.exec(ref);
    return m ? decodeURIComponent(m[1]) : ref;
  }
  var assetsApi = {
    upload: function (blob, options) { return ready.then(function () { var type = checkUpload(blob, options); return backend.uploadAsset(blob, type); }); },
    list: function () {
      return ready.then(function () { return backend.listAssets(); }).then(function (list) { return { assets: list, usage: usageOf(list) }; });
    },
    delete: function (ref) {
      return ready.then(function () { return backend.deleteAsset(assetIdFromRef(ref)); }).then(function (d) { return { deleted: !!d }; });
    },
  };

  function mimeFor(name, isText, fallback) {
    var ext = (/\.([a-z0-9]+)$/i.exec(name || '') || [])[1];
    ext = ext ? ext.toLowerCase() : '';
    var map = { csv: 'text/csv', json: 'application/json', txt: 'text/plain', md: 'text/markdown', html: 'text/html', xml: 'application/xml', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', zip: 'application/zip', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    var t = map[ext] || fallback || (isText ? 'text/plain' : 'application/octet-stream');
    return isText && /^(text\/|application\/(json|xml))/.test(t) ? t + ';charset=utf-8' : t;
  }
  // save({filename, data}) → {status:'saved'}; typ pliku wynika z rozszerzenia (jak na platformie)
  var downloadsApi = {
    save: function (opts) {
      return new Promise(function (resolve, reject) {
        if (!opts || typeof opts.filename !== 'string' || !opts.filename.trim() || opts.filename.length > 512) { reject(err('bad_request', 'Brak albo nieprawidłowa nazwa pliku.')); return; }
        var name = opts.filename.replace(/[\/\\?%*:|"<>\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim();
        var data = opts.data, blob;
        if (typeof Blob !== 'undefined' && data instanceof Blob) blob = new Blob([data], { type: mimeFor(name, false, data.type) });
        else if (typeof data === 'string') blob = new Blob([data], { type: mimeFor(name, true) });
        else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) blob = new Blob([data], { type: mimeFor(name, false) });
        else { reject(err('bad_request', 'Nieobsługiwany typ danych pliku.')); return; }
        if (!blob.size) { reject(err('bad_request', 'Plik jest pusty.')); return; }
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = name; a.rel = 'noopener'; a.style.display = 'none';
        (document.body || document.documentElement).appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 60000);
        resolve({ status: 'saved' });
      });
    },
  };

  /* ------------------------------------------------------------------ */
  /* TRYB SERWERA                                                       */
  /* ------------------------------------------------------------------ */
  // e.network = brak odpowiedzi HTTP (serwer wyłączony, sieć, przekroczony czas); e.auth = serwer chce hasła
  function fetchJson(url, opts, timeoutMs) {
    opts = opts || {};
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = null;
    var init = { method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body, cache: 'no-store', credentials: 'same-origin' };
    if (ctrl) init.signal = ctrl.signal;
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        if (ctrl) ctrl.abort();
        var e = err('unavailable', 'Serwer nie odpowiada.'); e.network = true; reject(e);
      }, timeoutMs || WRITE_TIMEOUT_MS);
    });
    var req = fetch(url, init).then(function (r) {
      return r.text().then(function (t) {
        var body = null; try { body = t ? JSON.parse(t) : null; } catch (e) { body = null; }
        if (r.ok) return body;
        var code = body && body.error;
        var msg = (body && body.message) || ('HTTP ' + r.status);
        if (r.status === 404 && code === 'not_found') throw err('not_found', msg);
        if (r.status === 413) throw err(opts.asset ? 'too_large' : 'invalid_argument', msg);
        if (r.status === 415) throw err(opts.asset ? 'unsupported_type' : 'invalid_argument', msg);
        if (r.status === 400) throw err(opts.asset ? 'invalid_request' : 'invalid_argument', msg);
        if (r.status === 507 || code === 'quota_exceeded') throw err('quota_exceeded', msg);
        if (r.status === 401 || r.status === 429) { var a = err('unavailable', 'Serwer wymaga hasła — odśwież stronę, aby się zalogować.'); a.auth = true; throw a; }
        if (r.status === 502 || r.status === 503 || r.status === 504) { var g = err('unavailable', 'Serwer nie odpowiada (' + r.status + ').'); g.network = true; throw g; }
        throw err('unavailable', msg);
      });
    }).then(null, function (e) {
      if (e && typeof e.code === 'string') throw e;
      var n = err('unavailable', 'Brak połączenia z serwerem.'); n.network = true; throw n; // sieć, przerwane połączenie
    });
    return Promise.race([req, timeout]).then(function (v) { clearTimeout(timer); return v; }, function (e) { clearTimeout(timer); throw e; });
  }

  // 'server'      — odpowiada serwer Ewidencji Palet
  // 'unreachable' — strona jest z adresu http(s), ale serwer nie odpowiada (wyłączony, uśpiony, brama 502–504)
  // 'auth'        — serwer Ewidencji Palet wymaga hasła (strona wczytana z pamięci podręcznej przeglądarki)
  // 'none'        — plik z dysku albo zwykły serwer WWW bez API (404 itp.) → tryb przeglądarki
  function pingServer() {
    if (!/^https?:$/.test(window.location.protocol) || typeof fetch !== 'function') return Promise.resolve('none');
    function once() {
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null, timer = null;
      var init = { headers: { Accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin' };
      if (ctrl) init.signal = ctrl.signal;
      var timeout = new Promise(function (resolve) { timer = setTimeout(function () { if (ctrl) ctrl.abort(); resolve('unreachable'); }, PING_TIMEOUT_MS); });
      var req = fetch(API + 'ping', init).then(function (r) {
        if (r.status === 401 && /Ewidencja Palet/.test(r.headers.get('WWW-Authenticate') || '')) return 'auth';
        if (r.status === 429) return 'auth'; // za dużo błędnych haseł — to wciąż serwer Ewidencji Palet
        if (r.status === 502 || r.status === 503 || r.status === 504) return 'unreachable';
        if (!r.ok) return 'none';
        return r.text().then(function (t) { var j = null; try { j = JSON.parse(t); } catch (e) { j = null; } return j && j.app === APP ? 'server' : 'none'; });
      }, function () { return 'unreachable'; });
      return Promise.race([req, timeout]).then(function (v) { clearTimeout(timer); return v; });
    }
    // jeden ponowny strzał przy braku odpowiedzi (np. NAS wybudzający się) — 404 itp. rozstrzyga od razu
    return once().then(function (r) { return r === 'unreachable' ? once() : r; });
  }

  // karta ukryta dłużej niż minutę → rozłącz SSE: przeglądarka trzyma najwyżej 6 połączeń HTTP/1.1 z jednym
  // serwerem, a każda otwarta karta zajmuje jedno na stałe (7. karta by „wisiała”); po powrocie — wczytanie od nowa
  var OPCJE = window.EP_LOCAL_OPCJE || {}; // tylko do testów
  var HIDDEN_PAUSE_MS = Number(OPCJE.pauzaUkrytejKartyMs) > 0 ? Number(OPCJE.pauzaUkrytejKartyMs) : 60000;
  // serwer wysyła „ping” co 15 s; dłuższa cisza = połączenie „zawieszone” (np. półotwarte TCP po zmianie Wi-Fi)
  var SSE_SILENCE_MS = Number(OPCJE.ciszaSseMs) > 0 ? Number(OPCJE.ciszaSseMs) : 35000;
  // ile czekamy, aż strumień dowiezie znane już serwerowi zmiany, zanim wczytamy stan w całości
  var STREAM_WAIT_MS = Number(OPCJE.czekanieNaStrumienMs) > 0 ? Number(OPCJE.czekanieNaStrumienMs) : 1000;

  /* Aktualność lustra w trybie serwera
     Serwer numeruje zmiany (rev) i rozsyła je strumieniem SSE w kolejności numerów, dopiero gdy są na dysku.
     mirrorRev = lustro zawiera WSZYSTKIE zmiany o numerach ≤ mirrorRev. Rośnie po wczytaniu migawki
     i po każdym zdarzeniu z „zakotwiczonego” strumienia (takiego, którego „hello” nie zostawia luki
     względem lustra). get() i acquire() porównują mirrorRev z numerem z serwera (GET /api/rev, odpowiedź
     /api/acquire): gdy lustro jest w tyle — czekają chwilę na strumień, a potem wczytują stan w całości.
     Dzięki temu karta wybudzona z tła, z zawieszonym połączeniem albo w trakcie wczytywania nie nadaje
     numeru WZ/PZ na podstawie starych danych. */
  function ServerBackend() {
    this.kind = 'server';
    this.clientId = genId(16);
    this.serverId = null;        // zmienia się przy każdym starcie serwera
    this.snapRev = 0;
    this.docRev = new Map();     // 'coll/id' -> rev ostatnio zastosowanej zmiany
    this.mirrorRev = -1;         // lustro zawiera wszystkie zmiany o numerach ≤ mirrorRev
    this.anchored = false;       // bieżący strumień dostarcza wszystko po mirrorRev
    this.helloRev = null;        // rev z „hello” bieżącego strumienia
    this.waiters = [];           // [{rev, done}] — czekający, aż mirrorRev ≥ rev
    this.es = null;
    this.started = false;
    this.everConnected = false;
    this.online = false;
    this.paused = false;
    this.buffer = null;          // zdarzenia odebrane w trakcie ponownego wczytywania: [{ev, es}]
    this.resyncP = null;
    this.probing = false;
    this.lastSeen = 0;
    this.retry = 0;
    this.reconnectTimer = null;
    this.offlineTimer = null;
    this.hideTimer = null;
    this.assets = new Map();
  }
  ServerBackend.prototype.init = function () {
    var self = this;
    return new Promise(function (resolve) {
      var attempt = 0;
      (function tryLoad() {
        self.loadSnapshot().then(function () {
          self.started = true;
          self.connect();
          self.startWatchdog();
          resolve();
        }, function (e) {
          // nigdy nie przechodzimy po cichu na zapis w przeglądarce: dane rozjechałyby się z serwerem
          attempt++;
          self.setOnline(false, true, e && e.auth);
          setTimeout(tryLoad, Math.min(10000, 1000 * Math.pow(2, Math.min(attempt, 4))));
        });
      })();
    });
  };
  // nowy serverId = serwer uruchomiony od nowa (być może z danymi odtworzonymi z kopii, z niższym rev):
  // zapomnij wszystko, co wiadomo o numerach zmian, i przyjmij stan serwera w całości
  ServerBackend.prototype.noteServer = function (serverId) {
    if (!serverId) return false;
    var changed = !!(this.serverId && serverId !== this.serverId);
    if (changed) { this.docRev.clear(); this.snapRev = -1; this.mirrorRev = -1; this.anchored = false; }
    this.serverId = serverId;
    return changed;
  };
  ServerBackend.prototype.bumpMirror = function (rev) {
    if (!(rev > this.mirrorRev)) return;
    this.mirrorRev = rev;
    var self = this;
    this.waiters.slice().forEach(function (w) { if (w.rev <= self.mirrorRev) w.done(); });
  };
  ServerBackend.prototype.loadSnapshot = function () {
    var self = this;
    return this.request(API + 'snapshot', {}, 20000).then(function (snap) {
      if (!snap || !isObj(snap.collections)) throw err('unavailable', 'Nieprawidłowa odpowiedź serwera.');
      self.noteServer(snap.serverId);
      var next = new Map();
      Object.keys(snap.collections).forEach(function (c) {
        var docs = snap.collections[c], m = new Map();
        Object.keys(docs).forEach(function (id) { m.set(id, JSON.stringify(docs[id])); });
        next.set(c, m);
      });
      var rev = Number(snap.rev) || 0;
      replaceMirror(next, function (c, id) { var r = self.docRev.get(c + '/' + id); return r !== undefined && r > rev; }, self.started);
      self.docRev.forEach(function (r, k) { if (r <= rev) self.docRev.delete(k); });
      self.snapRev = rev;
      self.assets = new Map();
      (snap.assets || []).forEach(function (a) { self.assets.set(a.id, a); });
      if (snap.odtworzenie) showRestoreNotice(snap.odtworzenie);
      self.bumpMirror(rev);
      return rev;
    });
  };
  // current = zdarzenie z bieżącego, zakotwiczonego strumienia (przesuwa mirrorRev)
  ServerBackend.prototype.applyEvent = function (ev, current) {
    if (!ev || typeof ev.coll !== 'string' || typeof ev.id !== 'string') return;
    var key = ev.coll + '/' + ev.id, known = this.docRev.get(key), rev = Number(ev.rev);
    if (!(rev <= this.snapRev || (known !== undefined && rev <= known))) { // inaczej: echo / stare
      this.docRev.set(key, rev);
      // własny zapis, którego echo przyszło przed odpowiedzią POST: jedno dostarczenie, jak w innych trybach
      applyChange(ev.coll, ev.id, ev.data === null || ev.data === undefined ? null : JSON.stringify(ev.data), ev.clientId === this.clientId);
    }
    if (current) this.bumpMirror(rev);
  };
  ServerBackend.prototype.connect = function () {
    var self = this;
    clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
    if (this.es) { this.es.onerror = null; this.es.close(); this.es = null; }
    this.anchored = false; this.helloRev = null;
    if (this.paused) return;
    if (typeof EventSource !== 'function') { warn('Brak EventSource — zmiany z innych urządzeń pojawią się po odświeżeniu.'); this.setOnline(true); return; }
    var es = this.es = new EventSource(API + 'events');
    this.lastSeen = Date.now();
    es.onopen = function () { self.lastSeen = Date.now(); };
    es.addEventListener('hello', function (e) {
      if (self.es !== es) return;
      self.lastSeen = Date.now();
      var h = {}; try { h = JSON.parse(e.data); } catch (x) { /* ignore */ }
      self.everConnected = true; self.retry = 0;
      var restarted = self.noteServer(h.serverId);
      self.helloRev = Number(h.rev) || 0;
      // strumień dostarczy wszystko po helloRev; jeśli lustro sięga co najmniej tam — nic nie zginęło
      if (!restarted && !self.buffer && self.mirrorRev >= self.helloRev) { self.anchored = true; self.setOnline(true); }
      else self.resync().then(noop, noop);
    });
    es.addEventListener('change', function (e) {
      if (self.es !== es) return;
      self.lastSeen = Date.now();
      var ev; try { ev = JSON.parse(e.data); } catch (x) { return; }
      if (self.buffer) self.buffer.push({ ev: ev, es: es }); else self.applyEvent(ev, self.anchored);
    });
    // paczka zmian (batch) — stosowana w całości w jednym kroku
    es.addEventListener('changes', function (e) {
      if (self.es !== es) return;
      self.lastSeen = Date.now();
      var b; try { b = JSON.parse(e.data); } catch (x) { return; }
      (b && Array.isArray(b.changes) ? b.changes : []).forEach(function (c) {
        var ev = { rev: c.rev, coll: c.coll, id: c.id, data: c.data, clientId: b.clientId };
        if (self.buffer) self.buffer.push({ ev: ev, es: es }); else self.applyEvent(ev, self.anchored);
      });
    });
    es.addEventListener('ping', function (e) {
      if (self.es !== es) return;
      self.lastSeen = Date.now();
      var p = {}; try { p = JSON.parse(e.data); } catch (x) { /* ignore */ }
      // wszystko do p.rev zostało już wysłane tym strumieniem — jeśli lustro jest niżej, coś zginęło
      if (self.anchored && !self.buffer && Number(p.rev) > self.mirrorRev) self.resync().then(noop, noop);
    });
    es.addEventListener('reset', function () { if (self.es !== es) return; self.lastSeen = Date.now(); self.resync().then(noop, noop); });
    es.onerror = function () {
      if (self.es !== es) return;
      if (es.readyState === 2) self.scheduleReconnect(); // CLOSED — przeglądarka sama już nie spróbuje
      // pasek „brak połączenia” tylko wtedy, gdy serwer naprawdę nie odpowiada (zapisy mogą działać dalej)
      self.probe();
    };
  };
  ServerBackend.prototype.scheduleReconnect = function () {
    var self = this;
    clearTimeout(this.reconnectTimer);
    if (this.paused) return;
    this.retry++;
    this.reconnectTimer = setTimeout(function () { self.reconnectTimer = null; self.connect(); }, Math.min(10000, 500 * Math.pow(2, Math.min(this.retry, 5))));
  };
  // Wczytanie stanu w całości. Zwraca obietnicę (wspólną, gdy wczytywanie już trwa).
  ServerBackend.prototype.resync = function () {
    var self = this;
    if (this.resyncP) return this.resyncP;
    this.buffer = [];
    var p = this.resyncP = this.loadSnapshot().then(function () {
      var buf = self.buffer; self.buffer = null; self.resyncP = null;
      // migawka pobrana po „hello” bieżącego strumienia obejmuje wszystko do helloRev → strumień zakotwiczony
      if (self.es && self.helloRev !== null && self.mirrorRev >= self.helloRev) self.anchored = true;
      buf.forEach(function (x) { self.applyEvent(x.ev, x.es === self.es && self.anchored); });
      self.setOnline(true);
      // „hello” przyszło w trakcie, a migawka była starsza — jeszcze raz
      if (self.es && self.helloRev !== null && !self.anchored) return self.resync();
      return undefined;
    }, function (e) {
      self.buffer = null; self.resyncP = null;
      self.setOnline(false, false, e && e.auth);
      if (self.es) { self.es.onerror = null; self.es.close(); self.es = null; }
      self.anchored = false;
      self.scheduleReconnect();
      throw e;
    });
    return p;
  };
  // Lustro ma obejmować wszystkie zmiany do numeru target (serverId: serwer, który go podał).
  ServerBackend.prototype.ensureFresh = function (target, serverId) {
    var self = this;
    if (serverId && this.serverId && serverId !== this.serverId) {
      // serwer uruchomiony od nowa — stan wczytujemy w całości (loadSnapshot przyjmie nowy serverId)
      return this.resync().then(function () { return self.serverId === serverId ? self.ensureFresh(target, null) : undefined; });
    }
    if (this.mirrorRev >= target) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var finished = false, timer = null, tries = 0;
      var w = { rev: target, done: function () { finish(null); } };
      function finish(e) {
        if (finished) return;
        finished = true; clearTimeout(timer);
        var i = self.waiters.indexOf(w); if (i >= 0) self.waiters.splice(i, 1);
        if (e) reject(e); else resolve();
      }
      function viaSnapshot() {
        if (finished) return;
        if (++tries > 3) { finish(err('unavailable', 'Nie udało się pobrać aktualnych danych z serwera.')); return; }
        self.resync().then(function () { if (self.mirrorRev >= target) finish(null); else viaSnapshot(); }, finish);
      }
      self.waiters.push(w);
      var live = self.es && self.es.readyState === 1 && self.anchored && !self.buffer && !self.paused;
      if (live) {
        timer = setTimeout(function () {
          // strumień nie dowiózł zmian, które serwer już rozesłał — połączenie mogło się zawiesić
          if (Date.now() - self.lastSeen > STREAM_WAIT_MS) { warn('połączenie na żywo nie dostarcza zmian — łączę ponownie'); self.connect(); }
          viaSnapshot();
        }, STREAM_WAIT_MS);
      } else viaSnapshot();
    });
  };
  // przed get(): numer ostatniej rozesłanej zmiany na serwerze → lustro co najmniej tak aktualne
  ServerBackend.prototype.sync = function () {
    var self = this;
    return this.request(API + 'rev', {}, 15000).then(function (r) {
      return self.ensureFresh(Number(r && r.rev) || 0, r && r.serverId);
    }, function (e) {
      if (e && e.code === 'not_found') return self.resync(); // serwer bez /api/rev (starsza wersja) — wczytaj stan
      throw e;
    });
  };
  // ukryta karta po minucie zwalnia połączenie SSE; po powrocie łączy się i w razie potrzeby wczytuje stan
  ServerBackend.prototype.pause = function () {
    if (this.paused) return;
    this.paused = true;
    clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
    if (this.es) { this.es.onerror = null; this.es.close(); this.es = null; }
    this.anchored = false; this.helloRev = null;
  };
  ServerBackend.prototype.resume = function () {
    if (!this.paused) return;
    this.paused = false; this.retry = 0; this.everConnected = true;
    this.connect();
  };
  ServerBackend.prototype.startWatchdog = function () {
    var self = this;
    var stale = function () { return self.es && !self.paused && Date.now() - self.lastSeen > SSE_SILENCE_MS; };
    setInterval(function () {
      // brak „ping” i zdarzeń dłużej niż ~35 s: połączenie zawieszone — nowe połączenie (i w razie luki wczytanie)
      if (stale()) { warn('brak sygnału z serwera od ' + Math.round((Date.now() - self.lastSeen) / 1000) + ' s — łączę ponownie'); self.connect(); }
    }, Math.max(250, Math.min(5000, Math.floor(SSE_SILENCE_MS / 4))));
    var kick = function () { if ((!self.online || stale()) && !self.paused) { self.retry = 0; self.connect(); } };
    window.addEventListener('online', kick);
    window.addEventListener('pageshow', function (e) { if (e.persisted) { self.everConnected = true; self.paused = false; self.connect(); } });
    document.addEventListener('visibilitychange', function () {
      clearTimeout(self.hideTimer);
      if (document.visibilityState === 'hidden') {
        self.hideTimer = setTimeout(function () { if (document.visibilityState === 'hidden') self.pause(); }, HIDDEN_PAUSE_MS);
      } else if (self.paused) self.resume();
      else kick();
    });
  };
  ServerBackend.prototype.setOnline = function (on, immediate, auth) {
    var self = this;
    this.online = on;
    if (window.EP_LOCAL) window.EP_LOCAL.online = on;
    clearTimeout(this.offlineTimer);
    if (on) { hideBanner('offline'); return; }
    var text = auth ? 'Serwer wymaga hasła — odśwież stronę, aby się zalogować. Zmiany nie są zapisywane'
      : 'Brak połączenia z serwerem — zmiany nie są zapisywane';
    var show = function () { if (!self.online) showBanner('offline', text); };
    if (immediate) show(); else this.offlineTimer = setTimeout(show, 1000); // bez migania przy krótkiej przerwie
  };
  // każde żądanie do serwera: sukces = serwer jest osiągalny (pasek znika), brak odpowiedzi = pasek
  ServerBackend.prototype.request = function (url, opts, timeoutMs) {
    var self = this;
    return fetchJson(url, opts, timeoutMs).then(function (r) { self.noteOk(); return r; }, function (e) { self.onRequestError(e); throw e; });
  };
  ServerBackend.prototype.noteOk = function () {
    if (!this.online) this.setOnline(true);
    // serwer odpowiada, a połączenie na żywo leży — połącz od razu, nie czekając na kolejną próbę
    if (this.started && !this.paused && (!this.es || this.es.readyState === 2)) this.connect();
  };
  // błąd strumienia SSE: czy serwer w ogóle odpowiada? (jedno sprawdzenie naraz)
  ServerBackend.prototype.probe = function () {
    var self = this;
    if (this.probing) return;
    this.probing = true;
    fetchJson(API + 'rev', {}, 5000).then(function () {
      self.probing = false;
      self.setOnline(true);
    }, function (e) {
      self.probing = false;
      if (e && (e.network || e.auth)) self.setOnline(false, !!e.auth, e.auth);
      else self.setOnline(true); // serwer odpowiedział (np. inną wersją) — jest osiągalny
    });
  };
  ServerBackend.prototype.post = function (path, body) {
    return this.request(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, WRITE_TIMEOUT_MS);
  };
  // tylko brak odpowiedzi (albo żądanie hasła) oznacza utratę połączenia — błąd zapisu na dysku serwera nie
  ServerBackend.prototype.onRequestError = function (e) {
    if (!e || !(e.network || e.auth)) return;
    this.setOnline(false, true, e.auth);
    if (this.started && !this.paused && (!this.es || this.es.readyState === 2) && !this.reconnectTimer) this.scheduleReconnect();
  };
  ServerBackend.prototype.applyResult = function (r) {
    var key = r.coll + '/' + r.id;
    if (r.rev !== null && r.rev !== undefined) {
      var known = this.docRev.get(key);
      // echo tej zmiany (albo nowsza zmiana) przyszło już strumieniem i nasłuchy dostały je — bez drugiej migawki
      if (known !== undefined && known >= r.rev) return;
      this.docRev.set(key, r.rev);
    }
    applyChange(r.coll, r.id, r.data === null || r.data === undefined ? null : JSON.stringify(r.data), true);
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
      results.forEach(function (r) { self.applyResult(r); });
      return results;
    });
  };
  ServerBackend.prototype.acquire = function (coll, id, holder, ttl, data) {
    var self = this;
    return this.post('acquire', { coll: coll, id: id, holder: holder, ttlMs: ttl, data: data, clientId: this.clientId }).then(function (res) {
      if (res.acquired && res.change) self.applyResult(res.change);
      if (!res.acquired) return leaseResult(false, null, res.expiresAt, holder);
      // dzierżawa przyznana dopiero wtedy, gdy lustro zawiera wszystko, co serwer rozesłał przed jej przyznaniem
      // (np. licznik WZ/PZ zapisany przez poprzedniego posiadacza)
      return self.ensureFresh(Number(res.rev) || 0, res.serverId).then(function () { return leaseResult(true, res.version, res.expiresAt, holder); });
    });
  };
  ServerBackend.prototype.assetUrl = function (id) { return BASE + '_blob/' + encodeURIComponent(id); };
  ServerBackend.prototype.assetOut = function (a) {
    return { id: a.id, url: this.assetUrl(a.id), contentType: a.contentType, sizeBytes: a.sizeBytes, createdAt: isoTime(a.createdAt) };
  };
  ServerBackend.prototype.uploadAsset = function (blob, type) {
    var self = this;
    return this.request(API + 'assets', { method: 'POST', headers: { 'Content-Type': type }, body: blob, asset: true }, WRITE_TIMEOUT_MS).then(function (res) {
      var a = { id: res.id, contentType: res.contentType, sizeBytes: res.sizeBytes, createdAt: res.createdAt };
      self.assets.set(a.id, a);
      var out = self.assetOut(a); delete out.createdAt;
      return out;
    });
  };
  ServerBackend.prototype.listAssets = function () {
    var self = this;
    return this.request(API + 'assets', {}, 20000).then(function (res) {
      return (res.assets || []).map(function (a) { return self.assetOut(a); });
    });
  };
  ServerBackend.prototype.deleteAsset = function (id) {
    var self = this;
    return this.request(API + 'assets/' + encodeURIComponent(id), { method: 'DELETE', asset: true }, WRITE_TIMEOUT_MS).then(function (res) {
      self.assets.delete(id);
      return !!(res && res.existed);
    });
  };

  // Jednorazowy komunikat: serwer przy starcie odtworzył bazę z kopii (albo zaczął od pustej). Znika po
  // kliknięciu „Rozumiem” i nie wraca na tym urządzeniu (zapamiętane w localStorage).
  var NOTICE_KEY = LSP + 'odtworzenie-przeczytane';
  var noticeDone = {};
  function restoreText(info) {
    var d = /(\d{4})-(\d{2})-(\d{2})/.exec(String(info.zKopii || ''));
    var data = d ? d[3] + '.' + d[2] + '.' + d[1] : null;
    var odl = info.odlozony ? ' Uszkodzony plik zachowano w folderze „dane” jako ' + info.odlozony + '.' : '';
    if (info.brakPliku) return 'Uwaga: przy uruchomieniu serwera nie było pliku bazy (dane/baza.json), choć są kopie zapasowe — serwer zaczął od pustej bazy. ' +
      'Aby odzyskać dane: Ustawienia i kopia → Wczytaj kopię z pliku → najnowsza kopia z folderu dane/kopie → Zastąp wszystko.';
    if (!info.pusta) return 'Uwaga: plik bazy na serwerze był uszkodzony. Serwer odtworzył dane z kopii ' +
      (data ? 'z dnia ' + data + ' (stan z początku tego dnia)' : '(' + info.zKopii + ')') +
      ' — operacje zapisane później mogły zginąć, sprawdź ostatnie wpisy.' + odl;
    return 'Uwaga: plik bazy na serwerze był uszkodzony i nie znaleziono poprawnej kopii — serwer zaczął od pustej bazy.' + odl +
      ' Jeśli masz kopię (.json), wczytaj ją: Ustawienia i kopia → Wczytaj kopię z pliku.';
  }
  function showRestoreNotice(info) {
    if (!isObj(info) || typeof info.id !== 'string' || noticeDone[info.id]) return;
    try { if (window.localStorage.getItem(NOTICE_KEY) === info.id) return; } catch (e) { /* bez localStorage: raz na wczytanie strony */ }
    noticeDone[info.id] = true;
    showBanner('odtworzenie', restoreText(info), {
      button: 'Rozumiem',
      onClose: function () { try { window.localStorage.setItem(NOTICE_KEY, info.id); } catch (e) { /* trudno */ } },
    });
  }

  // wynik acquire() w kształcie platformy: {acquired, version?, expiresAt, holder?}
  function leaseResult(acquired, version, expiresAt, holder) {
    var out = { acquired: !!acquired };
    if (acquired) { out.version = version; out.expiresAt = expiresAt; out.holder = holder; }
    else if (expiresAt) out.expiresAt = expiresAt;
    return out;
  }

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
  function onMessage(msg) {
    if (!msg || msg.app !== APP || msg.from === tabId || !backend || backend.kind !== 'indexeddb') return;
    if (seenMsgs.indexOf(msg.n) >= 0) return;
    seenMsgs.push(msg.n); if (seenMsgs.length > 200) seenMsgs.shift();
    backend.queueRemote(msg.keys, msg.assets, msg.t === 'reset');
  }
  if (channel) channel.onmessage = function (e) { onMessage(e.data); };

  /* Zmiany z innych kart są zbierane i stosowane paczkami: jeden odczyt z magazynu i jedno powiadomienie
     nasłuchów na paczkę (zamiast osobnego odczytu i przebudowy widoku dla każdego z np. 3000 zapisów
     wczytywanej kopii). Pierwsza paczka po ciszy — po 15 ms; w trakcie serii — najwyżej ~6 na sekundę.
     Logo trafia do pamięci podręcznej przed kurierem, który go używa (w paczce najpierw loga). */
  var BIG_BATCH = 300; // powyżej — zamiast pojedynczych odczytów wczytanie całego magazynu
  var remoteQueue = {
    queueRemote: function (keys, assets, full) {
      var p = this.pend || (this.pend = { keys: new Set(), assets: new Set(), full: false });
      if (full) p.full = true;
      (keys || []).forEach(function (k) { if (typeof k === 'string') p.keys.add(k); });
      (assets || []).forEach(function (a) { if (typeof a === 'string') p.assets.add(a); });
      if (p.keys.size > BIG_BATCH) p.full = true;
      this.scheduleFlush();
    },
    scheduleFlush: function () {
      var self = this;
      if (this.flushTimer || this.flushing || !this.pend) return;
      var wait = Math.max(15, 150 - (Date.now() - (this.lastFlush || 0)));
      this.flushTimer = setTimeout(function () { self.flushTimer = null; self.flushNow(); }, wait);
    },
    flushNow: function () {
      var self = this, p = this.pend;
      this.pend = null;
      if (!p) return Promise.resolve();
      this.flushing = true;
      var done = function () { self.flushing = false; self.lastFlush = Date.now(); self.scheduleFlush(); };
      return (p.full ? this.load(true) : this.readRemote(p)).then(done, function (e) { warn('synchronizacja kart:', e); done(); });
    },
  };

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
  function recJson(r) { return r && isObj(r.data) ? JSON.stringify(r.data) : null; }
  IdbBackend.prototype.load = function (notify) {
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
        replaceMirror(next, null, notify);
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
            // update wymaga istniejącego dokumentu; wewnętrzne 'merge' (acquire z data) tworzy go
            if (!overlay.get(key) && w.op === 'update') { abortErr = err('not_found', 'Dokument ' + key + ' nie istnieje.'); tx.abort(); return; }
            put(w, merge(overlay.get(key) || {}, w.data));
          } else {
            var r = st.get(key);
            r.onsuccess = (function (w2, i2) {
              return function (e) {
                var rec = e.target.result, base = rec && isObj(rec.data) ? rec.data : null;
                if (!base && w2.op === 'update') { abortErr = err('not_found', 'Dokument ' + w2.coll + '/' + w2.id + ' nie istnieje.'); try { tx.abort(); } catch (x) { /* ignore */ } return; }
                put(w2, merge(base || {}, w2.data));
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
  // paczka zmian z innych kart: wszystkie dokumenty i loga w jednej transakcji odczytu
  IdbBackend.prototype.readRemote = function (p) {
    var self = this;
    return new Promise(function (resolve) {
      var tx; try { tx = self.db.transaction(['docs', 'assets'], 'readonly'); } catch (e) { resolve(); return; }
      var docs = [], assets = [];
      p.keys.forEach(function (key) {
        if (key.indexOf('/') < 1) return;
        tx.objectStore('docs').get(key).onsuccess = function (e) { docs.push([key, e.target.result]); };
      });
      p.assets.forEach(function (id) {
        tx.objectStore('assets').get(id).onsuccess = function (e) { assets.push([id, e.target.result]); };
      });
      tx.oncomplete = function () {
        assets.forEach(function (a) { if (a[1]) self.assets.set(a[0], a[1]); else self.assets.delete(a[0]); });
        docs.forEach(function (d) { var kc = splitKey(d[0]); applyChange(kc[0], kc[1], recJson(d[1]), false); });
        resolve();
      };
      tx.onabort = function () { resolve(); };
    });
  };
  // get(): dokument albo cała kolekcja prosto z IndexedDB (lustro mogłoby jeszcze nie znać zapisu z innej
  // karty — np. licznika WZ/PZ albo operacji z wczytywanej właśnie kopii); przy okazji uaktualnia lustro
  IdbBackend.prototype.sync = function (coll, id) {
    var db = this.db;
    return new Promise(function (resolve) {
      var tx, out = null, one = id !== null && id !== undefined;
      try { tx = db.transaction(['docs'], 'readonly'); } catch (e) { resolve(); return; }
      var st = tx.objectStore('docs');
      if (one) st.get(coll + '/' + id).onsuccess = function (e) { out = e.target.result; };
      else st.getAll(IDBKeyRange.bound(coll + '/', coll + '/\uffff')).onsuccess = function (e) { out = e.target.result; };
      tx.oncomplete = function () {
        if (one) applyChange(coll, id, recJson(out), false);
        else {
          var fresh = new Map();
          (out || []).forEach(function (r) { if (r && r.coll === coll && typeof r.id === 'string' && isObj(r.data)) fresh.set(r.id, JSON.stringify(r.data)); });
          reconcileColl(coll, fresh);
        }
        resolve();
      };
      tx.onabort = function () { resolve(); };
    });
  };
  // dzierżawa (acquire): rekord '#lease:coll/id' w tym samym magazynie — transakcja readwrite IndexedDB
  // jest atomowa także między kartami. '#' nie występuje w nazwach kolekcji, a load() pomija te rekordy.
  IdbBackend.prototype.lease = function (key, holder, ttl) {
    var db = this.db;
    return new Promise(function (resolve, reject) {
      var tx, out = null;
      try { tx = rwTx(db, ['docs']); } catch (e) { reject(idbErr(e)); return; }
      var st = tx.objectStore('docs'), k = '#lease:' + key;
      st.get(k).onsuccess = function (e) {
        var d = decideLease(e.target.result, holder, ttl, Date.now());
        if (d.rec) st.put(d.rec, k);
        out = d.res;
      };
      tx.oncomplete = function () { resolve(out); };
      tx.onabort = function () { reject(idbErr(tx.error)); };
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
  LsBackend.prototype.load = function (notify) {
    var ls = window.localStorage, next = new Map(), assets = new Map();
    for (var i = 0; i < ls.length; i++) {
      var k = ls.key(i);
      if (!k || k.indexOf(LSP) !== 0) continue;
      try {
        var v = JSON.parse(ls.getItem(k));
        if (k.indexOf(LSP + 'd:') === 0 && v && isObj(v.data)) {
          if (!next.has(v.coll)) next.set(v.coll, new Map());
          next.get(v.coll).set(v.id, JSON.stringify(v.data));
        } else if (k.indexOf(LSP + 'a:') === 0 && v && v.id) assets.set(v.id, v);
      } catch (e) { warn('pominięto uszkodzony wpis', k); }
    }
    this.assets = assets;
    replaceMirror(next, null, notify);
    return Promise.resolve();
  };
  LsBackend.prototype.current = function (coll, id) {
    try { var v = JSON.parse(window.localStorage.getItem(LSP + 'd:' + coll + '/' + id)); return v && isObj(v.data) ? v.data : null; }
    catch (e) { var en = entry(coll, id); return en ? JSON.parse(en.json) : null; }
  };
  LsBackend.prototype.currentJson = function (coll, id) { var d = this.current(coll, id); return d ? JSON.stringify(d) : null; };
  // get(): prosto z localStorage (zdarzenie „storage” z innej karty mogło jeszcze nie dotrzeć)
  LsBackend.prototype.sync = function (coll, id) {
    if (id !== null && id !== undefined) { applyChange(coll, id, this.currentJson(coll, id), false); return Promise.resolve(); }
    var ls, pre = LSP + 'd:' + coll + '/', fresh = new Map();
    try {
      ls = window.localStorage;
      for (var i = 0; i < ls.length; i++) {
        var k = ls.key(i);
        if (!k || k.indexOf(pre) !== 0) continue;
        try { var v = JSON.parse(ls.getItem(k)); if (v && isObj(v.data) && v.coll === coll) fresh.set(v.id, JSON.stringify(v.data)); } catch (e) { /* uszkodzony wpis */ }
      }
    } catch (e) { return Promise.resolve(); }
    reconcileColl(coll, fresh);
    return Promise.resolve();
  };
  // paczka zmian z innych kart (zdarzenia „storage”): aktualne wartości prosto z localStorage
  LsBackend.prototype.readRemote = function (p) {
    var self = this;
    p.assets.forEach(function (id) {
      var v = null; try { v = JSON.parse(window.localStorage.getItem(LSP + 'a:' + id)); } catch (e) { v = null; }
      if (v && v.id) self.assets.set(id, v); else self.assets.delete(id);
    });
    p.keys.forEach(function (key) { var kc = splitKey(key); if (kc[0]) applyChange(kc[0], kc[1], self.currentJson(kc[0], kc[1]), false); });
    return Promise.resolve();
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

  /* Dzierżawa w trybie localStorage. localStorage nie ma transakcji (odczyt-sprawdzenie-zapis w dwóch
     kartach naraz dawało dzierżawę obu), więc dzierżawę trzyma blokada przeglądarki (Web Locks,
     navigator.locks) — wspólna dla wszystkich kart, atomowa; karta trzyma ją przez czas dzierżawy, a przy
     zamknięciu karty przeglądarka sama ją zwalnia. Wpis 'l:' w localStorage służy tylko do informacji
     (expiresAt, numer wersji). Bez Web Locks (Safari < 15.4): zapis, krótka przerwa i sprawdzenie, czy wpis
     wciąż jest nasz. */
  LsBackend.prototype.leaseInfo = function (key) { try { return JSON.parse(window.localStorage.getItem(LSP + 'l:' + key)); } catch (e) { return null; } };
  LsBackend.prototype.saveLeaseInfo = function (key, rec) { try { window.localStorage.setItem(LSP + 'l:' + key, JSON.stringify(rec)); } catch (e) { /* tylko informacja */ } };
  LsBackend.prototype.lease = function (key, holder, ttl) {
    var locks = navigator.locks, self = this;
    if (!locks || typeof locks.request !== 'function') return this.leaseNoLocks(key, holder, ttl);
    var held = this.held || (this.held = new Map()), now = Date.now(), cur = held.get(key);
    if (cur && cur.exp > now) {
      if (cur.holder !== holder) return Promise.resolve(leaseResult(false, null, isoTime(cur.exp)));
      cur.exp = now + ttl; cur.ver++;
      this.saveLeaseInfo(key, { lease: true, holder: holder, exp: cur.exp, ver: cur.ver });
      return Promise.resolve(leaseResult(true, cur.ver, isoTime(cur.exp), holder));
    }
    if (cur) { held.delete(key); clearTimeout(cur.timer); cur.release(); } // wygasła — zwolnij, zanim weźmiesz od nowa
    return new Promise(function (resolve, reject) {
      locks.request(LSP + 'lease:' + key, { ifAvailable: true }, function (lock) {
        if (!lock) {
          var info = self.leaseInfo(key), t = Date.now();
          resolve(leaseResult(false, null, isoTime(info && Number(info.exp) > t ? info.exp : t + 1000)));
          return undefined;
        }
        return new Promise(function (release) {
          var info = self.leaseInfo(key);
          var h = { holder: holder, exp: Date.now() + ttl, ver: ((info && Number(info.ver)) || 0) + 1, release: release, timer: null };
          held.set(key, h);
          (function arm() {
            h.timer = setTimeout(function () {
              if (held.get(key) !== h) return;
              if (Date.now() >= h.exp) { held.delete(key); release(); } else arm();
            }, Math.max(10, h.exp - Date.now()));
          })();
          self.saveLeaseInfo(key, { lease: true, holder: holder, exp: h.exp, ver: h.ver });
          resolve(leaseResult(true, h.ver, isoTime(h.exp), holder));
        });
      }).then(null, function (e) { reject(err('unavailable', 'Nie udało się uzyskać dzierżawy: ' + (e && e.message))); });
    });
  };
  LsBackend.prototype.leaseNoLocks = function (key, holder, ttl) {
    var self = this, k = LSP + 'l:' + key;
    var d = decideLease(this.leaseInfo(key), holder, ttl, Date.now());
    if (!d.rec) return Promise.resolve(d.res);
    d.rec.nonce = genId(12);
    try { window.localStorage.setItem(k, JSON.stringify(d.rec)); } catch (e) { return Promise.reject(err('unavailable', 'Nie udało się zapisać dzierżawy: ' + e.message)); }
    // druga karta, która zapisała w tej samej chwili, nadpisze wpis — wygrywa ostatni zapis
    return new Promise(function (resolve) {
      setTimeout(function () {
        var now = self.leaseInfo(key);
        if (now && now.nonce === d.rec.nonce) resolve(d.res);
        else resolve(leaseResult(false, null, isoTime(now && Number(now.exp) > Date.now() ? now.exp : Date.now() + ttl)));
      }, 60);
    });
  };

  function MemBackend() { this.kind = 'memory'; this.assets = new Map(); this.leases = new Map(); }
  MemBackend.prototype.lease = function (key, holder, ttl) {
    var d = decideLease(this.leases.get(key), holder, ttl, Date.now());
    if (d.rec) this.leases.set(key, d.rec);
    return Promise.resolve(d.res);
  };
  MemBackend.prototype.load = function () { return Promise.resolve(); };
  MemBackend.prototype.write = function (writes) {
    return new Promise(function (resolve) {
      var plan = planWrites(writes, function (c, id) { var e = entry(c, id); return e ? JSON.parse(e.json) : null; });
      plan.forEach(function (p) { applyChange(p.coll, p.id, p.json, true); });
      resolve(plan);
    });
  };
  MemBackend.prototype.putAsset = function () { return Promise.resolve(); };

  // zajęta przez innego posiadacza i jeszcze ważna → odmowa; wolna, wygasła albo nasza → przyznana (odnowiona)
  function decideLease(cur, holder, ttl, now) {
    if (cur && cur.holder !== holder && Number(cur.exp) > now) return { rec: null, res: leaseResult(false, null, isoTime(cur.exp)) };
    var ver = ((cur && Number(cur.ver)) || 0) + 1, exp = now + ttl;
    return { rec: { lease: true, holder: holder, exp: exp, ver: ver }, res: leaseResult(true, ver, isoTime(exp), holder) };
  }

  // wspólne dla trybów przeglądarki: loga jako data URL w pamięci podręcznej (assetUrl musi być synchroniczne)
  [IdbBackend, LsBackend].forEach(function (B) { Object.keys(remoteQueue).forEach(function (k) { B.prototype[k] = remoteQueue[k]; }); });
  [IdbBackend, LsBackend, MemBackend].forEach(function (B) {
    // wywoływane już w kolejce zapisów tego dokumentu (enqueueKeys) — dlatego write(), nie enqueueWrite()
    B.prototype.acquire = function (coll, id, holder, ttl, data) {
      var self = this;
      return this.lease(coll + '/' + id, holder, ttl).then(function (res) {
        if (!res.acquired || !data) return res;
        return self.write([{ op: 'merge', coll: coll, id: id, data: data }]).then(function () { return res; });
      });
    };
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
        var rec = { id: id, dataUrl: dataUrl, contentType: type, sizeBytes: blob.size, createdAt: Date.now() };
        return self.putAsset(rec).then(function () {
          self.assets.set(id, rec);
          if (self.kind === 'indexeddb') broadcast({ t: 'assets', assets: [id] });
          return { id: id, url: dataUrl, sizeBytes: rec.sizeBytes, contentType: type };
        });
      });
    };
    B.prototype.listAssets = function () {
      var list = [];
      this.assets.forEach(function (a) { list.push({ id: a.id, url: a.dataUrl, contentType: a.contentType, sizeBytes: a.sizeBytes, createdAt: isoTime(a.createdAt) }); });
      list.sort(function (a, b) { return a.createdAt < b.createdAt ? -1 : (a.createdAt > b.createdAt ? 1 : 0); }); // najstarsze najpierw
      return Promise.resolve(list);
    };
    B.prototype.deleteAsset = function (id) {
      var self = this;
      if (!this.assets.has(id)) return Promise.resolve(false);
      return this.putAsset({ id: id, dataUrl: null }).then(function () {
        self.assets.delete(id);
        if (self.kind === 'indexeddb') broadcast({ t: 'assets', assets: [id] });
        return true;
      });
    };
  });

  // zdarzenie storage: sygnały z innych kart (gdy brak BroadcastChannel) + zmiany w trybie localStorage
  window.addEventListener('storage', function (e) {
    if (!backend) return;
    if (e.key === null && backend.kind === 'localstorage') { backend.queueRemote(null, null, true); return; } // localStorage.clear()
    if (!e.key || e.key.indexOf(LSP) !== 0) return;
    if (e.key === LSP + 'sygnal') { try { onMessage(JSON.parse(e.newValue)); } catch (x) { /* ignore */ } return; }
    if (backend.kind !== 'localstorage') return;
    // paczkami, jak w trybie IndexedDB (wartości czytane przy stosowaniu paczki — zawsze aktualne)
    if (e.key.indexOf(LSP + 'd:') === 0) backend.queueRemote([e.key.slice(LSP.length + 2)], null, false);
    else if (e.key.indexOf(LSP + 'a:') === 0) backend.queueRemote(null, [e.key.slice(LSP.length + 2)], false);
  });

  function initBrowser() {
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

  // diagnostyka: stan połączenia na żywo z serwerem ('otwarte' | 'wstrzymane' | 'brak'), null w trybie przeglądarki
  Object.defineProperty(EP, 'polaczenie', { enumerable: true, get: function () {
    if (!backend || backend.kind !== 'server') return null;
    return backend.paused ? 'wstrzymane' : (backend.es && backend.es.readyState === 1 ? 'otwarte' : 'brak');
  } });

  var ready = pingServer().then(function (r) {
    // strona z adresu serwera, który chwilowo nie odpowiada (albo chce hasła), zostaje w trybie serwera
    // i czeka na niego z paskiem „Brak połączenia…” — nigdy nie zapisuje po cichu w przeglądarce
    if (r !== 'none') {
      var b = new ServerBackend(); backend = b;
      EP.mode = 'server'; EP.storage = 'server'; EP.online = false; EP.label = 'Tryb serwera — łączenie z serwerem…';
      return b.init();
    }
    return initBrowser();
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
  // jak na platformie: przestrzenie nazw są zamrożone, use() tej samej nazwy daje tę samą obietnicę,
  // nieznana nazwa → null
  var NAMESPACES = { db: Object.freeze(dbApi), assets: Object.freeze(assetsApi), downloads: Object.freeze(downloadsApi) };
  var uses = {};
  window.claude = {
    use: function (name) {
      var known = Object.prototype.hasOwnProperty.call(NAMESPACES, name);
      if (known && uses[name]) return uses[name];
      var p = ready.then(function () { return known ? NAMESPACES[name] : null; }, function () { return null; });
      if (known) uses[name] = p;
      return p;
    },
  };
})(window, document);
