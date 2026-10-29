// Unit tests for host/web/wave_core.js (ring buffer, min/max pyramid, time axis, binary frames, M4 renderer).
// Usage: node TESTs/test_wave_core.js [path/to/app.js]   (app.js argument is ignored; run_all passes it)
const path = require('path');
const WC = require(path.join(__dirname, '..', 'host', 'web', 'wave_core.js'));

let pass = 0, fail = 0;
const check = (n, c, i = '') => { if (c) { pass++; console.log('PASS ', n); } else { fail++; console.log('FAIL ', n, i); } };

// deterministic PRNG
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

function bruteMinMax(store, c, a, b) {
  a = Math.max(Math.floor(a), store.oldest); b = Math.min(Math.ceil(b), store.head);
  let mn = Infinity, mx = -Infinity;
  for (let i = a; i < b; i++) { const v = store.get(c, i); if (Number.isFinite(v)) { mn = Math.min(mn, v); mx = Math.max(mx, v); } }
  return [mn === Infinity ? NaN : mn, mx === -Infinity ? NaN : mx];
}
const same = (x, y) => (Number.isNaN(x) && Number.isNaN(y)) || x === y;

// ---------------------------------------------------------------- 1. ring buffer basics
{
  const s = new WC.WaveStore(2, 1024);
  check('store: min capacity enforced', s.cap === 1024);
  s.pushInterleaved([1, 2, 3, 4, 5, 6], 3, 2);
  check('store: head/count', s.head === 3 && s.count === 3 && s.oldest === 0);
  check('store: values', s.get(0, 0) === 1 && s.get(1, 2) === 6);
  s.pushInterleaved([7, null], 1, 2);
  check('store: null -> NaN', Number.isNaN(s.get(1, 3)));
  s.pushInterleaved([8], 1, 1);
  check('store: missing channel padded with NaN', s.get(0, 4) === 8 && Number.isNaN(s.get(1, 4)));
  s.pushInterleaved([9, 10, 11], 1, 3);
  check('store: extra channel dropped', s.get(0, 5) === 9 && s.get(1, 5) === 10);
  const big = new Float32Array(3000 * 2); for (let k = 0; k < 3000; k++) { big[2 * k] = k; big[2 * k + 1] = -k; }
  s.pushInterleaved(big, 3000, 2);
  check('store: eviction keeps newest cap samples', s.count === 1024 && s.oldest === s.head - 1024 && s.get(0, s.head - 1) === 2999);
  check('store: valueAt out of range -> NaN', Number.isNaN(s.valueAt(0, s.oldest - 1)) && Number.isNaN(s.valueAt(0, s.head)));
  check('store: valueAt rounds', s.valueAt(0, s.head - 1.4) === 2999);
  s.clear();
  check('store: clear keeps index monotonic', s.count === 0 && s.oldest === s.head && s.head > 0);
  s.pushInterleaved([1, 1], 1, 2);
  check('store: push after clear', s.count === 1 && s.get(0, s.head - 1) === 1);
  check('store: bytes estimate', Math.abs(s.bytes() - 1024 * 2 * 4 * WC.MEM_FACTOR) < 1);
}

// ---------------------------------------------------------------- 2. pyramid vs brute force (wrap, NaN, Inf, clear)
{
  const s = new WC.WaveStore(3, 50000);
  const N = 180000;   // > 3 wraps
  const buf = new Float32Array(N * 3);
  for (let k = 0; k < N; k++) {
    buf[3 * k] = Math.sin(k / 50) * 100 + (rnd() < 0.001 ? 900 : 0);         // rare spikes
    buf[3 * k + 1] = rnd() < 0.02 ? NaN : rnd() * 10 - 5;                    // NaN holes
    buf[3 * k + 2] = (k % 70000) < 9000 ? NaN : (rnd() < 0.0005 ? Infinity : k);  // long NaN runs + Inf
  }
  // feed in irregular chunks
  let off = 0;
  while (off < N) { const n = Math.min(N - off, 1 + Math.floor(rnd() * 900)); s.pushInterleaved(buf.subarray(off * 3, (off + n) * 3), n, 3); off += n; }
  let bad = 0, cases = 0;
  for (let t = 0; t < 3000; t++) {
    const a = s.oldest + Math.floor(rnd() * s.count);
    const len = Math.floor(Math.pow(rnd(), 2) * (s.head - a)) + (rnd() < 0.1 ? 0 : 1);
    for (let c = 0; c < 3; c++) {
      const r = s.rangeMinMax(c, a, a + len), e = bruteMinMax(s, c, a, a + len);
      cases++;
      if (!same(r[0], e[0]) || !same(r[1], e[1])) { if (bad++ < 3) console.log('   mismatch', c, a, len, r, e); }
    }
  }
  check(`pyramid: rangeMinMax == brute force (${cases} random ranges, wrapped, NaN/Inf)`, bad === 0, bad);
  const full = s.rangeMinMax(0, -1e9, 1e12), ef = bruteMinMax(s, 0, s.oldest, s.head);
  check('pyramid: range clamped to valid data', same(full[0], ef[0]) && same(full[1], ef[1]));
  check('pyramid: all-NaN range -> [NaN, NaN]', (() => { const r = s.rangeMinMax(2, 140000, 140000 + 5000); return Number.isNaN(r[0]) && Number.isNaN(r[1]); })());

  // after clear, old data must never leak into ranges
  s.clear();
  const tail = new Float32Array(5000 * 3).fill(1);
  s.pushInterleaved(tail, 5000, 3);
  const r = s.rangeMinMax(0, s.oldest, s.head);
  check('pyramid: no stale data after clear', r[0] === 1 && r[1] === 1, r);

  // resize keeps newest data and pyramid consistency
  const s2 = new WC.WaveStore(1, 20000);
  for (let k = 0; k < 30000; k++) s2.pushInterleaved([Math.cos(k / 7) * (k % 1000)], 1, 1);
  const before = s2.slice(0, s2.head - 5000, s2.head);
  s2.resize(8000);
  const after = s2.slice(0, s2.head - 5000, s2.head);
  check('resize: newest samples preserved, head unchanged', s2.head === 30000 && s2.count === 8000 && before.every((v, i) => v === after[i]));
  let bad2 = 0;
  for (let t = 0; t < 500; t++) {
    const a = s2.oldest + Math.floor(rnd() * s2.count), b = a + Math.floor(rnd() * (s2.head - a));
    const x = s2.rangeMinMax(0, a, b), y = bruteMinMax(s2, 0, a, b);
    if (!same(x[0], y[0]) || !same(x[1], y[1])) bad2++;
  }
  check('resize: pyramid rebuilt correctly', bad2 === 0, bad2);
  s2.resize(60000);
  check('resize: grow keeps all data', s2.count === 8000 && s2.cap === 60000);
}

// ---------------------------------------------------------------- 3. M4 column statistics
{
  const s = new WC.WaveStore(1, 400000);
  const N = 300000;
  const b = new Float32Array(N);
  for (let k = 0; k < N; k++) b[k] = Math.sin(k / 300) + (k === 123457 ? 50 : 0) + (k % 50000 < 100 ? NaN : 0);
  s.pushInterleaved(b, N, 1);
  // raw path (spp < 32): exact per column
  {
    const cols = 500, s0 = 1000.3, s1 = 1000.3 + 500 * 7.5;
    const cb = WC.columnStats(s, 0, s0, s1, cols, WC.makeColumnBuffers(cols));
    let bad = 0;
    for (let px = 0; px < cols; px++) {
      const a = Math.floor(s0 + px * 7.5), e = bruteMinMax(s, 0, a, Math.floor(s0 + (px + 1) * 7.5));
      if (!same(cb.min[px], e[0]) || !same(cb.max[px], e[1])) bad++;
    }
    check('M4 raw path: per-column min/max exact', bad === 0, bad);
  }
  // pyramid path: columns aligned to bucket boundaries -> exact vs brute force over aligned range
  {
    const cols = 1000, s0 = 0, s1 = N, spp = (s1 - s0) / cols;
    const cb = WC.columnStats(s, 0, s0, s1, cols, WC.makeColumnBuffers(cols));
    const bs = [...s.levels].reverse().find(l => l.bs * 2 <= spp).bs;
    let bad = 0;
    for (let px = 0; px < cols; px++) {
      const a = Math.floor(Math.floor(s0 + px * spp) / bs) * bs, z = Math.floor(Math.floor(s0 + (px + 1) * spp) / bs) * bs;
      const e = bruteMinMax(s, 0, a, z);
      if (!same(cb.min[px], e[0]) || !same(cb.max[px], e[1])) bad++;
    }
    check(`M4 pyramid path (bs=${bs}, spp=${spp}): per-column exact on aligned ranges`, bad === 0, bad);
    let gmax = -Infinity; for (let px = 0; px < cols; px++) if (cb.max[px] > gmax) gmax = cb.max[px];
    check('M4: single-sample spike preserved at 300 samples/px', Math.abs(gmax - (50 + Math.sin(123457 / 300))) < 1e-4, gmax);
    let nanCols = 0; for (let px = 0; px < cols; px++) if (Number.isNaN(cb.min[px])) nanCols++;
    check('M4: NaN gaps produce empty columns (pen lifted)', nanCols === 0 || nanCols < 10, nanCols);
  }
  // range partly outside valid data (before oldest / after head)
  {
    const cols = 200;
    const cb = WC.columnStats(s, 0, s.head - 1000, s.head + 1000, cols, WC.makeColumnBuffers(cols));
    let after = 0; for (let px = 100; px < cols; px++) if (!Number.isNaN(cb.min[px])) after++;
    check('M4: columns beyond head are empty', after === 0, after);
  }
}

// ---------------------------------------------------------------- 4. time axis
{
  const ax = new WC.TimeAxis(0);
  check('axis: rate unknown -> 1 sample/s fallback', ax.timeOf(10) === 10);
  ax.setRate(0, 250);
  check('axis: first rate applies retroactively', Math.abs(ax.timeOf(500) - 2) < 1e-12);
  ax.setRate(600, 251);      // < 0.5% change: ignored
  check('axis: tiny rate jitter ignored', ax.segs.length === 1);
  ax.setRate(1000, 125);     // wave_div 2 -> 4
  check('axis: new segment on real rate change', ax.segs.length === 2 && Math.abs(ax.timeOf(1000) - 4) < 1e-12 && Math.abs(ax.timeOf(1125) - 5) < 1e-12);
  check('axis: idxAt inverts timeOf across segments', Math.abs(ax.idxAt(ax.timeOf(1300)) - 1300) < 1e-9 && Math.abs(ax.idxAt(ax.timeOf(300)) - 300) < 1e-9);
  check('axis: rateAt', ax.rateAt(10) === 250 && ax.rateAt(5000) === 125);
  ax.prune(1200);
  check('axis: prune drops segments before oldest', ax.segs.length === 1 && ax.segs[0].i0 === 1000 && Math.abs(ax.timeOf(1125) - 5) < 1e-12);
}

// ---------------------------------------------------------------- 5. capacity planning
{
  const p1 = WC.planCapacity(60, 324, 3, 200 * 1024 * 1024);
  check('capacity: 60 s @ 324 fps (measured H723) fits easily', !p1.limited && p1.cap >= 60 * 324 && Math.abs(p1.seconds - 60) < 1e-9, p1);
  const p2 = WC.planCapacity(60, 10000, 8, 200 * 1024 * 1024);
  check('capacity: 60 s @ 10 kHz x 8 ch fits within 200 MB', !p2.limited && WC.WaveStore.bytesFor(p2.cap, 8) < 200 * 1024 * 1024, WC.WaveStore.bytesFor(p2.cap, 8) / 1048576);
  const p3 = WC.planCapacity(300, 100000, 8, 200 * 1024 * 1024);
  check('capacity: 300 s @ 100 kHz x 8 ch is limited by memory', p3.limited && WC.WaveStore.bytesFor(p3.cap, 8) <= 200 * 1024 * 1024 && p3.seconds < 300, p3);
  const p4 = WC.planCapacity(60, 0, 3, 200 * 1024 * 1024);
  check('capacity: unknown rate -> provisional 1 kHz', p4.cap >= 60000);
}

// ---------------------------------------------------------------- 6. ticks / stable axis
{
  check('niceStep', WC.niceStep(10, 5) === 2 && WC.niceStep(1, 4) === 0.25 && WC.niceStep(0.07, 7) === 0.01);
  const r = WC.niceRange(-0.93, 0.97, 4);
  check('niceRange covers data with tidy step', r[0] <= -0.93 && r[1] >= 0.97 && r[2] === 0.5, r);
  const flat = WC.niceRange(1500, 1500, 4);
  check('niceRange: flat signal gets non-zero span', flat[1] > flat[0] && flat[0] < 1500 && flat[1] > 1500, flat);
  const a = WC.stabilizeRange(null, -1, 1);
  const b = WC.stabilizeRange(a, -0.9, 0.95);
  check('stabilizeRange: small change keeps previous range (no jitter)', a === b);
  const c = WC.stabilizeRange(a, -0.1, 0.1);
  check('stabilizeRange: shrinks when data < 30% of range', c !== a && c[1] - c[0] < a[1] - a[0]);
  const d = WC.stabilizeRange(a, -1, 3);
  check('stabilizeRange: grows when data leaves range', d[1] >= 3);
  check('stabilizeRange: NaN keeps previous', WC.stabilizeRange(a, NaN, NaN) === a);
  const z = WC.applyYView([0, 10, 2], 2, 0.25);
  check('applyYView: zoom x2 + pan', Math.abs(z[0] - 5) < 1e-12 && Math.abs(z[1] - 10) < 1e-12);
  check('fmtTime', WC.fmtTime(-0.5, 0.25) === '-0.50s' && WC.fmtTime(12, 2) === '12s' && WC.fmtTime(0.0012, 0.0005) === '1.2ms', [WC.fmtTime(-0.5, 0.25), WC.fmtTime(12, 2), WC.fmtTime(0.0012, 0.0005)]);
  check('fmtNum', WC.fmtNum(0.5, 0.25) === '0.50' && WC.fmtNum(1500, 100) === '1500' && WC.fmtNum(NaN) === 'NaN');
  const ax = new WC.TimeAxis(0); ax.setRate(0, 250);
  const live = WC.timeTicks(ax, 0, 500, 50, 550, true);
  check('timeTicks live: 0 at right edge, negative to the left', live.ticks[0].text === '0' && Math.abs(live.ticks[0].x - 550) < 1e-9 && live.ticks[1].text.startsWith('-'), live.ticks.slice(0, 3));
  const br = WC.timeTicks(ax, 250, 750, 50, 550, false);
  check('timeTicks browse: absolute times inside view', br.ticks.length >= 3 && br.ticks.every(t => t.x >= 49.99 && t.x <= 550.01), br.ticks.map(t => t.text).join(' '));
}

// ---------------------------------------------------------------- 7. binary frames
{
  const rows = [[1, 2, 3], [NaN, Infinity, -1.5], [0.1, 0.2, 0.3]];
  const buf = WC.encodeWaveBinary(rows, 3, 324.5, 1, 7);
  const m = WC.decodeWaveBinary(buf);
  check('binary: header fields', m && m.nch === 3 && m.nframes === 3 && m.decim === 1 && m.resync === 7 && Math.abs(m.fps - 324.5) < 1e-3, m);
  check('binary: NaN / Inf pass through (no JSON null conversion)', Number.isNaN(m.data[3]) && m.data[4] === Infinity && m.data[5] === -1.5);
  check('binary: zero-copy Float32Array view', m.data.buffer === buf && m.data.byteOffset === WC.WAVE_BIN_HEADER);
  check('binary: rejects short / wrong kind / truncated', WC.decodeWaveBinary(new ArrayBuffer(8)) === null
    && WC.decodeWaveBinary((() => { const b = buf.slice(0); new DataView(b).setUint8(0, 9); return b; })()) === null
    && WC.decodeWaveBinary(buf.slice(0, buf.byteLength - 4)) === null);
  const s = new WC.WaveStore(3, 2048);
  s.pushInterleaved(m.data, m.nframes, m.nch);
  check('binary: decoded frame feeds store directly', s.count === 3 && Math.abs(s.get(2, 2) - 0.3) < 1e-6);
}

// ---------------------------------------------------------------- 8. renderer with recording ctx + performance
function mkCtx() {
  const ops = { moveTo: 0, lineTo: 0, stroke: 0, fillText: 0, arc: 0 };
  const ctx = new Proxy({}, {
    get(t, p) {
      if (p === 'measureText') return s => ({ width: String(s).length * 6 });
      if (p in ops) return () => { ops[p]++; };
      return t[p] !== undefined ? t[p] : () => {};
    },
    set(t, p, v) { t[p] = v; return true; }
  });
  return { ctx, ops };
}
{
  const nch = 8, rate = 10000, N = 60 * rate;   // 60 s @ 10 kHz x 8 ch (upper bound scenario)
  const plan = WC.planCapacity(60, rate, nch, 200 * 1024 * 1024);
  const s = new WC.WaveStore(nch, plan.cap);
  const chunk = 250, b = new Float32Array(chunk * nch);
  let t0 = performance.now();
  for (let off = 0; off < N; off += chunk) {
    for (let k = 0; k < chunk; k++) for (let c = 0; c < nch; c++) b[k * nch + c] = Math.sin((off + k) * (c + 1) / 997) * (c + 1);
    s.pushInterleaved(b, chunk, nch);
  }
  const pushMs = performance.now() - t0;
  console.log(`   ingest 600k frames x 8 ch: ${pushMs.toFixed(0)} ms (${(N / pushMs * 1000 / 1e6).toFixed(2)} M frames/s)`);
  check('perf: ingest 10 kHz x 8 ch is >> real time (> 20x)', pushMs < 3000, pushMs);

  const groups = [{ id: 0, chans: [0, 1, 2, 3, 4, 5, 6, 7] }];
  const plots = WC.computeLayout(1200, 260, groups);
  plots[0].ranges = {}; for (let c = 0; c < nch; c++) plots[0].ranges[c] = [-(c + 1), c + 1];
  plots[0].axis = null;
  const { ctx, ops } = mkCtx();
  const frame = { w: 1200, h: 260, plots, store: s, view: { i0: s.oldest, i1: s.head }, colors: ['#fff'], markers: [{ idx: s.head - 1000, text: 'kp 2→4' }], cursors: { a: s.head - 5000, b: s.head - 100 } };
  t0 = performance.now();
  let verts = 0;
  for (let k = 0; k < 20; k++) verts = WC.drawTraces(ctx, frame);
  const drawMs = (performance.now() - t0) / 20;
  const cols = Math.ceil(plots[0].x1 - plots[0].x0);
  console.log(`   drawTraces full 60 s view (600k samples x 8 ch, ${cols} px): ${drawMs.toFixed(2)} ms/frame, ${verts} vertices`);
  check('M4: vertices bounded by 4 x columns x channels (independent of data size)', verts <= 4 * cols * nch, verts);
  check('perf: full-history frame < 25 ms (node, no rasterization)', drawMs < 25, drawMs);

  // 2 s live window -> raw path still bounded
  frame.view = { i0: s.head - 2 * rate, i1: s.head };
  verts = WC.drawTraces(ctx, frame);
  check('M4: 2 s window (20k samples) bounded too', verts <= 4 * cols * nch, verts);
  // zoomed in to ~40 samples -> raw polyline + sample dots
  ops.arc = 0;
  frame.view = { i0: s.head - 40, i1: s.head };
  WC.drawTraces(ctx, frame);
  check('zoomed in: individual sample dots drawn', ops.arc > 0, ops.arc);

  // grid / overlay / overview do not throw and draw labels
  plots[0].axis = [-1, 1, 0.5];
  ops.fillText = 0;
  const tt = WC.timeTicks((() => { const a = new WC.TimeAxis(0); a.setRate(0, rate); return a; })(), s.head - 20000, s.head, plots[0].x0, plots[0].x1, true);
  WC.drawGrid(ctx, { w: 1200, h: 260, plots, xTicks: tt.ticks });
  check('grid: axis + time labels drawn', ops.fillText >= 5 + tt.ticks.length - 2, ops.fillText);
  WC.drawOverlay(ctx, frame, { x: 600, y: 100, points: [{ y: 50, color: '#f00' }] }, { x0: 300, x1: 500 });
  const ov = WC.drawOverview(ctx, { w: 1200, h: 36, store: s, chans: [0, 1], colors: ['#fff'], view: frame.view });
  check('overview: window rect returned at right edge', ov && ov.xb > 1190, ov);
  check('plotAt: hit test', WC.plotAt(WC.computeLayout(600, 300, [{ id: 0, chans: [0] }, { id: 1, chans: [1] }]), 250) === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
