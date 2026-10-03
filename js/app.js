/* Interfejs aplikacji: stan, zapis w przeglądarce, widoki i obsługa zdarzeń. */
(function () {
  'use strict';

  var E = window.KredytEngine, D = window.KredytData, C = window.KredytCharts;
  var KEY = 'kredyt-app-v3', OLD_KEY = 'kredyt-auto-v2', OLDEST_KEY = 'kredyt-auto-v1', THEME_KEY = 'kredyt-theme';
  var IS_ARTIFACT = !!window.__KREDYT_ARTIFACT__;
  var VIEWS = ['dash', 'pay', 'sched', 'sim', 'set'];

  /* ---------- pomocnicze ---------- */

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  var money = new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' });
  var money0 = new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN', maximumFractionDigits: 0 });
  var fmt = function (n) { return money.format(Math.abs(n) < 0.005 ? 0 : n); };
  var fmt0 = function (n) { return money0.format(n); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var dt = function (s) { return E.parse(s); };
  var fD = function (s) { return dt(s).toLocaleDateString('pl-PL'); };
  var fM = function (s) { return dt(s.length === 7 ? s + '-01' : s).toLocaleDateString('pl-PL', { month: 'long', year: 'numeric' }); };
  var fMs = function (s) { return dt(s).toLocaleDateString('pl-PL', { month: 'short', year: 'numeric' }); };
  var MONTHS_NOM = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień'];
  var fMnom = function (ym) { var p = ym.split('-'); return MONTHS_NOM[+p[1] - 1] + ' ' + p[0]; };
  var pct1 = function (x) { return (Math.round(x * 10) / 10).toFixed(1).replace('.', ',') + '%'; };
  function plural(n, one, few, many) {
    n = Math.abs(n);
    if (n === 1) return one;
    var d = n % 10, h = n % 100;
    return d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
  }
  var months = function (n) { return n + ' ' + plural(n, 'miesiąc', 'miesiące', 'miesięcy'); };
  var rat = function (n) { return n + ' ' + plural(n, 'rata', 'raty', 'rat'); };
  var wplat = function (n) { return n + ' ' + plural(n, 'wpłata', 'wpłaty', 'wpłat'); };
  function today() { return E.iso(new Date()); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function bigMoney(v) {
    var s = fmt(v), m = s.match(/^(.*),(\d{2})(\s*zł)$/);
    return m ? esc(m[1]) + '<span class="gr">,' + m[2] + m[3] + '</span>' : esc(s);
  }
  function num(v) { var x = parseFloat(String(v).replace(',', '.')); return isFinite(x) ? x : 0; }

  var ICON = {
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>',
    wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="3"/><path d="M3 10h18M16 14.5h2"/></svg>'
  };

  /* ---------- stan ---------- */

  function defaultState() {
    return {
      v: 3,
      loan: Object.assign({}, D.DEFAULT_LOAN),
      baseSchedule: E.contractSchedule(D.DEFAULT_LOAN.start),
      bankSchedule: null,
      payments: []
    };
  }

  function normalize(s) {
    var d = defaultState();
    if (!s || typeof s !== 'object' || !s.loan) return d;
    var L = Object.assign({}, d.loan, s.loan);
    ['amount', 'rate', 'n', 'inst', 'first', 'income'].forEach(function (k) { L[k] = +L[k] || 0; });
    if (!(L.amount > 0)) L.amount = d.loan.amount;
    L.n = Math.max(1, Math.round(L.n) || 1);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(L.start || '')) L.start = d.loan.start;
    L.mode = L.mode === 'reduce' ? 'reduce' : 'shorten';
    var okRows = function (rows) {
      return Array.isArray(rows) && rows.length && rows.every(function (r) { return r && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && isFinite(r.pay) && isFinite(r.int) && isFinite(r.bal); });
    };
    return {
      v: 3,
      loan: L,
      baseSchedule: okRows(s.baseSchedule) ? s.baseSchedule : null,
      bankSchedule: s.bankSchedule && okRows(s.bankSchedule.rows) ? { rows: s.bankSchedule.rows, importedAt: +s.bankSchedule.importedAt || 0 } : null,
      payments: (Array.isArray(s.payments) ? s.payments : []).filter(function (p) {
        return p && /^\d{4}-\d{2}-\d{2}$/.test(p.date) && +p.amount > 0;
      }).map(function (p) {
        return { id: String(p.id || uid()), date: p.date, amount: Math.round(+p.amount * 100) / 100, type: p.type === 'nadplata' ? 'nadplata' : 'rata', note: String(p.note || '').slice(0, 80), ts: +p.ts || 0 };
      })
    };
  }

  // Dane z poprzedniej wersji aplikacji (kredyt-auto-v2).
  function migrate(o) {
    var d = defaultState();
    var L = o.loan || {};
    var s = {
      loan: Object.assign({}, d.loan, {
        name: L.name || d.loan.name, amount: +L.amount || d.loan.amount, rate: L.rate != null ? +L.rate : d.loan.rate,
        n: +L.n || d.loan.n, inst: +L.inst || 0, first: +L.first || 0, start: L.start || d.loan.start
      }),
      baseSchedule: L.sched === false ? null : E.contractSchedule(L.start || d.loan.start),
      bankSchedule: o.table && o.table.length ? { rows: o.table, importedAt: o.tableTs || 0 } : null,
      payments: o.pays || []
    };
    return normalize(s);
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) return normalize(JSON.parse(raw));
      var old = localStorage.getItem(OLD_KEY);
      if (old) return migrate(JSON.parse(old));
      var oldest = localStorage.getItem(OLDEST_KEY);
      if (oldest) { var st = defaultState(); st.payments = (JSON.parse(oldest).pays || []); return normalize(st); }
    } catch (e) { /* brak dostępu do pamięci przeglądarki */ }
    return defaultState();
  }
  var storageOk = true;
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(S)); storageOk = true; }
    catch (e) { storageOk = false; }
  }

  var S = load();
  var ui = { view: 'dash', ptype: 'rata', editId: null, mode: S.loan.mode, schedFilter: 'all', arm: null };

  /* ---------- toast i potwierdzenia ---------- */

  var toastTimer;
  function toast(m) {
    var t = $('#toast');
    t.textContent = m; t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, 2600);
  }

  // Dwuetapowe potwierdzenie: pierwsze kliknięcie uzbraja przycisk, drugie wykonuje akcję.
  function armed(key, btn, label) {
    if (ui.arm && ui.arm.key === key) { clearTimeout(ui.arm.t); ui.arm = null; return true; }
    if (ui.arm) disarm();
    var orig = btn.innerHTML;
    btn.classList.add('arm');
    btn.innerHTML = label;
    ui.arm = { key: key, btn: btn, orig: orig, t: setTimeout(disarm, 3500) };
    return false;
  }
  function disarm() {
    if (!ui.arm) return;
    clearTimeout(ui.arm.t);
    if (ui.arm.btn.isConnected) { ui.arm.btn.classList.remove('arm'); ui.arm.btn.innerHTML = ui.arm.orig; }
    ui.arm = null;
  }

  /* ---------- nagłówek ---------- */

  function renderHeader(a) {
    var L = S.loan;
    $('#ttl').textContent = L.name || 'Kredyt samochodowy';
    document.title = L.name ? L.name + ' · Kredyt samochodowy' : 'Kredyt samochodowy';
    var parts = [rat(L.n)];
    parts.push(L.first > 0 ? fmt(a.firstInst) + ' pierwsza, potem ' + fmt(a.inst) : fmt(a.inst));
    parts.push(String(L.rate).replace('.', ',') + '%');
    $('#sub').textContent = parts.join(' · ');
  }

  /* ---------- panel ---------- */

  function statCard(k, v, n, cls) {
    return '<div class="card stat"><div class="k">' + k + '</div><div class="v ' + (cls || '') + '">' + v + '</div><div class="n">' + (n || '') + '</div></div>';
  }

  function scheduleChip(a) {
    if (a.finished) return '<span class="chip ok">spłacony</span>';
    if (a.ahead > 0) return '<span class="chip ok">' + rat(a.ahead) + ' do przodu</span>';
    if (a.ahead < 0) return '<span class="chip er">' + rat(-a.ahead) + ' zaległe</span>';
    return '<span class="chip ok">zgodnie z planem</span>';
  }

  function renderDash(a) {
    var L = S.loan, el = $('#v-dash');
    var principalPaid = Math.max(L.amount - a.bal, 0);
    var overCount = S.payments.filter(function (p) { return p.type === 'nadplata'; }).length;
    var remaining = a.proj.length;
    var ratPr = Math.max(a.paid - a.over - a.paidInt, 0);
    var pcOf = function (v) { return a.paid > 0 ? Math.max(v, 0) / a.paid * 100 : 0; };

    var miles = [25, 50, 75, 100].map(function (m) {
      if (a.pct >= m - 1e-9) return '<span class="chip ok">' + ICON.check.replace('<svg', '<svg width="11" height="11"') + ' ' + m + '%</span>';
      return null;
    }).filter(Boolean);
    var nextMile = [25, 50, 75, 100].filter(function (m) { return a.pct < m; })[0];
    if (nextMile) miles.push('<span class="chip">do ' + nextMile + '%: ' + fmt0(L.amount * nextMile / 100 - principalPaid) + '</span>');

    var dtxt = '';
    if (a.next) dtxt = a.daysToNext < 0 ? 'po terminie ' + Math.abs(a.daysToNext) + ' dni' : a.daysToNext === 0 ? 'dziś' : a.daysToNext === 1 ? 'jutro' : 'za ' + a.daysToNext + ' dni';
    var dchip = !a.next ? '' : '<span class="chip ' + (a.daysToNext < 0 ? 'er' : a.daysToNext <= 5 ? 'wa' : '') + '">' + dtxt + '</span>';

    var insight;
    if (a.finished) insight = 'Kredyt jest spłacony. Łącznie zapłaciłeś <b>' + fmt(a.paid) + '</b>, w tym <b>' + fmt(a.paidInt) + '</b> odsetek.';
    else if (a.over > 0 && (a.saved > 0.5 || a.monthsSaved > 0)) {
      insight = 'Dzięki nadpłatom (' + fmt(a.over) + ') oszczędzasz około <b class="good">' + fmt(a.saved) + '</b> odsetek' +
        (a.monthsSaved ? ' i kończysz spłatę <b class="good">' + months(a.monthsSaved) + '</b> wcześniej' : '') +
        (a.end < a.baseEnd ? '. Ostatnia rata przypada na <b>' + fM(a.end) + '</b> zamiast ' + fM(a.baseEnd) + '.' : '. Ostatnia rata wciąż przypada na <b>' + fM(a.end) + '</b>, ale będzie niższa.');
    } else {
      insight = 'Bez nadpłat ostatnia rata przypada na <b>' + fM(a.end) + '</b>. Każda nadpłata zmniejsza kapitał i skraca spłatę. Sprawdź w <a href="#sim" data-show="sim" class="good" style="font-weight:800">Symulatorze</a>, ile możesz zyskać.';
    }

    var notes = '';
    if (a.stalled) notes += '<div class="note errbox"><b class="bad">Rata nie pokrywa odsetek.</b> Przy tych ustawieniach kredyt nigdy się nie spłaci. Sprawdź wysokość raty i oprocentowanie w Ustawieniach.</div>';
    if (!a.finished && a.next && a.daysToNext < 0) {
      notes += '<div class="note errbox"><b class="bad">Rata z ' + fD(a.next.date) + ' nie jest zapisana.</b> Jeśli już zapłaciłeś, dodaj ją, a panel się przeliczy.' +
        '<button class="btn b1 block" data-add="rata">Zapisz ratę ' + fmt(a.next.pay) + '</button></div>';
    }
    if (a.pending) notes += '<div class="note warnbox"><b class="warn">Wartości po nadpłacie są szacunkowe.</b> Gdy bank przyśle nowy harmonogram, wklej go w Ustawieniach, a liczby będą co do grosza. Sprawdź też, czy w dyspozycji nadpłaty wybrałeś ' + (L.mode === 'reduce' ? 'obniżenie raty' : 'skrócenie okresu') + '.' +
      '<button class="btn b3 block" data-show="set">Wczytaj harmonogram</button></div>';

    var budget = '';
    if (L.income > 0 && a.monthTotal > 0) {
      var share = a.monthTotal / L.income * 100;
      budget = ' <span class="chip ' + (share <= 35 ? 'ok' : share <= 50 ? 'wa' : 'er') + '">' + pct1(share) + ' dochodu</span>';
    }
    var monthNote = a.monthTotal > 0
      ? (a.month.rata ? 'rata ' + fmt0(a.month.rata) : 'bez raty') + (a.month.nadplata ? ' + nadpłata ' + fmt0(a.month.nadplata) : '')
      : 'brak wpłat w tym miesiącu';

    el.innerHTML =
      '<div class="hero">' +
        '<div class="lab">' + (a.finished ? 'Kredyt spłacony 🎉' : 'Pozostało do spłaty') + ' ' + scheduleChip(a) + '</div>' +
        '<div class="big">' + bigMoney(a.bal) + '</div>' +
        '<div class="of">spłacono ' + fmt(principalPaid) + ' z ' + fmt(L.amount) + ' kapitału</div>' +
        '<div class="road" aria-hidden="true"><div class="done" style="width:' + a.pct.toFixed(2) + '%"></div>' +
          '<div class="mile" style="left:25%"></div><div class="mile" style="left:50%"></div><div class="mile" style="left:75%"></div>' +
          '<div class="flag">🏁</div><div class="car" style="left:' + Math.max(a.pct, 8).toFixed(2) + '%">🚗</div></div>' +
        '<div class="pct"><span>Start</span><span>' + pct1(a.pct) + ' spłacone</span><span>Meta: ' + fMs(a.end) + '</span></div>' +
        '<div class="miles">' + miles.join('') + '</div>' +
        (a.finished ? '' : '<div class="quick"><button class="btn b1" data-add="rata">' + ICON.check + 'Wpłać ratę</button><button class="btn b2" data-add="nadplata">' + ICON.plus + 'Nadpłać</button></div>') +
      '</div>' + notes +
      '<div class="grid">' +
        statCard('Następna rata', a.next ? fmt(a.next.pay) : '—', a.next ? fD(a.next.date) + ' ' + dchip : 'wszystko spłacone') +
        statCard('Raty spłacone', a.k + ' <span style="font-size:14px;color:var(--mut)">/ ' + a.count + '</span>', 'zostało ' + rat(remaining)) +
        statCard('Nadpłaty', fmt(a.over), overCount ? wplat(overCount) : 'jeszcze żadnej', 'warn') +
        statCard('Oszczędność', fmt(a.saved), a.monthsSaved ? months(a.monthsSaved) + ' krócej' : 'dzięki nadpłatom', 'good') +
      '</div>' +
      '<div class="note">' + insight + '</div>' +
      '<div class="card section"><h2>Saldo kredytu w czasie <small>dotknij wykresu, aby zobaczyć szczegóły</small></h2><div id="c-bal"></div></div>' +
      '<div class="grid">' +
        statCard('Ten miesiąc', fmt(a.monthTotal), monthNote + budget) +
        statCard('Względem harmonogramu', a.ahead > 0 ? '+' + rat(a.ahead) : a.ahead < 0 ? rat(-a.ahead) + ' w tyle' : 'na czas', 'wg dat: ' + rat(a.due) + ' do dziś', (a.ahead > 0 ? 'good' : a.ahead < 0 ? 'bad' : '') + ' md') +
        statCard('Wpłacono łącznie', fmt(a.paid), wplat(S.payments.length)) +
        statCard('Średnio miesięcznie', fmt(a.avgMonthly), 'największa: ' + fmt(a.biggest)) +
        statCard('Odsetki w kolejnej racie', a.next ? fmt(a.next.int) : '—', a.next ? 'na kapitał: ' + fmt(a.next.principal) : '') +
        statCard('Zapłacone odsetki', fmt(a.paidInt), 'do końca ok. ' + fmt(a.futInt)) +
        statCard('Całkowity koszt', fmt(a.cost), 'kapitał + odsetki (prognoza)') +
        statCard('Udział odsetek', pct1(a.cost ? a.totalInt / a.cost * 100 : 0), fmt(a.totalInt) + ' odsetek łącznie') +
      '</div>' +
      '<div class="duo">' +
        '<div class="card"><h2>Na co poszły wpłaty</h2>' +
          (a.paid > 0
            ? '<div class="split"><i style="width:' + pcOf(ratPr) + '%;background:var(--acc)"></i><i style="width:' + pcOf(a.paidInt) + '%;background:var(--red)"></i><i style="width:' + pcOf(a.over) + '%;background:var(--amb)"></i></div>' +
              '<div class="lg"><span style="--c:var(--acc)">Kapitał z rat <b>' + fmt(ratPr) + '</b></span><span style="--c:var(--red)">Odsetki <b>' + fmt(a.paidInt) + '</b></span><span style="--c:var(--amb)">Nadpłaty <b>' + fmt(a.over) + '</b></span></div>'
            : '<div class="empty">Podział pojawi się po pierwszej wpłacie.</div>') +
        '</div>' +
        '<div class="card"><h2>Plan a rzeczywistość</h2><div class="cmp">' +
          '<span class="h"></span><span class="h r">Pierwotnie</span><span class="h r">Teraz</span>' +
          '<span>Liczba rat</span><span class="r">' + a.planCount + '</span><span class="r ' + (a.count < a.planCount ? 'good' : '') + '">' + a.count + '</span>' +
          '<span>Ostatnia rata</span><span class="r">' + fMs(a.planEnd) + '</span><span class="r ' + (a.end < a.planEnd ? 'good' : '') + '">' + fMs(a.end) + '</span>' +
          '<span>Odsetki łącznie</span><span class="r">' + fmt0(a.planInt) + '</span><span class="r ' + (a.totalInt < a.planInt - 0.5 ? 'good' : '') + '">' + fmt0(a.totalInt) + '</span>' +
        '</div></div>' +
      '</div>' +
      '<div class="card section"><h2>Wpłaty miesiąc po miesiącu <small>ostatnie 12 miesięcy</small></h2><div id="c-bars"></div></div>';

    balanceChart($('#c-bal'), a);
    monthlyBars($('#c-bars'));
  }

  // x = liczba spłaconych rat; data punktu x to termin raty nr x.
  function xDate(a, i) { return i === 0 ? null : a.dateFor(i - 1); }

  function balanceChart(el, a) {
    var plan = [S.loan.amount].concat(a.plan.map(function (r) { return r.bal; }));
    var proj = [a.bal].concat(a.proj.map(function (r) { return r.bal; }));
    var N = Math.max(plan.length - 1, a.count, 1);
    C.line(el, {
      N: N, yMax: S.loan.amount, label: 'Saldo kredytu w czasie',
      series: [
        { data: plan, color: 'var(--mut)', width: 2, dash: '4 5', opacity: 0.7 },
        { data: proj, offset: a.k, color: 'var(--acc)', width: 2.5, dash: '2 6', area: true },
        { data: a.act, color: 'var(--acc)', width: 3.5 }
      ],
      marker: { x: a.k, y: a.bal, color: 'var(--acc)' },
      xTick: function (i) {
        var d = xDate(a, i);
        if (i === 0) return null;
        return d && d.slice(5, 7) === '01' ? d.slice(0, 4) : null;
      },
      tip: function (i) {
        var d = xDate(a, i), real = i <= a.k, v = real ? a.act[i] : proj[i - a.k];
        var head = i === 0 ? 'Start kredytu' : 'Po racie ' + i + (d ? ' · ' + fD(d) : '');
        var out = '<b>' + head + '</b><br>' + (real ? 'Saldo: ' : 'Prognoza: ') + '<b>' + fmt(v == null ? 0 : v) + '</b>';
        if (plan[i] != null) out += '<br>Plan: ' + fmt(plan[i]);
        return out;
      },
      legend: '<div class="leg"><span><i style="background:var(--acc)"></i>Twoje saldo</span><span style="color:var(--acc)"><i class="d"></i><span style="color:var(--mut)">Prognoza</span></span><span style="color:var(--mut)"><i class="d"></i>Pierwotny harmonogram</span></div>'
    });
  }

  function monthlyBars(el) {
    var m = {};
    S.payments.forEach(function (p) {
      var k = p.date.slice(0, 7);
      (m[k] = m[k] || { r: 0, o: 0 })[p.type === 'rata' ? 'r' : 'o'] += p.amount;
    });
    var keys = Object.keys(m).sort().slice(-12);
    if (!keys.length) { el.innerHTML = '<div class="empty">' + ICON.wallet + 'Wykres pojawi się po pierwszej wpłacie.</div>'; return; }
    var inc = S.loan.income;
    C.bars(el, {
      label: 'Wpłaty miesięczne',
      items: keys.map(function (k) {
        var tot = m[k].r + m[k].o;
        return {
          label: k.slice(5) + '/' + k.slice(2, 4),
          parts: [{ v: m[k].r, color: 'var(--acc)' }, { v: m[k].o, color: 'var(--amb)' }],
          tip: '<b>' + fMnom(k) + '</b><br>Raty: ' + fmt(m[k].r) + '<br>Nadpłaty: ' + fmt(m[k].o) + '<br>Razem: <b>' + fmt(tot) + '</b>' + (inc > 0 ? '<br>' + pct1(tot / inc * 100) + ' dochodu' : '')
        };
      }),
      legend: '<div class="leg"><span><i style="background:var(--acc)"></i>Raty</span><span><i style="background:var(--amb)"></i>Nadpłaty</span></div>'
    });
  }

  /* ---------- wpłaty ---------- */

  function renderPay(a) {
    var hist = $('#hist');
    $('#hist-sum').textContent = S.payments.length ? wplat(S.payments.length) + ' · ' + fmt(a.paid) : '';
    if (!S.payments.length) {
      hist.innerHTML = '<div class="empty">' + ICON.wallet + 'Brak wpłat. Zapisz pierwszą ratę, a pojawi się tutaj.</div>';
    } else {
      var byId = {};
      a.history.forEach(function (h) { byId[h.id] = h; });
      var groups = {};
      E.sortPayments(S.payments).reverse().forEach(function (p) { (groups[p.date.slice(0, 7)] = groups[p.date.slice(0, 7)] || []).push(p); });
      var html = '';
      Object.keys(groups).sort().reverse().forEach(function (ym) {
        var list = groups[ym], tot = list.reduce(function (s, p) { return s + p.amount; }, 0);
        var share = S.loan.income > 0 ? '<small>' + pct1(tot / S.loan.income * 100) + ' dochodu</small>' : '';
        html += '<div class="month-h"><span>' + fMnom(ym) + '</span><span class="tot"><b>' + fmt(tot) + '</b>' + share + '</span></div>';
        list.forEach(function (p) {
          var h = byId[p.id] || {}, isR = p.type === 'rata', sub;
          if (isR) sub = '<small class="mut">odsetki ' + fmt(h.int || 0) + '</small>';
          else {
            var eff = E.overpaymentEffect(S, p.id, a);
            sub = '<small class="good">−' + fmt0(eff.interest) + ' odsetek</small>';
          }
          html += '<div class="item">' +
            '<div class="dot ' + (isR ? 'r' : 'o') + '">' + (isR ? ICON.check : ICON.plus) + '</div>' +
            '<div class="m"><div class="t">' + (isR ? 'Rata' + (h.no ? ' nr ' + h.no : '') : 'Nadpłata') + '</div>' +
            '<div class="d">' + fD(p.date) + (p.note ? ' · ' + esc(p.note) : '') + '</div></div>' +
            '<div class="a">' + fmt(p.amount) + sub + '</div>' +
            '<div class="acts"><button class="x" type="button" data-edit="' + esc(p.id) + '" aria-label="Edytuj wpłatę" title="Edytuj">' + ICON.edit + '</button>' +
            '<button class="x del" type="button" data-del="' + esc(p.id) + '" aria-label="Usuń wpłatę" title="Usuń">' + ICON.trash + '</button></div>' +
          '</div>';
        });
      });
      hist.innerHTML = html;
    }
    payHint();
  }

  function setType(t, keepAmount) {
    ui.ptype = t;
    $$('#seg button').forEach(function (b) { var on = b.dataset.t === t; b.className = on ? 'on ' + (t === 'rata' ? 'r' : 'o') : ''; b.setAttribute('aria-pressed', on); });
    if (!keepAmount) {
      var m = E.simulate(S);
      $('#pa').value = t === 'rata' && m.next ? E.round2(m.next.pay).toFixed(2) : '';
    }
    payHint();
  }

  function payHint() {
    var el = $('#pa-hint'); if (!el) return;
    var amt = num($('#pa').value), m = E.simulate(S);
    if (ui.ptype === 'rata') {
      el.innerHTML = m.next && !ui.editId ? 'Rata nr ' + m.next.no + ' wg harmonogramu: <b>' + fmt(m.next.pay) + '</b>, termin ' + fD(m.next.date) + '. Wpisz kwotę z przelewu.' : '';
      return;
    }
    if (!(amt > 0)) { el.innerHTML = 'Pamiętaj o dyspozycji w banku: ' + (S.loan.mode === 'reduce' ? 'obniżenie raty' : 'skrócenie okresu') + '.'; return; }
    var trial = JSON.parse(JSON.stringify(S));
    if (ui.editId) trial.payments = trial.payments.filter(function (p) { return p.id !== ui.editId; });
    var base = E.simulate(trial);
    trial.payments.push({ id: '__trial', type: 'nadplata', date: $('#pd').value || today(), amount: amt, ts: Date.now() });
    var after = E.simulate(trial);
    var saved = Math.max(base.totalInt - after.totalInt, 0), mo = Math.max(base.count - after.count, 0);
    el.innerHTML = 'Ta nadpłata zmniejszy odsetki o ok. <b class="good">' + fmt(saved) + '</b>' +
      (S.loan.mode === 'reduce'
        ? ', a rata spadnie do ok. <b>' + fmt(after.next ? after.next.pay : 0) + '</b>.'
        : (mo ? ' i skróci kredyt o <b class="good">' + months(mo) + '</b>.' : '. Przy tej kwocie okres skróci się o mniej niż jedną ratę.'));
  }

  function resetPayForm() {
    ui.editId = null;
    $('#pf-title').textContent = 'Nowa wpłata';
    $('#pf-submit').textContent = 'Zapisz wpłatę';
    $('#pf-cancel').hidden = true;
    $('#edit-bar-slot').innerHTML = '';
    $('#pd').value = today();
    $('#pn').value = '';
    setType('rata');
  }

  function startEdit(id) {
    var p = S.payments.find(function (x) { return x.id === id; });
    if (!p) return;
    ui.editId = id;
    show('pay');
    $('#pf-title').textContent = 'Edytuj wpłatę';
    $('#pf-submit').textContent = 'Zapisz zmiany';
    $('#pf-cancel').hidden = false;
    $('#edit-bar-slot').innerHTML = '<div class="edit-bar"><span>Edytujesz wpłatę z ' + fD(p.date) + '</span></div>';
    $('#pd').value = p.date;
    $('#pa').value = p.amount.toFixed(2);
    $('#pn').value = p.note || '';
    setType(p.type, true);
    $('#pa').focus();
  }

  /* ---------- harmonogram ---------- */

  function renderSched(a) {
    var el = $('#v-sched');
    var src = S.bankSchedule ? 'harmonogramu od banku wczytanego ' + fD(E.iso(new Date(S.bankSchedule.importedAt || Date.now())))
      : S.baseSchedule ? 'harmonogramu z umowy' : 'parametrów kredytu (wyliczony)';
    var rows = [];
    a.history.forEach(function (h) { rows.push({ kind: h.type === 'rata' ? 'paid' : 'ovp', date: h.date, no: h.no, pay: h.amount, principal: h.principal, int: h.int, bal: h.bal }); });
    a.proj.forEach(function (p, i) { rows.push({ kind: i === 0 ? 'nx' : 'fut', date: p.date, no: p.no, pay: p.pay, principal: p.principal, int: p.int, bal: p.bal }); });
    var f = ui.schedFilter;
    var vis = rows.filter(function (r) { return f === 'all' || (f === 'paid' ? (r.kind === 'paid' || r.kind === 'ovp') : (r.kind === 'nx' || r.kind === 'fut')); });
    var body = '', yr = '';
    vis.forEach(function (r) {
      var y = r.date.slice(0, 4);
      if (y !== yr) { yr = y; body += '<tr class="yr"><td colspan="7">' + y + '</td></tr>'; }
      var cls = r.kind === 'paid' ? 'paid' : r.kind === 'ovp' ? 'ovp' : r.kind === 'nx' ? 'nx' : '';
      var mark = r.kind === 'paid' ? '✓' : r.kind === 'ovp' ? 'nadpłata' : r.kind === 'nx' ? 'następna' : '';
      body += '<tr class="' + cls + '"><td>' + (r.kind === 'ovp' ? '+' : r.no) + '</td><td>' + fD(r.date) + '</td><td>' + fmt(r.pay) + '</td><td>' + fmt(r.principal) + '</td><td>' + (r.kind === 'ovp' ? '—' : fmt(r.int)) + '</td><td>' + fmt(r.bal) + '</td><td>' + mark + '</td></tr>';
    });
    var chip = function (k, l) { return '<button type="button" class="chip ' + (f === k ? 'ok' : '') + '" data-filter="' + k + '" style="cursor:pointer;padding:6px 12px;font-size:12.5px">' + l + '</button>'; };
    el.innerHTML =
      '<div class="grid" style="margin-top:0">' +
        statCard('Raty zapłacone', String(a.k), 'z ' + a.count + ' łącznie') +
        statCard('Zostało rat', String(a.proj.length), a.next ? 'następna ' + fD(a.next.date) : '') +
        statCard('Ostatnia rata', fMs(a.end), a.proj.length ? fmt(a.proj[a.proj.length - 1].pay) : '', 'md') +
        statCard('Odsetki do końca', fmt(a.futInt), 'zapłacone: ' + fmt(a.paidInt)) +
      '</div>' +
      '<div class="card section"><h2>Harmonogram spłat <small>na podstawie ' + src + '</small></h2>' +
        '<div class="filters">' + chip('all', 'Wszystkie') + chip('paid', 'Zapłacone') + chip('fut', 'Przyszłe') + '</div>' +
        (vis.length ? '<div class="tbl-wrap"><table class="tb"><thead><tr><th>Nr</th><th>Termin</th><th>Kwota</th><th>Kapitał</th><th>Odsetki</th><th>Saldo po</th><th></th></tr></thead><tbody>' + body + '</tbody></table></div>'
          : '<div class="empty">Brak pozycji w tym widoku.</div>') +
        '<div class="row-btns" style="margin-top:14px"><button class="btn b3" type="button" id="csv-copy">Kopiuj jako CSV</button><button class="btn b3 standalone-only" type="button" id="csv-dl">Pobierz CSV (Excel)</button></div>' +
        '<p class="hint">Zapłacone raty pokazują Twoje faktyczne wpłaty. Przyszłe raty to prognoza' + (a.pending ? ' (szacunkowa, bo po ostatniej nadpłacie nie wczytano nowego harmonogramu)' : '') + '.</p>' +
      '</div>';
  }

  /* ---------- symulator ---------- */

  function renderSim() {
    var wm = Math.max(num($('#wm').value), 0), wo = Math.max(num($('#wo').value), 0);
    var w = E.whatIf(S, wm, wo), now = w.now, sim = w.sim, reduce = S.loan.mode === 'reduce';
    var res = $('#wres');
    if (!now.proj.length) {
      res.innerHTML = '<p class="hint">Kredyt jest spłacony, nie ma czego symulować.</p>';
      $('#wchart').innerHTML = ''; $('#timing').innerHTML = ''; $('#tres').innerHTML = '';
      return;
    }
    if (!(wm > 0 || wo > 0)) {
      res.innerHTML = '<div class="res"><div><div class="k">Koniec bez nadpłat</div><div class="v">' + fMs(now.end) + '</div></div><div><div class="k">Odsetki do końca</div><div class="v">' + fmt0(now.futInt) + '</div></div></div><p class="hint">Wpisz kwotę albo wybierz jedną z propozycji.</p>';
    } else {
      var per100 = w.extraPaid > 0 ? w.interestSaved / w.extraPaid * 100 : 0;
      res.innerHTML = '<div class="res">' +
        '<div><div class="k">Koniec kredytu</div><div class="v good">' + fMs(sim.end) + '</div></div>' +
        (reduce
          ? '<div><div class="k">Nowa rata</div><div class="v good">' + fmt(w.newInst) + '</div></div>'
          : '<div><div class="k">Krócej o</div><div class="v good">' + months(w.monthsSaved) + '</div></div>') +
        '<div><div class="k">Mniej odsetek</div><div class="v good">' + fmt0(w.interestSaved) + '</div></div>' +
        '<div><div class="k">Łącznie nadpłacisz</div><div class="v">' + fmt0(w.extraPaid) + '</div></div>' +
        '</div><p class="hint">Każde 100 zł nadpłaty daje ok. <b>' + fmt(per100) + '</b> mniej odsetek. Bez nadpłat koniec: ' + fMs(now.end) + '.' +
        (reduce ? ' Liczę w trybie obniżenia raty, zmienisz to w Ustawieniach.' : '') + '</p>' +
        (wo > 0 ? '<button class="btn b2 block" type="button" id="sim-add">Zapisz nadpłatę ' + fmt0(wo) + ' jako wpłatę</button>' : '');
    }

    var a0 = [now.bal].concat(now.proj.map(function (r) { return r.bal; }));
    var a1 = [Math.max(now.bal - Math.min(wo, now.bal), 0)].concat(sim.proj.map(function (r) { return r.bal; }));
    var hasSim = wm > 0 || wo > 0;
    C.line($('#wchart'), {
      N: Math.max(a0.length - 1, 1), yMax: Math.max(now.bal, 1), label: 'Saldo teraz i z nadpłatami', height: 230,
      series: hasSim
        ? [{ data: a0, color: 'var(--mut)', width: 2, dash: '4 5', opacity: 0.8 }, { data: a1, color: 'var(--acc)', width: 3, area: true }]
        : [{ data: a0, color: 'var(--acc)', width: 3, area: true }],
      xTick: function (i) { var p = now.proj[i - 1]; return p && p.date.slice(5, 7) === '01' ? p.date.slice(0, 4) : null; },
      tip: function (i) {
        var p = now.proj[i - 1], out = '<b>' + (i === 0 ? 'Dziś' : 'Za ' + months(i) + (p ? ' · ' + fMs(p.date) : '')) + '</b>';
        if (hasSim) out += '<br>Bez nadpłat: ' + fmt(a0[i] || 0) + '<br>Z nadpłatami: <b>' + fmt(a1[i] != null ? a1[i] : 0) + '</b>';
        else out += '<br>Saldo: <b>' + fmt(a0[i] || 0) + '</b>';
        return out;
      },
      legend: hasSim ? '<div class="leg"><span style="color:var(--mut)"><i class="d"></i>Bez nadpłat</span><span><i style="background:var(--acc)"></i>Z nadpłatami</span></div>' : ''
    });

    // Kiedy nadpłacić: ta sama kwota teraz, za rok, za dwa, za trzy lata.
    var lump = wo > 0 ? wo : 10000, rowsT = '';
    [0, 12, 24, 36].forEach(function (after) {
      if (after && after >= now.proj.length) return;
      var s = E.simulate(S, { lumps: [{ after: after, amount: lump }] });
      var sv = Math.max(now.futInt - s.futInt, 0);
      var when = after === 0 ? 'Teraz' : 'Za ' + (after / 12) + ' ' + plural(after / 12, 'rok', 'lata', 'lat');
      rowsT += '<span>' + when + (now.proj[after] ? ' <span class="mut small">(' + fMs(now.proj[Math.max(after - 1, 0)].date) + ')</span>' : '') + '</span><span class="good">−' + fmt0(sv) + '</span>';
    });
    $('#timing').innerHTML = '<div class="kv"><span class="mut small">Nadpłata ' + fmt0(lump) + '</span><span class="mut small">mniej odsetek</span>' + rowsT + '</div>';

    renderTarget(now);
  }

  function renderTarget(now) {
    var tg = $('#tg');
    if (!tg.value) {
      var d = E.addMonths(now.end, -12);
      tg.value = (d < now.proj[0].date ? now.end : d).slice(0, 7);
    }
    tg.min = now.proj[0].date.slice(0, 7);
    var r = E.monthlyForTarget(S, tg.value), out = $('#tres');
    if (!r.reachable) {
      out.innerHTML = '<p class="hint bad" style="font-weight:700">Ten termin jest za blisko. Najwcześniej możesz skończyć po spłacie całego salda (' + fmt(now.bal) + ') przy następnej racie.</p>';
    } else if (r.monthly === 0) {
      out.innerHTML = '<p class="hint"><b class="good">Zdążysz bez nadpłat.</b> Według planu ostatnia rata przypada na ' + fM(now.end) + '.</p>';
    } else {
      var saved = Math.max(now.futInt - r.sim.futInt, 0);
      out.innerHTML = '<div class="res"><div><div class="k">Nadpłacaj co miesiąc</div><div class="v good">' + fmt0(r.monthly) + '</div></div>' +
        '<div><div class="k">Mniej odsetek</div><div class="v good">' + fmt0(saved) + '</div></div></div>' +
        '<p class="hint">Ostatnia rata: ' + fM(r.sim.end) + '. W sumie nadpłacisz ok. ' + fmt0(r.sim.extraPaid) + '. Raz w miesiącu razem z ratą zapłacisz ok. ' + fmt0((now.next ? now.next.pay : 0) + r.monthly) + '.</p>' +
        '<button class="btn b3 block" type="button" id="tg-use">Pokaż w symulatorze</button>';
    }
  }

  /* ---------- ustawienia ---------- */

  function fillSettings() {
    var L = S.loan;
    $('#sn').value = L.name || '';
    $('#sa').value = L.amount;
    $('#sr').value = L.rate;
    $('#sk').value = L.n;
    $('#si').value = L.inst || '';
    $('#sf1').value = L.first || '';
    $('#ss').value = L.start;
    $('#sinc').value = L.income || '';
    ui.mode = L.mode;
    paintMode();
    estHint();
    renderSchedSrc();
  }
  function paintMode() { $$('#mode button').forEach(function (b) { var on = b.dataset.m === ui.mode; b.className = on ? 'on r' : ''; b.setAttribute('aria-pressed', on); }); }
  function estHint() {
    var tmp = { amount: num($('#sa').value), rate: num($('#sr').value), n: Math.max(1, Math.round(num($('#sk').value)) || 1), inst: 0, first: num($('#sf1').value) };
    $('#ih').textContent = tmp.amount > 0 ? 'Wyliczona: ' + fmt(E.regularInstallment(tmp)) : '';
  }
  function renderSchedSrc() {
    var t;
    if (S.bankSchedule) t = 'Prognoza korzysta z harmonogramu od banku wczytanego ' + fD(E.iso(new Date(S.bankSchedule.importedAt || Date.now()))) + '.';
    else if (S.baseSchedule) t = 'Prognoza korzysta z harmonogramu z umowy (' + rat(S.baseSchedule.length) + '). Zmiana kwoty, oprocentowania lub liczby rat zastąpi go wyliczonym.';
    else t = 'Harmonogram jest wyliczany z parametrów. Może się różnić o kilka groszy od bankowego, bo banki liczą odsetki co do dnia.';
    $('#sched-src').textContent = t;
    $('#imprst').hidden = !S.bankSchedule && !!S.baseSchedule;
    $('#imprst').textContent = S.bankSchedule ? 'Wróć do harmonogramu z umowy' : 'Przywróć harmonogram z umowy Tiggo';
  }

  function saveSettings(e) {
    e.preventDefault();
    var L = S.loan;
    var nl = {
      name: $('#sn').value.trim() || 'Kredyt samochodowy',
      amount: num($('#sa').value), rate: num($('#sr').value), n: Math.round(num($('#sk').value)),
      inst: num($('#si').value), first: num($('#sf1').value), start: $('#ss').value,
      mode: ui.mode, income: Math.max(num($('#sinc').value), 0)
    };
    if (!(nl.amount > 0)) return toast('Podaj kwotę kredytu większą od zera');
    if (nl.rate < 0 || nl.rate > 100) return toast('Oprocentowanie musi być między 0 a 100%');
    if (!(nl.n >= 1 && nl.n <= 600)) return toast('Liczba rat musi być od 1 do 600');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nl.start)) return toast('Wybierz datę pierwszej raty');
    var msg = 'Ustawienia zapisane';
    var paramsChanged = nl.amount !== L.amount || nl.rate !== L.rate || nl.n !== L.n || nl.inst !== L.inst || nl.first !== L.first;
    if (S.baseSchedule && paramsChanged) {
      S.baseSchedule = null; S.bankSchedule = null;
      msg = 'Zapisane. Harmonogram wyliczony z nowych parametrów';
    } else if (S.baseSchedule && nl.start !== L.start) {
      var diff = E.monthsBetween(L.start, nl.start);
      S.baseSchedule = S.baseSchedule.map(function (r) { return Object.assign({}, r, { date: E.addMonths(r.date, diff) }); });
    }
    S.loan = nl;
    save(); render(); toast(msg);
  }

  /* ---------- kopia zapasowa ---------- */

  function backupText() { return JSON.stringify({ app: 'kredyt-samochodowy', v: 3, exported: new Date().toISOString(), state: S }); }

  function copyText(text, okMsg, fallbackEl) {
    var fallback = function () {
      if (fallbackEl) { fallbackEl.value = text; fallbackEl.focus(); fallbackEl.select(); toast('Zaznaczyłem tekst. Skopiuj go (Ctrl+C lub Kopiuj).'); }
      else toast('Nie udało się skopiować');
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast(okMsg); }, fallback);
      else fallback();
    } catch (e) { fallback(); }
  }

  function download(name, text, type) {
    var blob = new Blob([text], { type: type }), url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 500);
  }

  function restoreFrom(text) {
    var o;
    try { o = JSON.parse(text); } catch (e) { return toast('To nie jest poprawna kopia. Wklej cały skopiowany tekst.'); }
    var st = o && o.state ? o.state : o;
    if (!st || !st.loan) return toast('W tej kopii nie ma danych kredytu');
    S = st.pays ? migrate(st) : normalize(st);
    save(); resetPayForm(); render();
    $('#bk-text').value = '';
    toast('Przywrócono dane: ' + wplat(S.payments.length));
  }

  /* ---------- nawigacja i render ---------- */

  function show(v) {
    if (VIEWS.indexOf(v) < 0) v = 'dash';
    var changed = ui.view !== v;
    ui.view = v;
    $$('.view').forEach(function (e) { e.classList.toggle('on', e.id === 'v-' + v); });
    $$('nav.tabs button').forEach(function (b) { var on = b.dataset.v === v; b.classList.toggle('on', on); b.setAttribute('aria-current', on ? 'page' : 'false'); });
    if (v === 'set') fillSettings();
    try { history.replaceState(null, '', v === 'dash' ? location.pathname + location.search : '#' + v); } catch (e) { /* ramka bez historii */ }
    render();
    if (changed) window.scrollTo({ top: 0 });
  }

  function render() {
    disarm();
    var a = E.analyze(S, today());
    renderHeader(a);
    if (ui.view === 'dash') renderDash(a);
    if (ui.view === 'pay') renderPay(a);
    if (ui.view === 'sched') renderSched(a);
    if (ui.view === 'sim') renderSim();
    if (ui.view === 'set') renderSchedSrc();
    if (!storageOk) toast('Nie mogę zapisać danych w tej przeglądarce. Zrób kopię zapasową.');
  }

  function paintTheme() {
    var r = document.documentElement;
    var dark = r.dataset.theme === 'dark' || (!r.dataset.theme && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
    $('#theme').innerHTML = dark ? ICON.sun : ICON.moon;
  }

  /* ---------- zdarzenia ---------- */

  $$('nav.tabs button').forEach(function (b) { b.addEventListener('click', function () { show(b.dataset.v); }); });

  document.addEventListener('click', function (e) {
    var t = e.target;
    var add = t.closest('[data-add]');
    if (add) { e.preventDefault(); resetPayForm(); show('pay'); setType(add.dataset.add); $('#pa').focus(); return; }
    var go = t.closest('[data-show]');
    if (go) { e.preventDefault(); show(go.dataset.show); return; }
    var ed = t.closest('[data-edit]');
    if (ed) { startEdit(ed.dataset.edit); return; }
    var del = t.closest('[data-del]');
    if (del) {
      if (!armed('del' + del.dataset.del, del, 'Usuń?')) return;
      var id = del.dataset.del;
      S.payments = S.payments.filter(function (p) { return p.id !== id; });
      if (ui.editId === id) resetPayForm();
      save(); render(); toast('Wpłata usunięta');
      return;
    }
    var fl = t.closest('[data-filter]');
    if (fl) { ui.schedFilter = fl.dataset.filter; render(); return; }
    var pr = t.closest('.presets button');
    if (pr) { var inp = $('#' + pr.parentNode.dataset.target); inp.value = pr.dataset.v; renderSim(); return; }
    if (t.closest('#csv-copy')) { copyText(E.scheduleCsv(E.simulate(S)).replace(/^﻿/, ''), 'Skopiowano harmonogram. Wklej go do Excela.'); return; }
    if (t.closest('#csv-dl')) { download('harmonogram-kredytu.csv', E.scheduleCsv(E.simulate(S)), 'text/csv;charset=utf-8'); return; }
    if (t.closest('#sim-add')) {
      var amt = num($('#wo').value);
      resetPayForm(); show('pay'); setType('nadplata'); $('#pa').value = amt.toFixed(2); payHint(); $('#pa').focus();
      return;
    }
    if (t.closest('#tg-use')) {
      var r = E.monthlyForTarget(S, $('#tg').value);
      if (r.monthly) { $('#wm').value = r.monthly; $('#wo').value = ''; renderSim(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
      return;
    }
    if (ui.arm && !t.closest('.arm')) disarm();
  });

  $('#seg').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) setType(b.dataset.t); });
  $('#pa').addEventListener('input', payHint);
  $('#pd').addEventListener('change', payHint);
  $('#pf-cancel').addEventListener('click', resetPayForm);

  $('#pf').addEventListener('submit', function (e) {
    e.preventDefault();
    var amount = E.round2(num($('#pa').value)), date = $('#pd').value || today();
    if (!(amount > 0)) { toast('Podaj kwotę większą od zera'); $('#pa').focus(); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { toast('Wybierz poprawną datę'); return; }
    if (amount > S.loan.amount * 2) { toast('Ta kwota jest większa niż dwukrotność kredytu. Sprawdź ją.'); return; }
    var note = $('#pn').value.trim().slice(0, 80);
    var wasType = ui.ptype;
    if (ui.editId) {
      S.payments = S.payments.map(function (p) { return p.id === ui.editId ? Object.assign({}, p, { date: date, amount: amount, type: ui.ptype, note: note }) : p; });
      toast('Zmiany zapisane');
    } else {
      S.payments.push({ id: uid(), date: date, amount: amount, type: ui.ptype, note: note, ts: Date.now() });
      toast(wasType === 'rata' ? 'Rata zapisana' : 'Nadpłata zapisana. Wczytaj nowy harmonogram, gdy go dostaniesz.');
    }
    save(); resetPayForm(); render();
  });

  $('#mode').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) { ui.mode = b.dataset.m; paintMode(); } });
  ['#sa', '#sr', '#sk', '#sf1'].forEach(function (s) { $(s).addEventListener('input', estHint); });
  $('#sf').addEventListener('submit', saveSettings);

  $('#impbtn').addEventListener('click', function () {
    var rows = E.parseBankSchedule($('#imp').value);
    if (!rows.length) return toast('Nie rozpoznałem harmonogramu. Wklej całą tabelę z PDF-a.');
    var merged = E.mergeBankSchedule(S, rows, Date.now());
    if (!merged) return toast('Harmonogram musi kończyć się saldem 0 zł. Wklej całą tabelę.');
    S.bankSchedule = { rows: merged.rows, importedAt: merged.importedAt };
    save(); $('#imp').value = ''; render(); toast('Wczytano ' + rat(merged.count) + ' od banku');
  });
  $('#imprst').addEventListener('click', function () {
    if (S.bankSchedule) { S.bankSchedule = null; toast('Wrócono do harmonogramu z umowy'); }
    else { S.baseSchedule = E.contractSchedule(S.loan.start); toast('Przywrócono harmonogram z umowy'); }
    save(); render();
  });

  $('#bk-copy').addEventListener('click', function () { copyText(backupText(), 'Kopia skopiowana. Wklej ją na drugim urządzeniu.', $('#bk-text')); });
  $('#bk-dl').addEventListener('click', function () { download('kredyt-kopia-' + today() + '.json', backupText(), 'application/json'); });
  $('#bk-restore').addEventListener('click', function (e) {
    var txt = $('#bk-text').value.trim();
    if (!txt) return toast('Najpierw wklej kopię albo wczytaj plik');
    if (!armed('restore', e.currentTarget, 'Kliknij ponownie, aby zastąpić obecne dane')) return;
    restoreFrom(txt);
  });
  $('#bk-file').addEventListener('change', function (e) {
    var f = e.target.files && e.target.files[0]; if (!f) return;
    var rd = new FileReader();
    rd.onload = function () { $('#bk-text').value = String(rd.result || ''); toast('Plik wczytany. Kliknij „Przywróć z kopii”.'); };
    rd.readAsText(f);
    e.target.value = '';
  });
  $('#reset').addEventListener('click', function (e) {
    if (!armed('reset', e.currentTarget, 'Kliknij ponownie, aby usunąć wszystko')) return;
    S = defaultState(); save(); resetPayForm(); fillSettings(); render(); toast('Dane usunięte');
  });

  ['#wm', '#wo'].forEach(function (s) { $(s).addEventListener('input', renderSim); });
  $('#tg').addEventListener('change', function () { renderTarget(E.simulate(S)); });

  $('#theme').addEventListener('click', function () {
    var r = document.documentElement;
    var dark = r.dataset.theme === 'dark' || (!r.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    r.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, r.dataset.theme); } catch (e) { /* bez zapisu */ }
    paintTheme();
  });
  if (window.matchMedia) {
    var mq = matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', paintTheme);
  }

  var rz, lastW = window.innerWidth;
  window.addEventListener('resize', function () {
    if (window.innerWidth === lastW) return;
    lastW = window.innerWidth;
    clearTimeout(rz); rz = setTimeout(render, 150);
  });

  // Nowy dzień = nowe odliczanie do raty.
  var dayShown = today();
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && today() !== dayShown) { dayShown = today(); render(); }
  });

  /* ---------- start ---------- */

  try { var th = localStorage.getItem(THEME_KEY); if (th) document.documentElement.dataset.theme = th; } catch (e) { /* bez zapisu */ }
  if (!IS_ARTIFACT) document.documentElement.classList.add('is-standalone');
  save();
  paintTheme();
  resetPayForm();
  var startView = (location.hash || '').replace('#', '');
  show(VIEWS.indexOf(startView) >= 0 ? startView : 'dash');

  if (!IS_ARTIFACT && 'serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () { /* offline niedostępny */ }); });
  }
})();
