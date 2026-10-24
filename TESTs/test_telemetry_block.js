// Behavioural test for the telemetry block in web/app.js (runs the real code, stub DOM).
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const s = src.indexOf('  // ================= 实时遥测数据监控看板');
const e = src.indexOf('  function startRenderLoop() {');
if (s < 0 || e < 0) throw new Error('markers not found');
const block = src.slice(s, e);

// ---- minimal DOM stub ----
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.className = ''; this._text = ''; this.dataset = {}; this.title = '';
    this.classList = { set: new Set(), toggle: (c, on) => on ? this.classList.set.add(c) : this.classList.set.delete(c),
      remove: c => this.classList.set.delete(c), add: c => this.classList.set.add(c), contains: c => this.classList.set.has(c) }; }
  set textContent(v) { this._text = String(v); } get textContent() { return this._text; }
  set innerHTML(v) { this._html = v; this.children = []; } get innerHTML() { return this._html || ''; }
  append(...c) { this.children.push(...c); } appendChild(c) { this.children.push(c); }
  addEventListener() {}
  querySelector() { return null; }
}
const grid = new El('div'); grid._html = '<div id="tele-empty-hint">hint</div>';
const timers = [];
const ctx = {
  els: { telemetryGrid: grid, teleRateBadge: new El('span'), btnClearTele: { addEventListener() {} } },
  isConnected: true,
  telemetryHistory: { target: new Array(100).fill(0), actual: new Array(100).fill(0) },
  document: { createElement: t => new El(t) },
  performance, setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {}, setInterval() {},
};
const api = new Function(...Object.keys(ctx), block +
  '\nreturn { setupTelemetryDashboard, resetTelemetryDashboard, handleTelemetry, detectMetricMeta, teleMetrics, waveSrc };')(...Object.values(ctx));
const flush = () => { while (timers.length) timers.shift()(); };
let fails = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`); if (!cond) fails++; };

api.setupTelemetryDashboard();

// 1. alias collision: actual must not be overwritten by v_out in the same frame
api.handleTelemetry('target=1500.0,actual=1498.2,v_out=12.05');
check('waveform actual keeps actual (not v_out)', ctx.telemetryHistory.actual.at(-1) === 1498.2, String(ctx.telemetryHistory.actual.at(-1)));
// 2. source lock: a later frame carrying only v_out must not inject into the actual trace
api.handleTelemetry('v_out=12.10,i_out=1.8');
check('waveform locked to actual; v_out-only frame ignored', ctx.telemetryHistory.actual.at(-1) === 1498.2);

// 3. unit rules
const m = (k, v = '1.0') => api.detectMetricMeta(k, v).unit;
const cases = [['v_out','V'],['i_out','A'],['p_out','W'],['temp','℃'],['i_c','A'],['v_a','V'],['t_ms','ms'],
  ['pin_state','-'],['icon','-'],['speed','-'],['speed_rpm','RPM'],['vel_rads','rad/s'],['pos','-'],['pos_deg','°'],
  ['v_ref_mv','mV'],['target','-'],['pid_kp','-'],['err','STATE']];
for (const [k, u] of cases) check(`unit ${k}`, m(k) === u, m(k));
check('non-numeric value -> STATE', m('cvcc', 'CV') === 'STATE');
check('"12V" treated as non-numeric', m('x', '12V') === 'STATE');

// 4. injection: markup in key is rejected, markup in value is stored as text only
api.handleTelemetry('<img src=x onerror=alert(1)>=1,note=<b>hi</b>');
flush();
check('malformed key rejected', !api.teleMetrics.has('<img src=x onerror=alert(1)>'));
const note = api.teleMetrics.get('note');
check('value rendered via textContent only', note && note.valEl.textContent === '<b>hi</b>' && !note.valEl._html);

// 5. throttled render + delta precision
api.handleTelemetry('v_out=12.00'); api.handleTelemetry('v_out=12.01'); flush();
api.handleTelemetry('v_out=12.02'); flush();
check('delta formatted to reported precision', api.teleMetrics.get('v_out').deltaEl.textContent === 'Δ +0.01', api.teleMetrics.get('v_out').deltaEl.textContent);

// 6. metric cap
for (let i = 0; i < 50; i++) api.handleTelemetry(`k${i}=${i}`);
flush();
check('metric count capped at 32', api.teleMetrics.size === 32, String(api.teleMetrics.size));

// 7. reset unlocks waveform source
api.resetTelemetryDashboard();
check('reset clears metrics and wave lock', api.teleMetrics.size === 0 && api.waveSrc.actual === null);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails ? 1 : 0);
