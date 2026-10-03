/* Wykresy SVG skalowane do szerokości kontenera, z podpowiedzią po najechaniu lub dotknięciu. */
(function (root) {
  'use strict';

  function niceStep(raw) {
    var p = Math.pow(10, Math.floor(Math.log10(raw || 1))), f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  function shortMoney(v) {
    if (v >= 1000) return (Math.round(v / 100) / 10).toString().replace('.', ',').replace(/,0$/, '') + ' tys.';
    return Math.round(v).toString();
  }

  function frame(el, h) {
    var W = Math.max(280, Math.round(el.clientWidth || 600));
    var H = h || Math.round(Math.min(300, Math.max(210, W * 0.42)));
    return { W: W, H: H };
  }

  function attach(el) {
    if (el._bound) return;
    el._bound = true;
    var move = function (e) {
      var c = el._chart; if (!c) return;
      var svg = el.querySelector('svg'); if (!svg) return;
      var rect = svg.getBoundingClientRect();
      var px = (e.clientX - rect.left) * (c.W / rect.width);
      var i = c.indexAt(px);
      if (i == null) return hide();
      show(i);
    };
    var hide = function () {
      var t = el.querySelector('.tip'), g = el.querySelector('.guide');
      if (t) t.hidden = true;
      if (g) g.setAttribute('opacity', '0');
    };
    var show = function (i) {
      var c = el._chart, html = c.tip(i);
      if (!html) return hide();
      var t = el.querySelector('.tip'), g = el.querySelector('.guide');
      var svg = el.querySelector('svg'), rect = svg.getBoundingClientRect(), k = rect.width / c.W;
      var x = c.xAt(i), y = c.yAt(i);
      t.innerHTML = html; t.hidden = false;
      var tw = t.offsetWidth, left = x * k;
      left = Math.min(Math.max(left, tw / 2 + 4), rect.width - tw / 2 - 4);
      t.style.left = left + 'px';
      t.style.top = Math.max((y * k) - 12, t.offsetHeight + 4) + 'px';
      g.setAttribute('opacity', '1');
      g.setAttribute('transform', 'translate(' + x.toFixed(1) + ',0)');
      var dots = g.querySelectorAll('circle');
      c.dotYs(i).forEach(function (yy, n) {
        if (!dots[n]) return;
        if (yy == null) dots[n].setAttribute('opacity', '0');
        else { dots[n].setAttribute('opacity', '1'); dots[n].setAttribute('cy', yy.toFixed(1)); }
      });
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerdown', move);
    el.addEventListener('pointerleave', hide);
  }

  /**
   * Wykres liniowy. series: [{ data:[y], offset, color, width, dash, area, label }]
   * x to indeks (0..N), xTick(i) zwraca podpis albo null, tip(i) zwraca HTML podpowiedzi.
   */
  function line(el, o) {
    var f = frame(el, o.height), W = f.W, H = f.H, pl = 52, pr = 14, pt = 14, pb = 28;
    var N = Math.max(o.N, 1), yMax = o.yMax || 1;
    var step = niceStep(yMax / 4), top = Math.ceil(yMax / step) * step;
    var X = function (i) { return pl + (W - pl - pr) * i / N; };
    var Y = function (v) { return pt + (H - pt - pb) * (1 - v / top); };
    var s = '';
    for (var v = 0; v <= top + 1e-6; v += step) {
      s += '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + Y(v).toFixed(1) + '" y2="' + Y(v).toFixed(1) + '" stroke="var(--line)" stroke-width="1"/>';
      s += '<text x="' + (pl - 8) + '" y="' + (Y(v) + 4).toFixed(1) + '" text-anchor="end" font-size="11" font-weight="600" fill="var(--mut)">' + shortMoney(v) + '</text>';
    }
    var lastTickX = -1e9;
    for (var i = 0; i <= N; i++) {
      var lab = o.xTick && o.xTick(i);
      if (lab && X(i) - lastTickX > 44) {
        lastTickX = X(i);
        s += '<line x1="' + X(i).toFixed(1) + '" x2="' + X(i).toFixed(1) + '" y1="' + (H - pb) + '" y2="' + (H - pb + 4) + '" stroke="var(--dash)"/>';
        s += '<text x="' + X(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="11" font-weight="600" fill="var(--mut)">' + lab + '</text>';
      }
    }
    (o.series || []).forEach(function (se, n) {
      if (!se.data || !se.data.length) return;
      var off = se.offset || 0;
      var pts = se.data.map(function (y, j) { return X(off + j).toFixed(1) + ',' + Y(y).toFixed(1); }).join(' ');
      if (se.area) {
        var gid = 'g' + Math.random().toString(36).slice(2, 8);
        s += '<defs><linearGradient id="' + gid + '" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="' + se.color + '" stop-opacity=".22"/><stop offset="1" stop-color="' + se.color + '" stop-opacity="0"/></linearGradient></defs>';
        s += '<polygon points="' + X(off).toFixed(1) + ',' + Y(0).toFixed(1) + ' ' + pts + ' ' + X(off + se.data.length - 1).toFixed(1) + ',' + Y(0).toFixed(1) + '" fill="url(#' + gid + ')"/>';
      }
      s += '<polyline points="' + pts + '" fill="none" stroke="' + se.color + '" stroke-width="' + (se.width || 2.5) + '"' +
        (se.dash ? ' stroke-dasharray="' + se.dash + '"' : '') + (se.opacity ? ' opacity="' + se.opacity + '"' : '') +
        ' stroke-linejoin="round" stroke-linecap="round"/>';
    });
    if (o.marker) {
      s += '<circle cx="' + X(o.marker.x).toFixed(1) + '" cy="' + Y(o.marker.y).toFixed(1) + '" r="5.5" fill="' + o.marker.color + '" stroke="var(--card)" stroke-width="2.5"/>';
    }
    var guide = '<g class="guide" opacity="0"><line x1="0" x2="0" y1="' + pt + '" y2="' + (H - pb) + '" stroke="var(--mut)" stroke-width="1" stroke-dasharray="3 3"/>' +
      (o.series || []).map(function (se) { return '<circle r="4.5" cx="0" cy="0" fill="' + se.color + '" stroke="var(--card)" stroke-width="2"/>'; }).join('') + '</g>';
    el.innerHTML = '<div class="chart-wrap"><svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="' + (o.label || 'Wykres') + '">' + s + guide + '</svg><div class="tip" hidden></div></div>' + (o.legend || '');
    var wrap = el.querySelector('.chart-wrap');
    wrap._chart = {
      W: W,
      indexAt: function (px) { if (px < pl - 10 || px > W - pr + 10) return null; return Math.max(0, Math.min(N, Math.round((px - pl) / (W - pl - pr) * N))); },
      xAt: X,
      yAt: function (i) {
        var ys = this.dotYs(i).filter(function (y) { return y != null; });
        return ys.length ? Math.min.apply(null, ys) : Y(0);
      },
      dotYs: function (i) {
        return (o.series || []).map(function (se) {
          var j = i - (se.offset || 0);
          return se.data && j >= 0 && j < se.data.length ? Y(se.data[j]) : null;
        });
      },
      tip: o.tip || function () { return ''; }
    };
    attach(wrap);
  }

  /** Wykres słupkowy skumulowany. items: [{ label, parts:[{v,color}], tip }] */
  function bars(el, o) {
    var items = o.items || [];
    var f = frame(el, o.height || 200), W = f.W, H = f.H, pl = 8, pr = 8, pt = 14, pb = 26;
    var slots = Math.max(items.length, 6), bw = (W - pl - pr) / slots;
    var mx = Math.max.apply(null, items.map(function (it) { return it.parts.reduce(function (a, p) { return a + p.v; }, 0); }).concat([1]));
    var s = '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + (H - pb) + '" y2="' + (H - pb) + '" stroke="var(--line)"/>';
    items.forEach(function (it, i) {
      var x = pl + i * bw + bw * 0.18, w = bw * 0.64, y = H - pb;
      it.parts.forEach(function (p) {
        var h = p.v / mx * (H - pt - pb);
        if (h <= 0) return;
        y -= h;
        s += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + Math.max(h - 1, 1).toFixed(1) + '" rx="4" fill="' + p.color + '"/>';
      });
      s += '<text x="' + (x + w / 2).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="11" font-weight="600" fill="var(--mut)">' + it.label + '</text>';
    });
    var guide = '<g class="guide" opacity="0"><rect x="' + (-bw / 2).toFixed(1) + '" y="' + pt + '" width="' + bw.toFixed(1) + '" height="' + (H - pt - pb) + '" rx="8" fill="var(--mut)" opacity=".08"/></g>';
    el.innerHTML = '<div class="chart-wrap"><svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="' + (o.label || 'Wykres słupkowy') + '">' + guide + s + '</svg><div class="tip" hidden></div></div>' + (o.legend || '');
    var wrap = el.querySelector('.chart-wrap');
    wrap._chart = {
      W: W,
      indexAt: function (px) { var i = Math.floor((px - pl) / bw); return i >= 0 && i < items.length ? i : null; },
      xAt: function (i) { return pl + i * bw + bw / 2; },
      yAt: function (i) { var t = items[i].parts.reduce(function (a, p) { return a + p.v; }, 0); return H - pb - t / mx * (H - pt - pb); },
      dotYs: function () { return []; },
      tip: function (i) { return items[i] && items[i].tip; }
    };
    attach(wrap);
  }

  root.KredytCharts = { line: line, bars: bars };
})(typeof window !== 'undefined' ? window : globalThis);
