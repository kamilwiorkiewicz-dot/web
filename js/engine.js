/* Silnik obliczeń kredytu: harmonogram, wpłaty, prognoza, symulacje nadpłat.
 * Czyste funkcje bez DOM, testowane w tests/engine.test.js. */
(function (root) {
  'use strict';

  var Data = root.KredytData || (typeof require === 'function' ? require('./data.js') : null);
  var EPS = 0.005;

  /* ---------- daty ---------- */

  function pad(n) { return String(n).padStart(2, '0'); }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parse(s) { var p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }

  // Dodaje miesiące, przycinając dzień do końca miesiąca (31.01 + 1 = 28/29.02).
  function addMonths(s, k) {
    var p = s.split('-').map(Number);
    var dim = new Date(p[0], p[1] - 1 + k + 1, 0).getDate();
    return iso(new Date(p[0], p[1] - 1 + k, Math.min(p[2], dim)));
  }

  function daysBetween(a, b) { return Math.round((parse(b) - parse(a)) / 864e5); }

  function monthsBetween(a, b) {
    var x = parse(a), y = parse(b);
    return (y.getFullYear() - x.getFullYear()) * 12 + y.getMonth() - x.getMonth();
  }

  /* ---------- raty ---------- */

  function pmt(P, r, n) {
    if (n <= 0) return P;
    return r ? P * r / (1 - Math.pow(1 + r, -n)) : P / n;
  }

  function monthlyRate(loan) { return (+loan.rate || 0) / 1200; }

  // Wysokość zwykłej raty: z umowy albo wyliczona (z uwzględnieniem większej pierwszej raty).
  function regularInstallment(loan) {
    var r = monthlyRate(loan);
    if (loan.inst > 0) return loan.inst;
    if (loan.first > 0 && loan.n > 1) return pmt(Math.max(loan.amount * (1 + r) - loan.first, 0), r, loan.n - 1);
    return pmt(loan.amount, r, loan.n);
  }

  function firstInstallment(loan) { return loan.first > 0 ? loan.first : regularInstallment(loan); }

  /* ---------- harmonogramy ---------- */

  // Harmonogram z umowy wbudowany w aplikację.
  function contractSchedule(start) {
    var rows = [], prev = Data.DEFAULT_LOAN.amount;
    for (var i = 0; i < Data.BAL.length; i++) {
      rows.push({
        date: i === Data.BAL.length - 1 ? Data.LAST_DATE : addMonths(start || Data.DEFAULT_LOAN.start, i),
        pay: round2(prev - Data.BAL[i] + Data.INT[i]),
        int: Data.INT[i],
        bal: Data.BAL[i]
      });
      prev = Data.BAL[i];
    }
    return rows;
  }

  // Harmonogram wyliczony z parametrów (rata stała, odsetki = saldo × stopa / 12).
  function generatedSchedule(loan) {
    var r = monthlyRate(loan), inst = regularInstallment(loan), first = firstInstallment(loan);
    var rows = [], bal = +loan.amount || 0, n = Math.max(1, Math.round(loan.n) || 1);
    for (var k = 0; bal > EPS && k < 600; k++) {
      var i = bal * r, pay = k === 0 ? first : inst;
      if (k >= n - 1 || pay >= bal + i - EPS) pay = bal + i;
      if (pay <= i) break;
      bal = bal + i - pay;
      rows.push({ date: addMonths(loan.start, k), pay: pay, int: i, bal: Math.max(bal, 0) });
    }
    return rows;
  }

  // Pierwotny plan: harmonogram z umowy albo wyliczony.
  function planSchedule(state) {
    return state.baseSchedule && state.baseSchedule.length ? state.baseSchedule : generatedSchedule(state.loan);
  }

  // Harmonogram, według którego liczymy przyszłość: najnowszy od banku albo plan.
  function refSchedule(state) {
    return state.bankSchedule && state.bankSchedule.rows && state.bankSchedule.rows.length
      ? state.bankSchedule.rows : planSchedule(state);
  }

  function sortPayments(list) {
    return list.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      if (a.type !== b.type) return a.type === 'rata' ? -1 : 1;
      return (a.ts || 0) - (b.ts || 0);
    });
  }

  /* ---------- symulacja ---------- */

  /**
   * Przelicza kredyt na podstawie wpłat i prognozuje resztę.
   * Odsetki raty k: odsetki z harmonogramu przeskalowane do faktycznego salda.
   * Bez nadpłat daje to dokładnie kwoty z banku, po nadpłacie dobre przybliżenie.
   * opt: { exclude: Set(id), noOverpayments, extraMonthly, extraOnce }
   */
  function simulate(state, opt) {
    opt = opt || {};
    var L = state.loan, r = monthlyRate(L), reduce = L.mode === 'reduce';
    var plan = planSchedule(state), ref = refSchedule(state), nPlan = plan.length;
    var baseInst = regularInstallment(L);
    var importedAt = state.bankSchedule ? state.bankSchedule.importedAt || 0 : -1;

    function intFor(j, b) {
      var row = ref[j];
      if (row) {
        var before = row.bal + row.pay - row.int;
        return before > EPS ? row.int * b / before : 0;
      }
      return b * r;
    }
    function dateFor(j) {
      if (ref[j]) return ref[j].date;
      if (plan[j]) return plan[j].date;
      var lastRow = ref[ref.length - 1];
      return lastRow ? addMonths(lastRow.date, j - ref.length + 1) : addMonths(L.start, j);
    }

    var pays = sortPayments((state.payments || []).filter(function (p) {
      if (opt.exclude && opt.exclude.has(p.id)) return false;
      if (opt.noOverpayments && p.type === 'nadplata') return false;
      return p.amount > 0;
    }));

    var bal = +L.amount || 0, k = 0, paidInt = 0, paidPrin = 0, over = 0, paid = 0, inst = null;
    var act = [bal], history = [], lastDate = null;

    pays.forEach(function (p) {
      var before = bal;
      paid += p.amount;
      lastDate = p.date;
      if (p.type === 'rata') {
        var i = intFor(k, bal);
        bal = Math.max(bal + i - p.amount, 0);
        paidInt += i;
        paidPrin += before - bal;
        k++;
        act.push(bal);
        history.push({ id: p.id, type: 'rata', date: p.date, amount: p.amount, int: i, principal: before - bal, bal: bal, no: k });
      } else {
        bal = Math.max(bal - p.amount, 0);
        over += p.amount;
        paidPrin += before - bal;
        act[act.length - 1] = bal;
        history.push({ id: p.id, type: 'nadplata', date: p.date, amount: p.amount, int: 0, principal: before - bal, bal: bal, no: null });
        if (reduce && (p.ts || 0) > importedAt) inst = pmt(bal, r, Math.max(nPlan - k, 1));
      }
    });

    // Jednorazowe nadpłaty w prognozie: after = liczba rat od dziś, po których wpłacamy.
    var lumps = (opt.lumps || []).slice();
    if (opt.extraOnce > 0) lumps.push({ after: 0, amount: opt.extraOnce });
    var proj = [], b = bal, j = k, futInt = 0, extraPaid = 0, stalled = false;
    function applyLumps(n) {
      lumps.forEach(function (l) {
        if (l.after !== n || !(l.amount > 0) || b <= EPS) return;
        var x = Math.min(l.amount, b);
        b -= x; extraPaid += x;
        if (reduce) inst = pmt(b, r, Math.max(nPlan - j, 1));
      });
    }
    applyLumps(0);
    while (b > EPS && proj.length < 600) {
      var i2 = intFor(j, b);
      var pay = inst != null ? inst : ref[j] ? ref[j].pay : baseInst;
      var last = reduce && j >= nPlan - 1;
      if (last || pay >= b + i2 - EPS) pay = b + i2;
      if (pay <= i2) { stalled = true; break; }
      b = Math.max(b + i2 - pay, 0);
      futInt += i2;
      var extra = 0;
      if (opt.extraMonthly > 0 && b > EPS) {
        extra = Math.min(opt.extraMonthly, b);
        b -= extra; extraPaid += extra;
        if (reduce) inst = pmt(b, r, Math.max(nPlan - j - 1, 1));
      }
      j++;
      var before2 = b;
      applyLumps(proj.length + 1);
      extra += before2 - b;
      proj.push({ no: j, date: dateFor(j - 1), pay: pay, int: i2, principal: pay - i2, extra: extra, bal: b });
    }

    var planInt = plan.reduce(function (s, x) { return s + x.int; }, 0);
    return {
      plan: plan, ref: ref, dateFor: dateFor,
      bal: bal, k: k, paid: paid, paidInt: paidInt, paidPrin: paidPrin, over: over,
      act: act, history: history, proj: proj, futInt: futInt, extraPaid: extraPaid, stalled: stalled,
      totalInt: paidInt + futInt,
      count: k + proj.length,
      end: proj.length ? proj[proj.length - 1].date : (lastDate || L.start),
      next: proj[0] || null,
      planInt: planInt, planCount: nPlan,
      planEnd: nPlan ? plan[nPlan - 1].date : L.start
    };
  }

  /* ---------- analiza dla panelu ---------- */

  function analyze(state, today) {
    var L = state.loan, m = simulate(state);
    var base = m.over > 0 ? simulate(state, { noOverpayments: true }) : m;
    var due = 0;
    for (var j = 0; j < Math.max(m.count, m.planCount); j++) {
      if (m.dateFor(j) <= today) due++; else break;
    }
    due = Math.min(due, m.count);
    var importedAt = state.bankSchedule ? state.bankSchedule.importedAt || 0 : -1;
    var pending = (state.payments || []).some(function (p) { return p.type === 'nadplata' && (p.ts || 0) > importedAt; });
    var ym = today.slice(0, 7), month = { rata: 0, nadplata: 0 }, months = {};
    (state.payments || []).forEach(function (p) {
      var key = p.date.slice(0, 7);
      months[key] = (months[key] || 0) + p.amount;
      if (key === ym) month[p.type] += p.amount;
    });
    var monthCount = Object.keys(months).length;
    var biggest = (state.payments || []).reduce(function (s, p) { return Math.max(s, p.amount); }, 0);
    return Object.assign(m, {
      today: today,
      saved: Math.max(base.totalInt - m.totalInt, 0),
      monthsSaved: Math.max(base.count - m.count, 0),
      baseEnd: base.end,
      baseCount: base.count,
      due: due,
      ahead: m.k - due,
      pending: pending && m.over > 0,
      finished: m.bal <= EPS && m.k > 0,
      pct: L.amount > 0 ? Math.min(100, Math.max(0, (L.amount - m.bal) / L.amount * 100)) : 0,
      daysToNext: m.next ? daysBetween(today, m.next.date) : null,
      month: month,
      monthTotal: month.rata + month.nadplata,
      avgMonthly: monthCount ? m.paid / monthCount : 0,
      biggest: biggest,
      cost: L.amount + m.totalInt,
      firstInst: firstInstallment(L),
      inst: regularInstallment(L)
    });
  }

  // Ile odsetek oszczędza konkretna nadpłata (porównanie z sytuacją bez niej).
  function overpaymentEffect(state, id, current) {
    current = current || simulate(state);
    var without = simulate(state, { exclude: new Set([id]) });
    return { interest: Math.max(without.totalInt - current.totalInt, 0), months: Math.max(without.count - current.count, 0) };
  }

  /* ---------- symulator ---------- */

  function whatIf(state, monthly, once) {
    var now = simulate(state);
    var sim = simulate(state, { extraMonthly: +monthly || 0, extraOnce: +once || 0 });
    return {
      now: now, sim: sim,
      interestSaved: Math.max(now.futInt - sim.futInt, 0),
      monthsSaved: Math.max(now.proj.length - sim.proj.length, 0),
      extraPaid: sim.extraPaid,
      newInst: sim.proj.length ? sim.proj[Math.min(1, sim.proj.length - 1)].pay : 0
    };
  }

  // Minimalna miesięczna nadpłata, żeby ostatnia rata wypadła najpóźniej w danym miesiącu (RRRR-MM).
  function monthlyForTarget(state, targetYm) {
    var now = simulate(state);
    if (!now.proj.length) return { monthly: 0, reachable: true, sim: now };
    if (now.end.slice(0, 7) <= targetYm) return { monthly: 0, reachable: true, sim: now };
    if (now.proj[0].date.slice(0, 7) > targetYm) return { monthly: null, reachable: false, sim: now };
    var lo = 0, hi = now.bal;
    var test = simulate(state, { extraMonthly: hi });
    if (test.end.slice(0, 7) > targetYm) return { monthly: null, reachable: false, sim: test };
    for (var it = 0; it < 40; it++) {
      var mid = (lo + hi) / 2;
      if (simulate(state, { extraMonthly: mid }).end.slice(0, 7) <= targetYm) hi = mid; else lo = mid;
    }
    var monthly = Math.ceil(hi);
    return { monthly: monthly, reachable: true, sim: simulate(state, { extraMonthly: monthly }) };
  }

  /* ---------- import harmonogramu z banku ---------- */

  var NUM = '(\\d{1,3}(?:[ \\u00a0]\\d{3})+[,.]\\d{2}|\\d+[,.]\\d{2})';
  var ROW_RE = new RegExp('(\\d{2})[-./](\\d{2})[-./](\\d{4})\\s+' + [NUM, NUM, NUM, NUM, NUM].join('\\s+'), 'g');
  function num(s) { return parseFloat(s.replace(/[  ]/g, '').replace(',', '.')); }

  // Format Santandera: data, saldo po racie, kapitał, odsetki, inne, rata.
  function parseBankSchedule(text) {
    var rows = [], m;
    ROW_RE.lastIndex = 0;
    while ((m = ROW_RE.exec(text || ''))) {
      rows.push({ date: m[3] + '-' + m[2] + '-' + m[1], bal: num(m[4]), int: num(m[6]), pay: num(m[8]) });
    }
    return rows;
  }

  // Wkleja nowy harmonogram od banku od pierwszej niezapłaconej raty.
  function mergeBankSchedule(state, rows, now) {
    var k = (state.payments || []).filter(function (p) { return p.type === 'rata'; }).length;
    var ref = refSchedule(state);
    var cut = addMonths(ref[k] ? ref[k].date : addMonths(state.loan.start, k), 0);
    var cutDate = parse(cut); cutDate.setDate(cutDate.getDate() - 10);
    var cutIso = iso(cutDate);
    var future = rows.filter(function (x) { return x.date >= cutIso; });
    if (!future.length || future[future.length - 1].bal > 1) return null;
    return { rows: ref.slice(0, k).concat(future), importedAt: now || Date.now(), count: future.length };
  }

  /* ---------- eksport ---------- */

  function csvNum(x) { return round2(x).toFixed(2).replace('.', ','); }

  function scheduleCsv(sim) {
    var lines = ['Typ;Nr;Data;Kwota;Kapitał;Odsetki;Saldo po'];
    sim.history.forEach(function (h) {
      lines.push([h.type === 'rata' ? 'Rata (zapłacona)' : 'Nadpłata', h.no || '', h.date, csvNum(h.amount), csvNum(h.principal), csvNum(h.int), csvNum(h.bal)].join(';'));
    });
    sim.proj.forEach(function (p) {
      lines.push(['Rata (prognoza)', p.no, p.date, csvNum(p.pay), csvNum(p.principal), csvNum(p.int), csvNum(p.bal + (p.extra || 0))].join(';'));
    });
    return '﻿' + lines.join('\r\n');
  }

  function round2(x) { return Math.round((x + Number.EPSILON) * 100) / 100; }

  var api = {
    iso: iso, parse: parse, addMonths: addMonths, daysBetween: daysBetween, monthsBetween: monthsBetween,
    pmt: pmt, regularInstallment: regularInstallment, firstInstallment: firstInstallment,
    contractSchedule: contractSchedule, generatedSchedule: generatedSchedule,
    planSchedule: planSchedule, refSchedule: refSchedule, sortPayments: sortPayments,
    simulate: simulate, analyze: analyze, overpaymentEffect: overpaymentEffect,
    whatIf: whatIf, monthlyForTarget: monthlyForTarget,
    parseBankSchedule: parseBankSchedule, mergeBankSchedule: mergeBankSchedule,
    scheduleCsv: scheduleCsv, round2: round2
  };
  root.KredytEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
