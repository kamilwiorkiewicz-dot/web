'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Data = require('../js/data.js');
const E = require('../js/engine.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} ≈ ${b} (±${tol})`);

function state(extra) {
  return Object.assign({
    loan: Object.assign({}, Data.DEFAULT_LOAN),
    baseSchedule: E.contractSchedule(Data.DEFAULT_LOAN.start),
    bankSchedule: null,
    payments: []
  }, extra || {});
}
let seq = 0;
const pay = (type, date, amount, ts) => ({ id: 'p' + (++seq), type, date, amount, ts: ts || seq });

test('daty: dodawanie miesięcy przycina koniec miesiąca', () => {
  assert.equal(E.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(E.addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(E.addMonths('2026-10-15', 3), '2027-01-15');
  assert.equal(E.addMonths('2026-12-31', -1), '2026-11-30');
});

test('harmonogram z umowy: pierwsza 1759,53 zł, potem 1673,47 zł, 60 rat', () => {
  const s = E.contractSchedule('2026-10-15');
  assert.equal(s.length, 60);
  assert.equal(s[0].pay, 1759.53);
  assert.equal(s[1].pay, 1673.47);
  assert.equal(s[0].date, '2026-10-15');
  assert.equal(s[59].date, '2031-09-08');
  assert.equal(s[59].bal, 0);
});

test('bez wpłat prognoza odtwarza harmonogram banku co do grosza', () => {
  const st = state();
  const m = E.simulate(st);
  assert.equal(m.count, 60);
  assert.equal(m.proj.length, 60);
  near(m.futInt, Data.INT.reduce((a, b) => a + b, 0), 0.01, 'suma odsetek');
  near(m.proj[0].pay, 1759.53, 0.001);
  near(m.proj[0].int, 454.90, 0.001);
  near(m.proj[10].bal, Data.BAL[10], 0.001);
  assert.equal(m.end, '2031-09-08');
});

test('zapłacone raty zgodne z harmonogramem zmniejszają saldo jak w banku', () => {
  const st = state({ payments: [pay('rata', '2026-10-15', 1759.53), pay('rata', '2026-11-15', 1673.47)] });
  const m = E.simulate(st);
  assert.equal(m.k, 2);
  near(m.bal, Data.BAL[1], 0.001);
  near(m.paidInt, 454.90 + 363.42, 0.001);
  assert.equal(m.count, 60);
});

test('nadpłata 800 zł przed pierwszą ratą oszczędza ok. 220 zł odsetek', () => {
  const st = state({ payments: [pay('nadplata', '2026-10-05', 800), pay('rata', '2026-10-15', 1759.53)] });
  const a = E.analyze(st, '2026-10-20');
  near(a.saved, 220, 25, 'oszczędność');
  assert.ok(a.monthsSaved >= 0 && a.monthsSaved <= 1);
  assert.equal(a.pending, true);
  const eff = E.overpaymentEffect(st, st.payments[0].id);
  near(eff.interest, a.saved, 0.01);
});

test('symulator: 200 zł miesięcznie skraca kredyt o ok. 8 miesięcy', () => {
  const st = state({ payments: [pay('rata', '2026-10-15', 1759.53)] });
  const w = E.whatIf(st, 200, 0);
  assert.ok(w.monthsSaved >= 7 && w.monthsSaved <= 9, 'miesiące: ' + w.monthsSaved);
  near(w.interestSaved, 1380, 150, 'odsetki');
});

test('symulator: 10 000 zł jednorazowo teraz skraca o ok. 8 miesięcy', () => {
  const st = state({ payments: [pay('rata', '2026-10-15', 1759.53)] });
  const w = E.whatIf(st, 0, 10000);
  assert.ok(w.monthsSaved >= 7 && w.monthsSaved <= 9, 'miesiące: ' + w.monthsSaved);
  near(w.interestSaved, 2600, 250, 'odsetki');
});

test('tryb obniżenia raty: okres zostaje, rata spada', () => {
  const st = state({ payments: [pay('rata', '2026-10-15', 1759.53), pay('nadplata', '2026-10-20', 10000)] });
  st.loan.mode = 'reduce';
  const m = E.simulate(st);
  assert.equal(m.count, 60);
  assert.ok(m.proj[0].pay < 1673.47 - 150, 'nowa rata ' + m.proj[0].pay);
  near(m.proj[m.proj.length - 1].bal, 0, 0.01);
});

test('cel: spłata do daty wymaga dodatniej nadpłaty i ją osiąga', () => {
  const st = state();
  const r = E.monthlyForTarget(st, '2029-12');
  assert.ok(r.reachable);
  assert.ok(r.monthly > 0);
  assert.ok(r.sim.end.slice(0, 7) <= '2029-12');
  const less = E.simulate(st, { extraMonthly: r.monthly - 5 });
  assert.ok(less.end.slice(0, 7) > '2029-12', 'kwota jest minimalna');
});

test('wyliczony harmonogram bez umowy i z większą pierwszą ratą kończy się po n ratach', () => {
  const loan = { amount: 60000, rate: 8.5, n: 60, inst: 0, first: 5000, start: '2026-01-10', mode: 'shorten' };
  const s = E.generatedSchedule(loan);
  assert.equal(s.length, 60);
  assert.equal(s[0].pay, 5000);
  near(s[59].bal, 0, 0.001);
  near(s[1].pay, s[30].pay, 0.001);
});

test('import harmonogramu z banku: tekst z PDF', () => {
  const text = `Data Saldo Kapitał Odsetki Inne Rata
15-12-2026 75000,00 1300,00 300,50 0,00 1600,50
15-01-2027 73 699,50 1 300,50 300,00 0,00 1 600,50
15-02-2027 0,00 73699,50 299,00 0,00 73998,50`;
  const rows = E.parseBankSchedule(text);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], { date: '2027-01-15', bal: 73699.5, int: 300, pay: 1600.5 });
  const st = state({ payments: [pay('rata', '2026-10-15', 1759.53), pay('rata', '2026-11-15', 1673.47), pay('nadplata', '2026-11-20', 9785.32, 100)] });
  const merged = E.mergeBankSchedule(st, rows, 200);
  assert.equal(merged.count, 3);
  assert.equal(merged.rows.length, 5);
  st.bankSchedule = merged;
  const a = E.analyze(st, '2026-11-25');
  assert.equal(a.pending, false);
  assert.equal(a.count, 5);
});

test('eksport CSV ma nagłówek i polskie liczby', () => {
  const st = state({ payments: [pay('rata', '2026-10-15', 1759.53)] });
  const csv = E.scheduleCsv(E.simulate(st));
  const lines = csv.split('\r\n');
  assert.match(lines[0], /Typ;Nr;Data/);
  assert.match(lines[1], /^Rata \(zapłacona\);1;2026-10-15;1759,53;/);
  assert.equal(lines.length, 61);
});

test('nadpłata jednorazowa: im wcześniej, tym większa oszczędność', () => {
  const st = state();
  const now = E.simulate(st);
  const save = after => now.futInt - E.simulate(st, { lumps: [{ after, amount: 10000 }] }).futInt;
  const s0 = save(0), s12 = save(12), s24 = save(24), s48 = save(48);
  assert.ok(s0 > s12 && s12 > s24 && s24 > s48, [s0, s12, s24, s48].join(' > '));
  near(s0, E.whatIf(st, 0, 10000).interestSaved, 0.001);
});
