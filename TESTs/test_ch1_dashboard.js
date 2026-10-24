// Node harness: dashboard + Ch1 wave sections together; checks that Ch1 JustFloat values reach the dashboard.
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const a = src.indexOf('// ================= 实时遥测数据监控看板');
const b = src.indexOf('// ================= 终端输出与交互');
if (a < 0 || b < 0) { console.log('FAIL extract'); process.exit(1); }
const code = src.slice(a, b);

let pass = 0, fail = 0;
const check = (n, c, i = '') => { if (c) { pass++; console.log('PASS ', n); } else { fail++; console.log('FAIL ', n, i); } };

function mkEl(tag) {
  const el = {
    tag, children: [], className: '', title: '', style: {}, listeners: {}, dataset: {}, parent: null,
    classList: { _s: new Set(), toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, has(c) { return this._s.has(c); } },
    append(...k) { k.forEach(x => { x.parent = this; }); this.children.push(...k); },
    appendChild(k) { k.parent = this; this.children.push(k); },
    remove() { if (this.parent) { const i = this.parent.children.indexOf(this); if (i >= 0) this.parent.children.splice(i, 1); this.parent = null; } },
    addEventListener(ev, fn) { this.listeners[ev] = fn; },
    getBoundingClientRect() { return { width: 600 }; },
    querySelector() { return null; },
  };
  Object.defineProperty(el, 'textContent', { get() { return this._t || ''; }, set(v) { this._t = String(v); if (v === '') this.children = []; } });
  Object.defineProperty(el, 'innerHTML', { get() { return this._h || ''; }, set(v) { this._h = String(v); this.children = []; } });
  return el;
}
const ctx = new Proxy({}, { get(t, p) { return t[p] !== undefined ? t[p] : () => {}; }, set(t, p, v) { t[p] = v; return true; } });
const canvas = mkEl('canvas'); canvas.getContext = () => ctx; canvas.parentElement = mkEl('div');
const nodes = { waveCanvas: canvas, 'wave-info': mkEl('span'), 'wave-legend': mkEl('div'), 'wave-window': mkEl('select'),
  'btn-wave-pause': mkEl('button'), 'wave-scale': mkEl('select') };
nodes['wave-window'].value = '2'; nodes['wave-scale'].value = 'per';
let clock = 1000;
const timers = [];
let intervalFn = null;
const grid = mkEl('div');
const badge = mkEl('span');
let nextPrompt = 'v_out';
const sandbox = {
  document: { getElementById: id => nodes[id] || null, createElement: mkEl },
  window: { addEventListener() {}, prompt: () => nextPrompt },
  localStorage: { getItem: () => null, setItem() {} },
  performance: { now: () => clock },
  requestAnimationFrame: () => {},
  setTimeout: (fn) => { timers.push(fn); return timers.length; },
  clearTimeout: () => {},
  setInterval: (fn) => { intervalFn = fn; return 1; },
  els: { telemetryGrid: grid, teleRateBadge: badge, btnClearTele: null, canvas },
  telemetryHistory: { target: new Array(100).fill(0), actual: new Array(100).fill(0) },
  MAX_HISTORY: 100,
  isConnected: true,
  ctx,
};
const fn = new Function(...Object.keys(sandbox), code + '\nreturn { setupWavePanel, setupTelemetryDashboard, handleWave, handleTelemetry, detectMetricMeta, wave, teleMetrics: () => teleMetrics, getFrameCount: () => teleFrameCount, waveNameToKey };');
const m = fn(...Object.values(sandbox));
m.setupTelemetryDashboard();
m.setupWavePanel();
const runTimers = () => { while (timers.length) timers.shift()(); };
const tile = k => m.teleMetrics().get(k);
const unitOf = k => tile(k).tile.children[0].children[1].textContent;
const nameElOf = k => tile(k).tile.children[0].children[0];

m.handleWave({ nch: 3, frames: [[0.5, -0.5, 1500]], fps: 250, decim: 1, resync: 0 });
runTimers();
const keys = [...m.teleMetrics().keys()];
check('Ch1 channels appear as dashboard tiles', keys.join(',') === 'CH0,CH1,CH2', keys);
check('tile value from latest frame', tile('CH2').valEl.textContent === '1500', tile('CH2').valEl.textContent);
check('Ch1 does not inflate $DATA frame counter', m.getFrameCount() === 0, m.getFrameCount());
check('Ch1 tiles marked renamable', nameElOf('CH0').classList.has('tele-name-renamable'));

// throttle: a second batch within 100 ms is not pushed; after 100 ms it is
m.handleWave({ nch: 3, frames: [[0.6, -0.4, 1400]], fps: 250, decim: 1, resync: 0 });
runTimers();
check('10 Hz throttle', tile('CH2').valEl.textContent === '1500');
clock += 150;
m.handleWave({ nch: 3, frames: [[0.7, -0.3, 1300]], fps: 250, decim: 1, resync: 0 });
runTimers();
check('updates after throttle window', tile('CH2').valEl.textContent === '1300');

// rename via legend: old tile removed immediately (DOM too), new tile shows value at once, unit inferred
nextPrompt = 'v_out';
nodes['wave-legend'].children[0].children[1].listeners.click();
check('old CH0 tile removed (map)', !m.teleMetrics().has('CH0'));
check('old CH0 tile removed (DOM)', !grid.children.some(t => t.dataset.key === 'CH0'));
check('renamed channel shows value immediately', !!tile('v_out') && tile('v_out').valEl.textContent === '0.7');
check('unit inference applies to renamed key (V)', unitOf('v_out') === 'V');
const chartBefore = sandbox.telemetryHistory.actual.slice(-3).join();
clock += 150; m.handleWave({ nch: 3, frames: [[12.5, 0, 1300]], fps: 250, decim: 1, resync: 0 }); runTimers();
check('Ch1 named v_out does NOT feed the Ch0 chart', sandbox.telemetryHistory.actual.slice(-3).join() === chartBefore);

// rename via dashboard tile header -> Chinese name
nextPrompt = '目标转速';
nameElOf('CH2').listeners.click();
check('tile header click renames CH2 -> 目标转速', !m.teleMetrics().has('CH2') && m.teleMetrics().has('目标转速'));
check('目标转速 infers RPM', unitOf('目标转速') === 'RPM');
check('legend synced', nodes['wave-legend'].children[2].children[1].textContent === '目标转速');

// duplicate names: suffix tile is cleaned up when the duplicate goes away
nextPrompt = 'v_out';
nodes['wave-legend'].children[1].children[1].listeners.click();   // CH1 -> v_out (duplicate)
check('duplicate name gets suffixed key', m.teleMetrics().has('v_out_1') && tile('v_out').valEl.textContent === '12.5');
nextPrompt = '';
nodes['wave-legend'].children[0].children[1].listeners.click();   // CH0 -> back to default
check('empty name restores CH0', m.wave.names[0] === 'CH0' && m.teleMetrics().has('CH0'));
check('suffix tile v_out_1 removed, CH1 now plain v_out', !m.teleMetrics().has('v_out_1') && m.teleMetrics().has('v_out'));

// non-finite values are not sent (keep last value, no NaN string, tile type stays numeric)
clock += 150; m.handleWave({ nch: 3, frames: [[null, 3, 1300]], fps: 250, decim: 1, resync: 0 }); runTimers();
check('null value keeps previous reading (no "NaN")', tile('CH0').valEl.textContent === '12.5', tile('CH0').valEl.textContent);

// $DATA still works, counts, and its tiles are not renamable
m.handleTelemetry('temp=38.5,mode=CV');
runTimers();
check('$DATA path still works', m.teleMetrics().has('temp') && m.getFrameCount() === 1);
check('$DATA tile not marked renamable', !nameElOf('temp').classList.has('tele-name-renamable'));
nameElOf('temp').listeners.click();   // must be a no-op
check('clicking $DATA tile does nothing', m.wave.names.join() === 'CH0,v_out,目标转速', m.wave.names.join());

// channel count shrink removes tiles of vanished channels
m.wave.names.length = 0;
clock += 150; m.handleWave({ nch: 2, frames: [[1, 2]], fps: 250, decim: 1, resync: 0 }); runTimers();
check('nch shrink removes vanished channel tile', !m.teleMetrics().has('目标转速') && !m.teleMetrics().has('CH2'));

// Chinese unit rules: suffix only
check('母线电压 -> V', m.detectMetricMeta('母线电压', '1').unit === 'V');
check('A相电流 -> A', m.detectMetricMeta('A相电流', '1').unit === 'A');
check('电流环Kp -> no unit (not A)', m.detectMetricMeta('电流环Kp', '1').unit === '-');
check('角速度 -> speed type', m.detectMetricMeta('角速度', '1').type === 'speed');

// badge: Ch1 rate when no $DATA; falls back to 0 after Ch1 goes silent
clock += 600; intervalFn();   // consume the earlier $DATA count window
clock += 10; m.handleWave({ nch: 2, frames: [[1, 2]], fps: 250, decim: 1, resync: 0 });
clock += 600; intervalFn();
check('badge shows Ch1 rate while Ch1 is live', badge.textContent === 'Ch1 250 Hz', badge.textContent);
clock += 3000; intervalFn();
check('badge returns to 0 after Ch1 silent >2s', badge.textContent === '0.0 Hz', badge.textContent);

check('Chinese name kept as key', m.waveNameToKey(' 电压 1 ', 3) === '电压 1');
check('empty name -> CHi', m.waveNameToKey('  ', 1) === 'CH1');
check('long name truncated to 32', m.waveNameToKey('x'.repeat(40), 0).length === 32);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
