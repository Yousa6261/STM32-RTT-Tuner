/**
 * STM32 SEGGER RTT v3.1 — Ch1 波形数据层 + 渲染器 (wave_core.js)
 *
 * 本模块【不访问 DOM】, 只接收数据与 CanvasRenderingContext2D, 因此既可在主线程运行,
 * 也可原样放进 Web Worker + OffscreenCanvas (方案 A 第二步, 需要时只改启动/消息部分)。
 *
 *  A1 WaveStore   : 每通道预分配 Float32Array 环形缓冲, 写入/淘汰均为 O(1), 无 GC 抖动
 *  A2 TimeAxis    : "样本序号 + 速率分段表" 表示时间轴, 不为每个点存时间戳; 修改 wave_div 后时间仍正确
 *  A3 min/max 金字塔: 每级 ×16 抽取 (16 / 256 / 4096), 写入时增量维护, 额外内存约 13%
 *  A4 decodeWaveBinary: 网关二进制 WebSocket 帧 (float32 小端) 零拷贝映射为 Float32Array
 *  B1 M4 列渲染   : 每像素列取 first/min/max/last, 绘制开销只与屏幕宽度有关, 与数据量无关
 *  B4 devicePixelRatio 由调用方设置 ctx 变换, 本模块统一使用 CSS 像素坐标
 *
 * 浏览器: <script src="wave_core.js"> → window.RTTWaveCore;  Node: require('./wave_core.js')
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RTTWaveCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PYR_FACTOR = 16;
  const PYR_LEVELS = 3;
  // 原始数据 + 每级 min/max 两个数组: 1 + 2/16 + 2/256 + 2/4096
  const MEM_FACTOR = 1 + 2 / 16 + 2 / 256 + 2 / 4096;
  const MIN_CAPACITY = 1024;

  /** 有限值判断 (NaN / ±Infinity 返回 false), 比 Number.isFinite 少一次函数调用 */
  const isFin = v => v - v === 0;

  // ===========================================================================
  // A1 + A3: 环形缓冲 + min/max 金字塔
  // ===========================================================================
  // 绝对样本序号 (absolute index) 从 0 单调递增, 永不回绕 (Number 精确到 2^53, 10 MHz 下可运行 28 年)。
  // 有效区间 [oldest, head): oldest = max(base, head - cap); clear() 只把 base 移到 head, 序号不回零,
  // 因此光标/标注/播放头等引用旧序号的对象不会错位到新数据上。
  class WaveStore {
    constructor(nch, capacity) { this.reset(nch, capacity); }

    reset(nch, capacity) {
      this.nch = Math.max(1, nch | 0);
      this.cap = Math.max(MIN_CAPACITY, Math.ceil(Number(capacity) || 0));
      this.data = [];
      for (let c = 0; c < this.nch; c++) this.data.push(new Float32Array(this.cap));
      this.head = 0;
      this.base = 0;
      this._buildLevels();
    }

    _buildLevels() {
      this.levels = [];
      let bs = 1;
      for (let L = 0; L < PYR_LEVELS; L++) {
        bs *= PYR_FACTOR;
        // +2: 保证金字塔桶槽位不会在其样本仍留在原始环中时被覆盖
        const lc = Math.ceil(this.cap / bs) + 2;
        const lv = { bs, cap: lc, min: [], max: [] };
        for (let c = 0; c < this.nch; c++) {
          lv.min.push(new Float32Array(lc).fill(NaN));
          lv.max.push(new Float32Array(lc).fill(NaN));
        }
        this.levels.push(lv);
      }
    }

    get oldest() { return Math.max(this.base, this.head - this.cap); }
    get count() { return this.head - this.oldest; }
    bytes() { return WaveStore.bytesFor(this.cap, this.nch); }
    static bytesFor(cap, nch) { return cap * nch * 4 * MEM_FACTOR; }

    /** 清空: 序号保持单调, 旧数据整体失效 */
    clear() { this.base = this.head; }

    /**
     * 追加 nframes 帧 (行优先: [f0c0, f0c1, ..., f1c0, ...])。
     * arr 可以是 Float32Array (二进制帧) 或普通数组 (null/undefined 视为 NaN)。
     * 帧通道数 nch 与存储通道数不同时: 多出的丢弃, 缺少的补 NaN。
     */
    pushInterleaved(arr, nframes, nch) {
      const n = this.nch;
      const use = Math.min(n, nch | 0);
      const cap = this.cap;
      const levels = this.levels;
      const nl = levels.length;
      for (let f = 0; f < nframes; f++) {
        const i = this.head;
        const pos = i % cap;
        const off = f * nch;
        for (let c = 0; c < n; c++) {
          let v = c < use ? arr[off + c] : NaN;
          if (typeof v !== 'number') v = NaN;
          const col = this.data[c];
          col[pos] = v;
          v = col[pos];   // 使用 float32 舍入后的值, 保证金字塔与原始数据完全一致
          const fin = v - v === 0;
          for (let L = 0; L < nl; L++) {
            const lv = levels[L];
            const bs = lv.bs;
            const s = Math.floor(i / bs) % lv.cap;
            const lmin = lv.min[c], lmax = lv.max[c];
            if (i % bs === 0) {
              lmin[s] = fin ? v : NaN;
              lmax[s] = fin ? v : NaN;
            } else if (fin) {
              const mn = lmin[s];
              if (mn !== mn) { lmin[s] = v; lmax[s] = v; } else {
                if (v < mn) lmin[s] = v;
                if (v > lmax[s]) lmax[s] = v;
              }
            }
          }
        }
        this.head = i + 1;
      }
    }

    /** 读取绝对序号 i 处的值 (调用方保证 i ∈ [oldest, head)) */
    get(c, i) { return this.data[c][i % this.cap]; }

    /** 安全读取: 越界或非整数序号时取最近样本, 无数据返回 NaN */
    valueAt(c, i) {
      const k = Math.round(i);
      if (!(c >= 0 && c < this.nch) || k < this.oldest || k >= this.head) return NaN;
      return this.data[c][k % this.cap];
    }

    /**
     * 区间 [i0, i1) 内通道 c 的 [min, max] (忽略 NaN/Inf; 无有效值返回 [NaN, NaN])。
     * 层级分解: 完整落在区间内的桶用金字塔, 两端不足一桶的部分逐级下沉, 最底层扫原始数据。
     * 复杂度 O(16 × 级数 × 2 + 桶数)。
     */
    rangeMinMax(c, i0, i1, out) {
      out = out || [NaN, NaN];
      const a0 = Math.max(Math.floor(i0), this.oldest);
      const b0 = Math.min(Math.ceil(i1), this.head);
      const acc = [Infinity, -Infinity];
      if (b0 > a0 && c >= 0 && c < this.nch) this._rec(c, a0, b0, this.levels.length - 1, acc);
      out[0] = acc[0] === Infinity ? NaN : acc[0];
      out[1] = acc[1] === -Infinity ? NaN : acc[1];
      return out;
    }

    _rec(c, a, b, L, acc) {
      if (b <= a) return;
      if (L < 0) { this._scanRaw(c, a, b, acc); return; }
      const lv = this.levels[L];
      const bs = lv.bs;
      const fa = Math.ceil(a / bs) * bs;
      const fb = Math.floor(b / bs) * bs;
      if (fb <= fa) { this._rec(c, a, b, L - 1, acc); return; }
      this._rec(c, a, fa, L - 1, acc);
      const lmin = lv.min[c], lmax = lv.max[c], lc = lv.cap;
      let mn = acc[0], mx = acc[1];
      for (let k = fa / bs, ke = fb / bs; k < ke; k++) {
        const s = k % lc;
        const x = lmin[s];
        if (x === x) {
          if (x < mn) mn = x;
          const y = lmax[s];
          if (y > mx) mx = y;
        }
      }
      acc[0] = mn; acc[1] = mx;
      this._rec(c, fb, b, L - 1, acc);
    }

    _scanRaw(c, a, b, acc) {
      const col = this.data[c], cap = this.cap;
      let mn = acc[0], mx = acc[1];
      for (let i = a; i < b; i++) {
        const v = col[i % cap];
        if (v - v === 0) { if (v < mn) mn = v; if (v > mx) mx = v; }
      }
      acc[0] = mn; acc[1] = mx;
    }

    /** 复制区间 [i0, i1) 为 Float32Array (用于导出/送入分析) */
    slice(c, i0, i1) {
      const a = Math.max(Math.floor(i0), this.oldest);
      const b = Math.min(Math.ceil(i1), this.head);
      const out = new Float32Array(Math.max(0, b - a));
      const col = this.data[c], cap = this.cap;
      for (let i = a; i < b; i++) out[i - a] = col[i % cap];
      return out;
    }

    /**
     * 改变容量: 保留最新的 min(count, newCap) 个样本, 绝对序号不变, 金字塔按保留数据重建。
     * 仅在采样率估计明显变化或用户修改历史时长时调用 (O(N), 不在每帧调用)。
     */
    resize(newCap) {
      newCap = Math.max(MIN_CAPACITY, Math.ceil(Number(newCap) || 0));
      if (newCap === this.cap) return;
      const keepFrom = Math.max(this.oldest, this.head - newCap);
      const keep = this.head - keepFrom;
      const nch = this.nch;
      const tmp = new Float32Array(keep * nch);
      for (let c = 0; c < nch; c++) {
        const col = this.data[c];
        for (let k = 0; k < keep; k++) tmp[k * nch + c] = col[(keepFrom + k) % this.cap];
      }
      const head = this.head;
      this.cap = newCap;
      this.data = [];
      for (let c = 0; c < nch; c++) this.data.push(new Float32Array(newCap));
      this._buildLevels();
      this.head = keepFrom;
      this.base = keepFrom;
      this.pushInterleaved(tmp, keep, nch);
      this.head = head;   // keep === head - keepFrom, 此处仅为显式说明
    }
  }

  /**
   * 按 "历史时长 × 实测采样率" 计算环形缓冲容量, 并受内存上限约束。
   * 返回 { cap, limited, seconds }: limited 表示被内存上限截断, seconds 为实际可回看时长。
   */
  function planCapacity(historySec, rate, nch, memLimitBytes) {
    const r = rate > 0 ? rate : 1000;   // 速率未知时先按 1 kHz 预留, 测到真实速率后再调整
    const want = Math.ceil(Math.max(1, historySec) * r * 1.15);
    const maxCap = Math.floor(memLimitBytes / (Math.max(1, nch) * 4 * MEM_FACTOR));
    const cap = Math.max(MIN_CAPACITY, Math.min(want, maxCap));
    return { cap, limited: want > maxCap, seconds: Math.min(historySec, cap / r) };
  }

  // ===========================================================================
  // A2: 时间轴 (样本序号 + 速率分段表)
  // ===========================================================================
  // 每段 { i0, t0, rate }: 序号 i 的时间 t = t0 + (i - i0) / rate。
  // 速率变化不足 0.5% 时不新建分段 (平滑估计的微小抖动不会产生大量分段)。
  class TimeAxis {
    constructor(i0) { this.reset(i0 || 0); }

    reset(i0) { this.segs = [{ i0: i0 || 0, t0: 0, rate: 0 }]; }

    get rate() { return this.segs[this.segs.length - 1].rate; }

    setRate(idx, rate) {
      if (!(rate > 0)) return;
      const last = this.segs[this.segs.length - 1];
      if (!(last.rate > 0)) { last.rate = rate; return; }          // 首次得到速率: 追溯应用到当前段
      if (Math.abs(rate - last.rate) / last.rate < 0.005) return;
      if (idx <= last.i0) { last.rate = rate; return; }
      this.segs.push({ i0: idx, t0: this.timeOf(idx), rate });
      if (this.segs.length > 4096) this.segs.splice(1, this.segs.length - 4096);
    }

    /** 删除完全早于 oldest 的分段 (保留覆盖 oldest 的那一段) */
    prune(oldest) {
      while (this.segs.length > 1 && this.segs[1].i0 <= oldest) this.segs.shift();
    }

    _segByIdx(idx) {
      const s = this.segs;
      let lo = 0, hi = s.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (s[mid].i0 <= idx) lo = mid; else hi = mid - 1;
      }
      return s[lo];
    }

    _segByTime(t) {
      const s = this.segs;
      let lo = 0, hi = s.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (s[mid].t0 <= t) lo = mid; else hi = mid - 1;
      }
      return s[lo];
    }

    timeOf(idx) {
      const s = this._segByIdx(idx);
      return s.t0 + (idx - s.i0) / (s.rate > 0 ? s.rate : 1);
    }

    idxAt(t) {
      const s = this._segByTime(t);
      return s.i0 + (t - s.t0) * (s.rate > 0 ? s.rate : 1);
    }

    rateAt(idx) { const r = this._segByIdx(idx).rate; return r > 0 ? r : 0; }
  }

  // ===========================================================================
  // 刻度与稳定纵轴
  // ===========================================================================
  function niceStep(span, target) {
    if (!(span > 0)) return 1;
    const raw = span / Math.max(1, target || 5);
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / p;
    const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return m * p;
  }

  /** 把 [lo, hi] 扩展为整齐刻度区间, 返回 [lo', hi', step] */
  function niceRange(lo, hi, ticks) {
    if (!isFin(lo) || !isFin(hi)) return null;
    if (hi < lo) { const t = lo; lo = hi; hi = t; }
    if (hi - lo <= 1e-12 * Math.max(1, Math.abs(hi))) {
      const d = Math.abs(hi) > 1e-9 ? Math.abs(hi) * 0.1 : 1;
      lo -= d; hi += d;
    }
    const step = niceStep(hi - lo, ticks || 4);
    const a = Math.floor(lo / step + 1e-9) * step;
    const b = Math.ceil(hi / step - 1e-9) * step;
    return [a, b > a ? b : a + step, step];
  }

  /**
   * 带迟滞的自动纵轴: 数据仍在当前区间内 (且距上下边界至少留 2% 余量)、未缩小到不足 30% 时保持不变,
   * 避免每帧微小变化导致纵轴刻度抖动 (也让网格层几乎不需要重绘)。
   * 区间边界按较细的刻度 (约 10 格) 取整, 浪费的纵向空间 < 约 15%; 网格线间距由 drawGrid 按像素高度另行决定。
   */
  function stabilizeRange(prev, lo, hi) {
    if (!isFin(lo) || !isFin(hi)) return prev || null;
    if (prev) {
      const span = prev[1] - prev[0];
      const m = span * 0.02;
      if (lo >= prev[0] + m && hi <= prev[1] - m && (hi - lo) >= 0.3 * span) return prev;
    }
    const pad = (hi - lo) * 0.06;
    return niceRange(lo - pad, hi + pad, 10);
  }

  /** 在基础区间上叠加用户的纵向缩放/平移 (zoom > 1 放大; pan 以区间跨度为单位) */
  function applyYView(r, zoom, pan) {
    if (!r) return null;
    const z = zoom > 0 ? zoom : 1;
    const span = r[1] - r[0];
    const c = (r[0] + r[1]) / 2 + (pan || 0) * span;
    const half = span / 2 / z;
    return [c - half, c + half, (r[2] || niceStep(span, 4)) / z];
  }

  function stepDecimals(step) {
    if (!(step > 0)) return 0;
    const p = Math.floor(Math.log10(step) + 1e-9);
    const mant = step / Math.pow(10, p);
    return Math.max(0, -p + (Math.abs(mant - 2.5) < 1e-6 ? 1 : 0));
  }

  function fmtNum(v, step) {
    if (!isFin(v)) return 'NaN';
    if (step > 0) {
      const d = stepDecimals(step);
      if (d <= 6 && Math.abs(v) < 1e7) return (Math.abs(v) < step * 1e-6 ? 0 : v).toFixed(d);
    }
    return Number(v.toPrecision(5)).toString();
  }

  function fmtTime(t, step) {
    if (!isFin(t)) return '';
    if (step > 0 && step < 0.001) return `${(t * 1000).toFixed(Math.min(6, stepDecimals(step * 1000)))}ms`;
    return `${(Math.abs(t) < (step || 1) * 1e-6 ? 0 : t).toFixed(Math.min(6, stepDecimals(step || 1)))}s`;
  }

  /** 时间轴刻度: [{ x, text }] (x 为 CSS 像素) */
  function timeTicks(axis, i0, i1, x0, x1, live) {
    const out = [];
    if (!(i1 > i0) || !(x1 > x0)) return { ticks: out, step: 0 };
    const tA = axis.timeOf(i0), tB = axis.timeOf(i1);
    const span = tB - tA;
    if (!(span > 0)) return { ticks: out, step: 0 };
    const step = niceStep(span, Math.max(2, Math.round((x1 - x0) / 90)));
    const xOf = t => x0 + (axis.idxAt(t) - i0) / (i1 - i0) * (x1 - x0);
    if (live) {
      // 实时: 相对最新时刻的负时间, 刻度位置在窗口不变时固定 (网格层无需每帧重绘)
      for (let k = 0; k * step <= span + step * 1e-6 && k < 200; k++) {
        const t = tB - k * step;
        out.push({ x: x1 - (k * step / span) * (x1 - x0), text: k === 0 ? '0' : fmtTime(-k * step, step) });
      }
    } else {
      for (let t = Math.ceil(tA / step - 1e-9) * step, n = 0; t <= tB + step * 1e-6 && n < 200; t += step, n++) {
        out.push({ x: xOf(t), text: fmtTime(t, step) });
      }
    }
    return { ticks: out, step };
  }

  // ===========================================================================
  // A4: 二进制波形帧
  // ===========================================================================
  // 布局 (小端): u8 kind=1 | u8 nch | u16 decim | u32 nframes | f32 fps | u32 resync | f32[nframes*nch]
  const WAVE_BIN_HEADER = 16;

  function decodeWaveBinary(buf) {
    if (!buf || typeof buf.byteLength !== 'number' || buf.byteLength < WAVE_BIN_HEADER) return null;
    const dv = new DataView(buf);
    if (dv.getUint8(0) !== 1) return null;
    const nch = dv.getUint8(1);
    const decim = dv.getUint16(2, true) || 1;
    const nframes = dv.getUint32(4, true);
    const fps = dv.getFloat32(8, true);
    const resync = dv.getUint32(12, true);
    if (nch < 1 || nch > 32 || buf.byteLength < WAVE_BIN_HEADER + nframes * nch * 4) return null;
    return { nch, decim, nframes, fps, resync, data: new Float32Array(buf, WAVE_BIN_HEADER, nframes * nch) };
  }

  function encodeWaveBinary(rows, nch, fps, decim, resync) {
    const n = rows.length;
    const buf = new ArrayBuffer(WAVE_BIN_HEADER + n * nch * 4);
    const dv = new DataView(buf);
    dv.setUint8(0, 1); dv.setUint8(1, nch); dv.setUint16(2, decim || 1, true);
    dv.setUint32(4, n, true); dv.setFloat32(8, fps || 0, true); dv.setUint32(12, resync || 0, true);
    const f = new Float32Array(buf, WAVE_BIN_HEADER);
    for (let k = 0; k < n; k++) for (let c = 0; c < nch; c++) {
      const v = rows[k][c];
      f[k * nch + c] = typeof v === 'number' ? v : NaN;
    }
    return buf;
  }

  // ===========================================================================
  // B1: M4 列统计 (first / min / max / last)
  // ===========================================================================
  function makeColumnBuffers(w) {
    const n = Math.max(1, Math.ceil(w));
    return { n, first: new Float32Array(n), min: new Float32Array(n), max: new Float32Array(n), last: new Float32Array(n) };
  }

  /**
   * 计算 cols 个像素列的统计值, 列 px 覆盖样本 [s0 + px*spp, s0 + (px+1)*spp)。
   * 每列样本数 ≥ 2 个桶时, 列边界对齐到该级桶边界 (误差 < 半个像素), 每列只读整桶 → 每列 O(spp / bs)。
   */
  function columnStats(store, c, s0, s1, cols, buf) {
    const spp = (s1 - s0) / cols;
    const oldest = store.oldest, head = store.head, cap = store.cap;
    const col = store.data[c];
    let lv = null;
    for (let L = store.levels.length - 1; L >= 0; L--) {
      if (store.levels[L].bs * 2 <= spp) { lv = store.levels[L]; break; }
    }
    const bs = lv ? lv.bs : 1;
    const lmin = lv ? lv.min[c] : null, lmax = lv ? lv.max[c] : null, lc = lv ? lv.cap : 0;
    for (let px = 0; px < cols; px++) {
      let a = Math.floor(s0 + px * spp);
      let b = Math.floor(s0 + (px + 1) * spp);
      if (lv) { a = Math.floor(a / bs) * bs; b = Math.floor(b / bs) * bs; }
      const ra = Math.max(a, oldest), rb = Math.min(b, head);
      let mn = Infinity, mx = -Infinity;
      if (rb > ra) {
        if (lv) {
          for (let k = a / bs, ke = b / bs; k < ke; k++) {
            const ka = k * bs, kb = ka + bs;
            if (ka >= oldest && kb <= head) {
              const s = k % lc;
              const x = lmin[s];
              if (x === x) { if (x < mn) mn = x; const y = lmax[s]; if (y > mx) mx = y; }
            } else {
              // 两端部分有效的桶 (被淘汰/尚未写满): 扫描原始数据, 保证不混入失效样本
              for (let i = Math.max(ka, oldest), ie = Math.min(kb, head); i < ie; i++) {
                const v = col[i % cap];
                if (v - v === 0) { if (v < mn) mn = v; if (v > mx) mx = v; }
              }
            }
          }
        } else {
          for (let i = ra; i < rb; i++) {
            const v = col[i % cap];
            if (v - v === 0) { if (v < mn) mn = v; if (v > mx) mx = v; }
          }
        }
      }
      if (mn === Infinity) {
        buf.min[px] = NaN; buf.max[px] = NaN; buf.first[px] = NaN; buf.last[px] = NaN;
      } else {
        buf.min[px] = mn; buf.max[px] = mx;
        const f = col[ra % cap], l = col[(rb - 1) % cap];
        buf.first[px] = f - f === 0 ? f : mn;
        buf.last[px] = l - l === 0 ? l : mx;
      }
    }
    return buf;
  }

  // ===========================================================================
  // 布局
  // ===========================================================================
  /**
   * groups: [{ id, chans: [ch...] }] (已过滤为可见通道), 返回每个子图的矩形 (CSS 像素)。
   * 所有子图共用横轴, 时间刻度标签只画在最下方子图下面。
   */
  function computeLayout(w, h, groups, opt) {
    const o = Object.assign({ padL: 54, padR: 8, padT: 6, padB: 18, gap: 8 }, opt || {});
    const n = Math.max(1, groups.length);
    const avail = Math.max(20, h - o.padT - o.padB - o.gap * (n - 1));
    const ph = avail / n;
    const plots = [];
    for (let k = 0; k < groups.length; k++) {
      const y0 = o.padT + k * (ph + o.gap);
      plots.push({ id: groups[k].id, chans: groups[k].chans, x0: o.padL, x1: Math.max(o.padL + 20, w - o.padR), y0, y1: y0 + ph });
    }
    return plots;
  }

  function plotAt(plots, y) {
    for (let k = 0; k < plots.length; k++) {
      const p = plots[k];
      if (y >= p.y0 - 4 && y <= p.y1 + 4) return k;
    }
    if (!plots.length) return -1;
    return y < plots[0].y0 ? 0 : plots.length - 1;
  }

  // ===========================================================================
  // 渲染器 (三层: 网格层 / 波形层 / 交互层; 坐标统一用 CSS 像素)
  // ===========================================================================
  // 画布配色 (默认深色)。浅色主题由页面通过 setTheme(RTTTheme.canvas()) 覆盖; 本模块不读取 DOM/CSS。
  const THEME = {
    grid: '#1e2430', gridStrong: '#2a3140', zero: '#3a4250', frame: '#30363d',
    text: '#8b949e', textDim: '#6e7681', cursorA: '#ffa657', cursorB: '#d2a8ff', marker: '#e3b341',
    labelBg: 'rgba(13,17,23,0.85)', cursorText: '#0d1117', crosshair: 'rgba(230,237,243,0.45)', dotStroke: '#0d1117',
    overviewBg: 'rgba(22,27,34,0.9)', select: 'rgba(88,166,255,0.15)', selectStroke: 'rgba(88,166,255,0.8)',
    window: 'rgba(88,166,255,0.18)', windowStroke: 'rgba(88,166,255,0.9)',
    font: '11px ui-monospace, Consolas, monospace'
  };

  /** 覆盖画布配色 (只接受已知键, 忽略其他字段) */
  function setTheme(colors) {
    if (!colors) return THEME;
    Object.keys(THEME).forEach(k => { if (k !== 'font' && typeof colors[k] === 'string') THEME[k] = colors[k]; });
    return THEME;
  }

  function clearLayer(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
  }

  /** 网格层: 子图边框、纵轴刻度与数值、零线、时间刻度。frame.plots[k].axis = [lo, hi, step] | null */
  function drawGrid(ctx, frame) {
    const { w, h, plots, xTicks } = frame;
    clearLayer(ctx, w, h);
    ctx.font = THEME.font;
    ctx.lineWidth = 1;
    for (const p of plots) {
      ctx.strokeStyle = THEME.frame;
      ctx.strokeRect(Math.round(p.x0) + 0.5, Math.round(p.y0) + 0.5, Math.round(p.x1 - p.x0) - 1, Math.round(p.y1 - p.y0) - 1);
      // 竖向时间网格
      ctx.strokeStyle = THEME.grid;
      ctx.beginPath();
      for (const t of xTicks) {
        if (t.x <= p.x0 + 1 || t.x >= p.x1 - 1) continue;
        const x = Math.round(t.x) + 0.5;
        ctx.moveTo(x, p.y0); ctx.lineTo(x, p.y1);
      }
      ctx.stroke();
      // 横向数值网格: 线间距按子图像素高度自适应 (约每 32px 一条), 分图时子图矮也不会挤成一团
      const ax = p.axis;
      ctx.fillStyle = THEME.text;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      const gstep = ax ? niceStep(ax[1] - ax[0], Math.max(2, Math.floor((p.y1 - p.y0) / 32))) : 0;
      if (ax && gstep > 0 && (ax[1] - ax[0]) / gstep < 40) {
        const Y = v => p.y1 - (v - ax[0]) / (ax[1] - ax[0]) * (p.y1 - p.y0);
        ctx.beginPath();
        ctx.strokeStyle = THEME.grid;
        const first = Math.ceil(ax[0] / gstep - 1e-9) * gstep;
        for (let v = first, n = 0; v <= ax[1] + gstep * 1e-6 && n < 40; v += gstep, n++) {
          const y = Math.round(Y(v)) + 0.5;
          if (y > p.y0 + 1 && y < p.y1 - 1) { ctx.moveTo(p.x0, y); ctx.lineTo(p.x1, y); }
          if (y >= p.y0 - 1 && y <= p.y1 + 1) ctx.fillText(fmtNum(v, gstep), p.x0 - 4, Math.min(p.y1 - 5, Math.max(p.y0 + 5, y)));
        }
        ctx.stroke();
        if (ax[0] < 0 && ax[1] > 0) {
          const y = Math.round(Y(0)) + 0.5;
          ctx.strokeStyle = THEME.zero;
          ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(p.x0, y); ctx.lineTo(p.x1, y); ctx.stroke();
          ctx.setLineDash([]);
        }
      } else {
        // 各自归一化 (非默认): 等分 4 格, 数值见图例/十字光标; 幅值比例不真实, 故在轴上明确标注
        ctx.beginPath();
        ctx.strokeStyle = THEME.grid;
        for (let k = 1; k < 4; k++) {
          const y = Math.round(p.y0 + (p.y1 - p.y0) * k / 4) + 0.5;
          ctx.moveTo(p.x0, y); ctx.lineTo(p.x1, y);
        }
        ctx.stroke();
        ctx.save();
        ctx.translate(p.x0 - 6, (p.y0 + p.y1) / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.fillStyle = THEME.textDim;
        ctx.fillText('各自归一化 (幅值不按真实比例)', 0, 0);
        ctx.restore();
      }
    }
    // 时间刻度标签 (最下方子图下面)
    const last = plots[plots.length - 1];
    if (last) {
      ctx.fillStyle = THEME.text;
      ctx.textBaseline = 'top';
      for (const t of xTicks) {
        if (t.x < last.x0 - 1 || t.x > last.x1 + 1) continue;
        ctx.textAlign = t.x > last.x1 - 30 ? 'right' : (t.x < last.x0 + 30 ? 'left' : 'center');
        ctx.fillText(t.text, t.x, last.y1 + 3);
      }
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  /**
   * 波形层: 每个通道一次 stroke(); 每像素列最多 4 个顶点 (M4), 放大到单个样本可见时画采样点。
   * frame.plots[k].ranges[ch] = [lo, hi]; 返回本帧绘制的顶点数 (用于性能显示)。
   */
  function drawTraces(ctx, frame) {
    const { w, h, plots, store, view, colors } = frame;
    clearLayer(ctx, w, h);
    if (!store || !(view.i1 > view.i0)) return 0;
    let vertices = 0;
    const span = view.i1 - view.i0;
    for (const p of plots) {
      const pw = p.x1 - p.x0, ph = p.y1 - p.y0;
      if (pw < 2 || ph < 2) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(p.x0, p.y0, pw, ph);
      ctx.clip();
      const spp = span / pw;
      for (const c of p.chans) {
        const r = p.ranges[c];
        if (!r || !(r[1] > r[0]) || c >= store.nch) continue;
        const k = ph / (r[1] - r[0]);
        const lo = r[0], yb = p.y1;
        ctx.strokeStyle = colors[c % colors.length];
        ctx.lineWidth = frame.lineWidth || 1.5;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        let pen = false;
        if (spp <= 2) {
          const a = Math.max(store.oldest, Math.floor(view.i0) - 1);
          const b = Math.min(store.head, Math.ceil(view.i1) + 2);
          const pxPer = pw / span;
          for (let i = a; i < b; i++) {
            const v = store.get(c, i);
            if (v - v !== 0) { pen = false; continue; }
            const x = p.x0 + (i - view.i0) * pxPer, y = yb - (v - lo) * k;
            if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
            vertices++;
          }
          ctx.stroke();
          if (pxPer >= 8) {   // 放大到每个样本间隔 ≥ 8px: 画出采样点, 便于看清离散采样
            ctx.fillStyle = colors[c % colors.length];
            ctx.beginPath();
            for (let i = a; i < b; i++) {
              const v = store.get(c, i);
              if (v - v !== 0) continue;
              const x = p.x0 + (i - view.i0) * pxPer, y = yb - (v - lo) * k;
              ctx.moveTo(x + 2.2, y); ctx.arc(x, y, 2.2, 0, Math.PI * 2);
            }
            ctx.fill();
          }
        } else {
          const cols = Math.max(1, Math.ceil(pw));
          if (!frame.colBuf || frame.colBuf.n < cols) frame.colBuf = makeColumnBuffers(cols);
          const cb = columnStats(store, c, view.i0, view.i1, cols, frame.colBuf);
          for (let px = 0; px < cols; px++) {
            const mn = cb.min[px];
            if (mn !== mn) { pen = false; continue; }
            const x = p.x0 + px + 0.5;
            const yf = yb - (cb.first[px] - lo) * k;
            if (pen) ctx.lineTo(x, yf); else { ctx.moveTo(x, yf); pen = true; }
            ctx.lineTo(x, yb - (mn - lo) * k);
            ctx.lineTo(x, yb - (cb.max[px] - lo) * k);
            ctx.lineTo(x, yb - (cb.last[px] - lo) * k);
            vertices += 4;
          }
          ctx.stroke();
        }
      }
      ctx.restore();
    }
    drawAnnotations(ctx, frame);
    return vertices;
  }

  /** 参数修改标注 + A/B 光标 (随数据移动, 因此画在波形层) */
  function drawAnnotations(ctx, frame) {
    const { plots, view } = frame;
    if (!plots.length) return;
    const top = plots[0].y0, bottom = plots[plots.length - 1].y1;
    const x0 = plots[0].x0, x1 = plots[0].x1;
    const xOf = i => x0 + (i - view.i0) / (view.i1 - view.i0) * (x1 - x0);
    ctx.font = THEME.font;
    ctx.textBaseline = 'top';
    if (frame.markers && frame.markers.length) {
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      let lastLabelX = -1e9, row = 0;
      for (const m of frame.markers) {
        if (m.idx < view.i0 || m.idx > view.i1) continue;
        const x = Math.round(xOf(m.idx)) + 0.5;
        ctx.strokeStyle = THEME.marker;
        ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
        row = (x - lastLabelX < 110) ? (row + 1) % 3 : 0;
        lastLabelX = x;
        const tw = ctx.measureText(m.text).width + 6;
        const lx = Math.min(x + 2, x1 - tw);
        const ly = top + 2 + row * 14;
        ctx.fillStyle = THEME.labelBg;
        ctx.fillRect(lx, ly, tw, 13);
        ctx.fillStyle = THEME.marker;
        ctx.fillText(m.text, lx + 3, ly + 1);
      }
      ctx.setLineDash([]);
    }
    const cur = frame.cursors || {};
    [['a', THEME.cursorA, 'A'], ['b', THEME.cursorB, 'B']].forEach(([k, col, label]) => {
      const i = cur[k];
      if (i === null || i === undefined || i < view.i0 || i > view.i1) return;
      const x = Math.round(xOf(i)) + 0.5;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
      ctx.fillStyle = col;
      ctx.fillRect(x - 7, bottom - 14, 14, 14);
      ctx.fillStyle = THEME.cursorText;
      ctx.textAlign = 'center';
      ctx.fillText(label, x, bottom - 13);
      ctx.textAlign = 'left';
    });
    ctx.textBaseline = 'alphabetic';
  }

  /** 交互层: 十字光标 + 各通道取值点 + 框选矩形 */
  function drawOverlay(ctx, frame, hover, select) {
    const { w, h, plots } = frame;
    clearLayer(ctx, w, h);
    if (select && plots.length) {
      const top = plots[0].y0, bottom = plots[plots.length - 1].y1;
      const xa = Math.min(select.x0, select.x1), xb = Math.max(select.x0, select.x1);
      ctx.fillStyle = THEME.select;
      ctx.fillRect(xa, top, xb - xa, bottom - top);
      ctx.strokeStyle = THEME.selectStroke;
      ctx.strokeRect(xa + 0.5, top + 0.5, xb - xa, bottom - top);
    }
    if (!hover || !plots.length) return;
    const p0 = plots[0];
    if (hover.x < p0.x0 || hover.x > p0.x1) return;
    const top = p0.y0, bottom = plots[plots.length - 1].y1;
    const x = Math.round(hover.sx !== undefined ? hover.sx : hover.x) + 0.5;
    ctx.strokeStyle = THEME.crosshair;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
    if (hover.y >= top && hover.y <= bottom) {
      ctx.beginPath(); ctx.moveTo(p0.x0, Math.round(hover.y) + 0.5); ctx.lineTo(p0.x1, Math.round(hover.y) + 0.5); ctx.stroke();
    }
    ctx.setLineDash([]);
    if (hover.points) {
      for (const pt of hover.points) {
        if (!isFin(pt.y)) continue;
        ctx.fillStyle = pt.color;
        ctx.beginPath(); ctx.arc(x - 0.5, pt.y, 3.2, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = THEME.dotStroke;
        ctx.stroke();
      }
    }
  }

  /** 概览条: 全部历史 (各通道按自身范围归一化) + 当前视窗框 */
  function drawOverview(ctx, o) {
    const { w, h, store, chans, colors, view } = o;
    clearLayer(ctx, w, h);
    ctx.fillStyle = THEME.overviewBg;
    ctx.fillRect(0, 0, w, h);
    if (!store || store.count < 2) return null;
    const a = store.oldest, b = store.head;
    const x0 = o.x0 || 0, x1 = o.x1 || w;
    const pw = x1 - x0;
    const cols = Math.max(1, Math.ceil(pw));
    if (!o.colBuf || o.colBuf.n < cols) o.colBuf = makeColumnBuffers(cols);
    const mm = [NaN, NaN];
    for (const c of chans) {
      if (c >= store.nch) continue;
      store.rangeMinMax(c, a, b, mm);
      if (!isFin(mm[0])) continue;
      const lo = mm[0], hi = mm[1] > mm[0] ? mm[1] : mm[0] + 1;
      const Y = v => h - 3 - (v - lo) / (hi - lo) * (h - 6);
      const cb = columnStats(store, c, a, b, cols, o.colBuf);
      ctx.strokeStyle = colors[c % colors.length];
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1;
      ctx.beginPath();
      let pen = false;
      for (let px = 0; px < cols; px++) {
        const mn = cb.min[px];
        if (mn !== mn) { pen = false; continue; }
        const x = x0 + px + 0.5;
        if (pen) ctx.lineTo(x, Y(mn)); else { ctx.moveTo(x, Y(mn)); pen = true; }
        ctx.lineTo(x, Y(cb.max[px]));
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const xa = x0 + (Math.max(view.i0, a) - a) / (b - a) * pw;
    const xb = x0 + (Math.min(view.i1, b) - a) / (b - a) * pw;
    const rx = Math.min(xa, x1 - 4), rw = Math.max(4, xb - xa);
    ctx.fillStyle = THEME.window;
    ctx.fillRect(rx, 0, rw, h);
    ctx.strokeStyle = THEME.windowStroke;
    ctx.lineWidth = 1;
    ctx.strokeRect(rx + 0.5, 0.5, rw - 1, h - 1);
    return { x0, x1, a, b, xa: rx, xb: rx + rw };
  }

  return {
    PYR_FACTOR, PYR_LEVELS, MEM_FACTOR, MIN_CAPACITY, WAVE_BIN_HEADER, THEME, setTheme,
    isFin, WaveStore, planCapacity, TimeAxis,
    niceStep, niceRange, stabilizeRange, applyYView, stepDecimals, fmtNum, fmtTime, timeTicks,
    decodeWaveBinary, encodeWaveBinary,
    makeColumnBuffers, columnStats, computeLayout, plotAt,
    drawGrid, drawTraces, drawAnnotations, drawOverlay, drawOverview
  };
});
