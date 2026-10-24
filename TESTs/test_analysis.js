// Tests for host/web/analysis.js against analytic references.
// Usage: node TESTs/test_analysis.js [path/to/app.js ignored]
const path = require('path');
const A = require(path.join(__dirname, '..', 'host', 'web', 'analysis.js'));

let pass = 0, fail = 0;
const check = (n, c, i = '') => { if (c) { pass++; console.log('PASS ', n); } else { fail++; console.log('FAIL ', n, i); } };
const close = (a, b, tol) => Math.abs(a - b) <= tol;

// deterministic noise
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const gauss = () => { const u = Math.max(rnd(), 1e-12), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

// ---- FFT basics
{
  const n = 64, re = new Float64Array(n), im = new Float64Array(n);
  re[0] = 1; A.fftInPlace(re, im);
  check('FFT impulse -> flat spectrum', [...re].every(v => close(v, 1, 1e-12)) && [...im].every(v => close(v, 0, 1e-12)));
  const r2 = new Float64Array(n), i2 = new Float64Array(n);
  for (let k = 0; k < n; k++) r2[k] = Math.cos(2 * Math.PI * 5 * k / n);
  A.fftInPlace(r2, i2);
  check('FFT cos bin 5 -> n/2 at bins 5 and n-5', close(r2[5], n / 2, 1e-9) && close(r2[n - 5], n / 2, 1e-9) && close(Math.hypot(r2[6], i2[6]), 0, 1e-9));
}

// ---- spectrum amplitude accuracy (coherent and non-coherent), all windows
const fs = 20000, N = 4096;
const tone = (f, a, ph = 0) => Array.from({ length: N }, (_, k) => a * Math.sin(2 * Math.PI * f * k / fs + ph));
for (const w of ['rect', 'hann', 'hamming', 'blackmanharris']) {
  const fc = 50 * fs / N;               // exactly on bin 50
  const s = A.spectrum(tone(fc, 2.5), fs, { window: w });
  check(`spectrum ${w}: on-bin tone amplitude 2.5`, close(s.peak.amp, 2.5, 2.5 * 0.005) && close(s.peak.f, fc, s.df * 0.05), [s.peak.amp, s.peak.f]);
}
{
  // off-bin tone: Hann scalloping <= 1.42 dB uncorrected; parabolic interpolation on dB should get within ~0.5%
  const f = 1000 + 0.37 * fs / N;
  const s = A.spectrum(tone(f, 1.0, 0.3), fs, { window: 'hann' });
  check('spectrum hann off-bin: freq within 0.05 bin', close(s.peak.f, f, s.df * 0.05), [s.peak.f, f]);
  check('spectrum hann off-bin: amplitude within 0.5% (energy method)', close(s.peak.amp, 1.0, 0.005), s.peak.amp);
  const sb = A.spectrum(tone(f, 1.0, 0.3), fs, { window: 'blackmanharris' });
  check('spectrum BH off-bin: amplitude within 0.5%', close(sb.peak.amp, 1.0, 0.005), sb.peak.amp);
}
{
  // two tones as in the hardware demo: 1 kHz amp 1 + 3 kHz amp 0.3, plus DC 5 (removed by detrend)
  const x = tone(1000, 1).map((v, k) => v + 0.3 * Math.sin(2 * Math.PI * 3000 * k / fs) + 5);
  const s = A.spectrum(x, fs, { window: 'hann' });
  const p = s.peaks.slice(0, 2).sort((a, b) => a.f - b.f);
  check('two tones: peaks at 1k and 3k', close(p[0].f, 1000, 2) && close(p[1].f, 3000, 2), p.map(q => q.f));
  check('two tones: amplitudes 1.0 / 0.3 (0.5%)', close(p[0].amp, 1, 0.005) && close(p[1].amp, 0.3, 0.0015), p.map(q => q.amp));
  check('detrend (window-weighted mean) removes DC exactly', s.amp[0] < 1e-9, s.amp[0]);
  const t = A.thd(s, 1000, 5);
  check('THD of 1k + 0.3@3k = 30% (0.3%)', close(t.thdPct, 30, 0.3), t.thdPct);
}
{
  const x = tone(1000, 1); x[100] = null; x[101] = NaN;
  const s = A.spectrum(x, fs, {});
  check('missing samples interpolated and reported', s.missing === 2 && close(s.peak.amp, 1, 0.02));
  const s2 = A.spectrum(tone(1000, 1).slice(0, 3000), fs, {});
  check('non power-of-2 length zero-padded, amplitude preserved', s2.nfft === 4096 && close(s2.peak.amp, 1, 0.03), [s2.nfft, s2.peak.amp]);
}

// ---- STFT: linear chirp 200 Hz -> 4 kHz; ridge frequency must follow the instantaneous frequency
{
  const f0 = 200, f1 = 4000, dur = N / fs;
  const x = Array.from({ length: N }, (_, k) => { const t = k / fs; return Math.sin(2 * Math.PI * (f0 * t + (f1 - f0) * t * t / (2 * dur))); });
  const st = A.stft(x, fs, { win: 256, hop: 64 });
  check('STFT frame count', st.db.length === Math.floor((N - 256) / 64) + 1, st.db.length);
  let maxErr = 0;
  st.db.forEach((row, fi) => {
    let kb = 1; for (let k = 1; k < row.length; k++) if (row[k] > row[kb]) kb = k;
    const fInst = f0 + (f1 - f0) * st.times[fi] / dur;
    maxErr = Math.max(maxErr, Math.abs(st.freqs[kb] - fInst));
  });
  check('STFT ridge tracks chirp within 2 bins', maxErr <= 2 * fs / 256, maxErr);
}

// ---- step response vs analytic 2nd order
function step2(t, wn, z) {
  if (t < 0) return 0;
  const wd = wn * Math.sqrt(1 - z * z), phi = Math.acos(z);
  return 1 - Math.exp(-z * wn * t) * Math.sin(wd * t + phi) / Math.sqrt(1 - z * z);
}
function refMetrics(wn, z, band) {          // dense numeric reference
  const dt = 1e-6, T = 12 / (z * wn);
  let tLo = null, tHi = null, t50 = null, pk = 0, tp = 0, lastOut = 0;
  for (let t = 0; t < T; t += dt) {
    const y = step2(t, wn, z);
    if (tLo === null && y >= 0.1) tLo = t;
    if (tHi === null && y >= 0.9) tHi = t;
    if (t50 === null && y >= 0.5) t50 = t;
    if (y > pk) { pk = y; tp = t; }
    if (Math.abs(y - 1) > band) lastOut = t;
  }
  return { tr: tHi - tLo, td: t50, os: (pk - 1) * 100, tp, ts: lastOut };
}
for (const [zeta, fn] of [[0.3, 50], [0.5, 20], [0.7, 100]]) {
  const wn = 2 * Math.PI * fn;
  const fsr = 20000, pre = 800, n = 8000;
  const amp = 3.0, base = 1.0;
  const ref = Array.from({ length: n }, (_, k) => k >= pre ? base + amp : base);
  const y = ref.map((_, k) => base + amp * step2((k - pre) / fsr, wn, zeta));
  const m = A.stepResponse(y, fsr, { ref });
  const r = refMetrics(wn, zeta, 0.02);
  const T = 1 / fsr;
  check(`step z=${zeta} f=${fn}: ok & step index`, m.ok && m.stepIndex === pre, m.reason || m.stepIndex);
  check(`step z=${zeta}: overshoot ${r.os.toFixed(2)}%`, close(m.overshootPct, r.os, 0.05), m.overshootPct);
  check(`step z=${zeta}: rise time 10-90`, close(m.riseTime, r.tr, T), [m.riseTime, r.tr]);
  check(`step z=${zeta}: delay 50%`, close(m.delayTime, r.td, T), [m.delayTime, r.td]);
  check(`step z=${zeta}: peak time`, close(m.peakTime, r.tp, T), [m.peakTime, r.tp]);
  check(`step z=${zeta}: settling 2%`, m.settled && close(m.settlingTime, r.ts, 2 * T), [m.settlingTime, r.ts]);
  check(`step z=${zeta}: equivalent zeta/wn`, close(m.zeta, zeta, 0.005) && close(m.wn, wn, wn * 0.01), [m.zeta, m.wn]);
  check(`step z=${zeta}: steady-state error ~0`, close(m.steadyStateError, 0, 1e-3 * amp), m.steadyStateError);
}
{
  // downward step with offset, noise and steady-state error; window ends at next ref change
  const fsr = 10000, n = 6000, pre = 1000, back = 4500, wn = 2 * Math.PI * 30, zeta = 0.4;
  const ref = Array.from({ length: n }, (_, k) => (k >= pre && k < back) ? -2 : 1);
  const y = ref.map((_, k) => {
    if (k < pre) return 1 + 0.002 * gauss();
    const kk = Math.min(k, back - 1);
    return 1 + (-2.9) * step2((kk - pre) / fsr, wn, zeta) + 0.002 * gauss();   // final -1.9 => sse = -0.1
  });
  const m = A.stepResponse(y, fsr, { ref });
  const r = refMetrics(wn, zeta, 0.02);
  check('down step: detected, end at next ref change', m.ok && m.stepIndex === pre && m.end === back, [m.stepIndex, m.end]);
  check('down step: overshoot within 0.5% (noise)', close(m.overshootPct, r.os, 0.5), [m.overshootPct, r.os]);
  check('down step: steady-state error -0.1', close(m.steadyStateError, -0.1, 0.005), m.steadyStateError);
  const ms = A.stepResponse(y, fsr, { ref, smooth: 5 });
  check('smoothing keeps rise time', close(ms.riseTime, r.tr, 3 / fsr), [ms.riseTime, r.tr]);
}
{
  // overdamped: no overshoot, no zeta estimate; flat signal: rejected
  const fsr = 10000, n = 5000, pre = 500;
  const ref = Array.from({ length: n }, (_, k) => k >= pre ? 1 : 0);
  const y = ref.map((_, k) => k < pre ? 0 : 1 - Math.exp(-(k - pre) / fsr / 0.02));
  const m = A.stepResponse(y, fsr, { ref });
  check('first order: overshoot ~0 (<0.001%), no zeta', m.ok && m.overshootPct < 1e-3 && m.zeta === null, [m.overshootPct, m.zeta]);
  check('first order: rise time = tau*ln9', close(m.riseTime, 0.02 * Math.log(9), 2 / fsr), m.riseTime);
  const flat = A.stepResponse(ref.map(() => 0.5), fsr, { ref });
  check('flat response rejected', flat.ok === false, flat.reason);
  check('no step in ref rejected', A.stepResponse(y, fsr, { ref: y.map((_, k) => k / n) }).ok === false);
  const notSettled = A.stepResponse(ref.map((_, k) => k < pre ? 0 : 1 + 0.2 * Math.sin((k - pre) / 20)), fsr, { ref });
  check('persistent oscillation -> settled=false', notSettled.ok && notSettled.settled === false, notSettled);
}

// ---- CSV
{
  const cap = { total: 3, fs: 1000, trig_index: 1, names: ['a', 'b"x'], channels: [[1, 2, 3], [null, 5, 6]] };
  const csv = A.captureToCsv(cap).trim().split('\n');
  check('CSV header quoted, time relative to trigger, null -> empty', csv[0] === 'index,t_s,"a","b""x"' && csv[1].startsWith('0,-0.00100000') && csv[1].endsWith(',1,'), csv);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
