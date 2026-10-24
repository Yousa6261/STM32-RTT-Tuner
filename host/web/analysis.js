/* RTTproject 分析算法 (v3 P3) —— 纯函数, 无 DOM 依赖, 可在 Node 中测试。
 * 提供: FFT 频谱 (窗函数/幅值校正/峰值插值/THD)、STFT 时频图、阶跃响应指标、等效二阶参数、CSV 导出。
 * 约定: 采样序列 x 为数组 (null/NaN 视为缺失), fs 为采样率 (Hz)。
 */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ FFT
  function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

  // 原地基 2 FFT (re/im 为 Float64Array, 长度为 2 的幂)
  function fftInPlace(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {           // 位反转重排
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const tr = re[b] * cr - im[b] * ci;
          const ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  const WINDOWS = {
    rect: () => 1,
    hann: (k, n) => 0.5 - 0.5 * Math.cos(2 * Math.PI * k / (n - 1)),
    hamming: (k, n) => 0.54 - 0.46 * Math.cos(2 * Math.PI * k / (n - 1)),
    blackmanharris: (k, n) => {
      const a = 2 * Math.PI * k / (n - 1);
      return 0.35875 - 0.48829 * Math.cos(a) + 0.14128 * Math.cos(2 * a) - 0.01168 * Math.cos(3 * a);
    }
  };

  // 缺失值 (null/NaN) 线性插补; 全部缺失返回 null
  function fillGaps(x) {
    const n = x.length, y = new Float64Array(n);
    let last = -1, missing = 0;
    for (let k = 0; k < n; k++) {
      const v = x[k];
      if (typeof v === 'number' && Number.isFinite(v)) {
        if (last < 0) { for (let j = 0; j < k; j++) y[j] = v; }
        else if (k - last > 1) { const a = y[last]; for (let j = last + 1; j < k; j++) y[j] = a + (v - a) * (j - last) / (k - last); }
        y[k] = v; last = k;
      } else missing++;
    }
    if (last < 0) return null;
    for (let j = last + 1; j < n; j++) y[j] = y[last];
    return { y, missing };
  }

  // 各窗主瓣半宽 (bin, 未补零时); 能量法估幅时取 ±(半宽+1) 个 bin
  const LOBE_HALF = { rect: 1, hann: 2, hamming: 2, blackmanharris: 4 };

  /**
   * 单边幅值谱。
   * - amp[]: 每个 bin 的幅值 (按窗的相干增益校正, 正弦恰在 bin 上时读数为其幅值)。
   * - 峰值/谐波幅值用"主瓣能量法"估计 (Parseval: A = 2·sqrt(Σ|X|² / (nfft·Σw²))), 与频率偏离 bin 的程度无关;
   *   直接读最大 bin 在 Hann 窗下最多低 1.42 dB (栅栏损失)。
   * - 去趋势减去"加窗加权均值", 使直流 bin 严格为 0 (普通均值在非整周期时仍会残留)。
   * opts: window ('hann'), detrend ('mean' | 'none'), pad (补零到 2 的幂, 默认 true), maxPeaks (5)
   * 返回 { freq, amp, db, df, n, nfft, peak:{f,amp,db,bin}, peaks:[...], missing, ... }
   */
  function spectrum(x, fs, opts) {
    opts = opts || {};
    const wname = opts.window || 'hann';
    const wf = WINDOWS[wname];
    if (!wf) throw new Error('unknown window ' + wname);
    const g = fillGaps(x);
    if (!g || x.length < 4) return null;
    const n = x.length;
    const nfft = opts.pad === false ? n : nextPow2(n);
    if ((nfft & (nfft - 1)) !== 0) throw new Error('length must be power of 2 when pad=false');
    const w = new Float64Array(n);
    let wsum = 0, w2sum = 0, xw = 0;
    for (let k = 0; k < n; k++) { w[k] = wf(k, n); wsum += w[k]; w2sum += w[k] * w[k]; xw += g.y[k] * w[k]; }
    const mean = (opts.detrend || 'mean') === 'mean' ? xw / wsum : 0;
    const re = new Float64Array(nfft), im = new Float64Array(nfft);
    for (let k = 0; k < n; k++) re[k] = (g.y[k] - mean) * w[k];
    fftInPlace(re, im);
    const half = nfft / 2;
    const freq = new Float64Array(half + 1), amp = new Float64Array(half + 1), db = new Float64Array(half + 1);
    const pow = new Float64Array(half + 1);
    for (let k = 0; k <= half; k++) {
      freq[k] = k * fs / nfft;
      pow[k] = re[k] * re[k] + im[k] * im[k];
      const m = Math.sqrt(pow[k]) / wsum;
      amp[k] = (k === 0 || k === half) ? m : 2 * m;
      db[k] = 20 * Math.log10(amp[k] + 1e-15);
    }
    const spec = { freq, amp, db, pow, df: fs / nfft, n, nfft, window: wname, w2sum,
                   lobe: Math.ceil((LOBE_HALF[wname] + 1) * nfft / n), missing: g.missing };
    spec.peaks = findPeaks(spec, opts.maxPeaks || 5);
    spec.peak = spec.peaks[0] || null;
    return spec;
  }

  /** 主瓣能量法估计频点 bin 附近单个正弦的幅值 */
  function toneAmplitude(spec, bin) {
    const lo = Math.max(1, bin - spec.lobe), hi = Math.min(spec.pow.length - 1, bin + spec.lobe);
    let p = 0;
    for (let j = lo; j <= hi; j++) p += spec.pow[j];
    return 2 * Math.sqrt(p / (spec.nfft * spec.w2sum));
  }

  // 局部极大值 (排除直流): 频率用对数幅值三点抛物线插值, 幅值用主瓣能量法
  function findPeaks(spec, maxN) {
    const { amp, db, freq, df } = spec;
    const cands = [];
    for (let k = 1; k < amp.length - 1; k++) {
      if (amp[k] > amp[k - 1] && amp[k] >= amp[k + 1]) cands.push(k);
    }
    cands.sort((a, b) => amp[b] - amp[a]);
    const out = [];
    for (const k of cands) {
      if (out.length >= maxN) break;
      if (out.some(p => Math.abs(p.bin - k) <= 2 * spec.lobe)) continue;
      const a = db[k - 1], b = db[k], c = db[k + 1];
      const den = a - 2 * b + c;
      const d = den !== 0 ? 0.5 * (a - c) / den : 0;
      const A = toneAmplitude(spec, k);
      out.push({ bin: k, f: freq[k] + d * df, amp: A, db: 20 * Math.log10(A + 1e-15) });
    }
    return out;
  }

  /** THD (%) = sqrt(sum(A_h^2, h=2..H)) / A_1; 各次谐波幅值用主瓣能量法 (在谐波频点 ±1 bin 内找最大 bin 为中心) */
  function thd(spec, f1, harmonics) {
    harmonics = harmonics || 10;
    const pick = (f) => {
      const k = Math.round(f / spec.df);
      if (k < 1 || k >= spec.amp.length - 1 - spec.lobe) return null;
      let best = k;
      for (let j = Math.max(1, k - 1); j <= k + 1; j++) if (spec.amp[j] > spec.amp[best]) best = j;
      return toneAmplitude(spec, best);
    };
    const a1 = pick(f1);
    if (!a1) return null;
    let s = 0, used = 0;
    for (let h = 2; h <= harmonics; h++) { const a = pick(f1 * h); if (a === null) break; s += a * a; used++; }
    return { thdPct: 100 * Math.sqrt(s) / a1, fundamental: a1, harmonicsUsed: used };
  }

  /**
   * STFT 时频图: 返回 { times (帧中心, s), freqs, db: Float32Array[帧][频点], win, hop }
   * 帧数 = floor((n - win)/hop) + 1; win 须为 2 的幂。
   */
  function stft(x, fs, opts) {
    opts = opts || {};
    const win = opts.win || 256, hop = opts.hop || Math.max(1, win >> 2);
    if ((win & (win - 1)) !== 0) throw new Error('win must be power of 2');
    const g = fillGaps(x);
    if (!g || x.length < win) return null;
    const wf = WINDOWS[opts.window || 'hann'];
    const w = new Float64Array(win); let wsum = 0;
    for (let k = 0; k < win; k++) { w[k] = wf(k, win); wsum += w[k]; }
    const frames = Math.floor((x.length - win) / hop) + 1;
    const half = win / 2;
    const freqs = new Float64Array(half + 1);
    for (let k = 0; k <= half; k++) freqs[k] = k * fs / win;
    const times = new Float64Array(frames), db = [];
    const re = new Float64Array(win), im = new Float64Array(win);
    for (let f = 0; f < frames; f++) {
      const s = f * hop;
      let mean = 0;
      for (let k = 0; k < win; k++) mean += g.y[s + k];
      mean /= win;
      for (let k = 0; k < win; k++) { re[k] = (g.y[s + k] - mean) * w[k]; im[k] = 0; }
      fftInPlace(re, im);
      const row = new Float32Array(half + 1);
      for (let k = 0; k <= half; k++) {
        const a = Math.hypot(re[k], im[k]) / wsum * ((k === 0 || k === half) ? 1 : 2);
        row[k] = 20 * Math.log10(a + 1e-12);
      }
      db.push(row);
      times[f] = (s + win / 2) / fs;
    }
    return { times, freqs, db, win, hop };
  }

  // ------------------------------------------------------------------ 阶跃响应
  function movingAverage(y, m) {
    if (!(m > 1)) return y;
    const n = y.length, out = new Float64Array(n), h = Math.floor(m / 2);
    let s = 0, c = 0;
    for (let k = 0; k < Math.min(n, h + 1); k++) { s += y[k]; c++; }
    for (let k = 0; k < n; k++) {
      out[k] = s / c;
      const add = k + h + 1, rem = k - h;
      if (add < n) { s += y[add]; c++; }
      if (rem >= 0) { s -= y[rem]; c--; }
    }
    return out;
  }

  /** 在参考通道中找最大跳变 (阶跃) 位置: 返回 {index, from, to} 或 null */
  function detectStep(ref) {
    const g = fillGaps(ref);
    if (!g) return null;
    const r = g.y;
    let lo = Infinity, hi = -Infinity;
    for (const v of r) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const range = hi - lo;
    if (!(range > 0)) return null;
    let best = -1, bestD = 0;
    for (let k = 1; k < r.length; k++) {
      const d = Math.abs(r[k] - r[k - 1]);
      if (d > bestD) { bestD = d; best = k; }
    }
    if (bestD < 0.5 * range) return null;               // 不是阶跃 (斜坡/噪声)
    return { index: best, from: r[best - 1], to: r[best] };
  }

  // 第一次从 a 侧穿越 level 的位置 (线性插值, 返回分数下标); 找不到返回 null
  function crossing(z, level, start) {
    for (let k = Math.max(1, start); k < z.length; k++) {
      if (z[k - 1] < level && z[k] >= level) return k - 1 + (level - z[k - 1]) / (z[k] - z[k - 1]);
    }
    return null;
  }

  /**
   * 阶跃响应指标。
   * y: 响应通道; fs: 采样率; opts:
   *   ref: 参考通道 (用于定位阶跃与计算稳态误差); stepIndex: 手动指定阶跃下标 (优先)
   *   end: 分析终点下标 (默认: 参考通道下一次跳变之前, 或序列末尾)
   *   rise: [0.1, 0.9]; band: 0.02 (调节带 ±2%); smooth: 滑动平均点数 (默认 1 = 不平滑)
   *   tailFrac: 0.1 (终值取分析区间末尾 10% 的均值)
   * 返回 { ok, reason?, stepIndex, y0, yf, amplitude, delayTime, riseTime, peakTime, overshootPct,
   *        settlingTime, settled, steadyStateError, refFinal, zeta, wn, marks:{...下标} }
   * 时间单位 s, 均相对阶跃时刻。
   */
  function stepResponse(y, fs, opts) {
    opts = opts || {};
    const g = fillGaps(y);
    if (!g || y.length < 8) return { ok: false, reason: '数据不足' };
    let s = opts.stepIndex;
    let refStep = null;
    if (s === undefined || s === null) {
      if (!opts.ref) return { ok: false, reason: '需要参考通道或阶跃下标' };
      refStep = detectStep(opts.ref);
      if (!refStep) return { ok: false, reason: '参考通道中未检测到阶跃' };
      s = refStep.index;
    }
    if (s < 1 || s >= y.length - 4) return { ok: false, reason: '阶跃位置太靠近数据边缘' };
    let end = opts.end;
    if (end === undefined || end === null) {
      end = y.length;
      if (opts.ref) {
        const rg = fillGaps(opts.ref).y;
        const thr = refStep ? 0.5 * Math.abs(refStep.to - refStep.from) : 0;
        for (let k = s + 1; k < rg.length; k++) {
          if (thr > 0 && Math.abs(rg[k] - rg[k - 1]) >= thr) { end = k; break; }
        }
      }
    }
    const yy = movingAverage(g.y, opts.smooth || 1);
    const pre = Math.max(1, Math.min(s, Math.round((end - s) * 0.1), 200));
    let y0 = 0; for (let k = s - pre; k < s; k++) y0 += yy[k]; y0 /= pre;
    const tailFrac = opts.tailFrac || 0.1;
    const tail = Math.max(1, Math.round((end - s) * tailFrac));
    let yf = 0; for (let k = end - tail; k < end; k++) yf += yy[k]; yf /= tail;
    const A = yf - y0;
    let noise = 0; for (let k = s - pre; k < s; k++) noise = Math.max(noise, Math.abs(yy[k] - y0));
    if (!(Math.abs(A) > 1e-12) || Math.abs(A) < 3 * noise) return { ok: false, reason: '响应幅度相对噪声过小' };
    const z = new Float64Array(end - s);
    for (let k = 0; k < z.length; k++) z[k] = (yy[s + k] - y0) / A;    // 归一化, 方向统一为向上
    const [rlo, rhi] = opts.rise || [0.1, 0.9];
    const band = opts.band || 0.02;
    const iLo = crossing(z, rlo, 1) ?? (z[0] >= rlo ? 0 : null);
    const iHi = iLo !== null ? crossing(z, rhi, Math.floor(iLo) + 1) : null;
    const i50 = crossing(z, 0.5, 1) ?? (z[0] >= 0.5 ? 0 : null);
    let pk = 0; for (let k = 1; k < z.length; k++) if (z[k] > z[pk]) pk = k;
    const overshoot = Math.max(0, (z[pk] - 1) * 100);
    let lastOut = -1;
    for (let k = 0; k < z.length; k++) if (Math.abs(z[k] - 1) > band) lastOut = k;
    const settled = lastOut < z.length - Math.max(2, Math.round(z.length * 0.05));
    const settleIdx = settled ? lastOut + 1 : null;
    const res = {
      ok: true, stepIndex: s, end, y0, yf, amplitude: A,
      delayTime: i50 !== null ? i50 / fs : null,
      riseTime: (iLo !== null && iHi !== null) ? (iHi - iLo) / fs : null,
      peakTime: pk / fs, overshootPct: overshoot,
      settlingTime: settleIdx !== null ? settleIdx / fs : null, settled,
      band, rise: [rlo, rhi], refFinal: null, steadyStateError: null, zeta: null, wn: null,
      marks: { lo: iLo !== null ? s + iLo : null, hi: iHi !== null ? s + iHi : null, peak: s + pk,
               settle: settleIdx !== null ? s + settleIdx : null, d50: i50 !== null ? s + i50 : null }
    };
    if (opts.ref) {
      const rg = fillGaps(opts.ref).y;
      let rf = 0; for (let k = end - tail; k < end; k++) rf += rg[k]; rf /= tail;
      res.refFinal = rf;
      res.steadyStateError = rf - yf;
    }
    // 等效二阶参数 (仅欠阻尼且超调明显时有意义)
    if (overshoot > 0.5 && pk > 0) {
      const lnOs = Math.log(overshoot / 100);
      const zeta = -lnOs / Math.sqrt(Math.PI * Math.PI + lnOs * lnOs);
      const wd = Math.PI / (pk / fs);
      res.zeta = zeta;
      res.wn = wd / Math.sqrt(1 - zeta * zeta);
    }
    return res;
  }

  // ------------------------------------------------------------------ 导出
  function captureToCsv(cap, namesOverride) {
    const n = cap.total || (cap.channels && cap.channels[0] ? cap.channels[0].length : 0);
    const fs = cap.fs || cap.sample_hz || 1;
    const ti = (cap.trig_index !== undefined ? cap.trig_index : cap.trigger_index) || 0;
    const names = namesOverride || cap.names || cap.channels.map((_, i) => `CH${i}`);
    const head = ['index', 't_s'].concat(names.map(s => '"' + String(s).replace(/"/g, '""') + '"'));
    const lines = [head.join(',')];
    for (let k = 0; k < n; k++) {
      const row = [k, ((k - ti) / fs).toPrecision(9)];
      for (const ch of cap.channels) { const v = ch[k]; row.push(v === null || v === undefined ? '' : v); }
      lines.push(row.join(','));
    }
    return lines.join('\n') + '\n';
  }

  const api = { nextPow2, fftInPlace, spectrum, findPeaks, toneAmplitude, thd, stft, movingAverage, detectStep, stepResponse,
                fillGaps, captureToCsv, toCSV: captureToCsv, WINDOWS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RTTAnalysis = api;
})(typeof window !== 'undefined' ? window : globalThis);
