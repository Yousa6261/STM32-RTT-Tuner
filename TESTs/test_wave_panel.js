// Node harness: extract the Ch1 wave module from app.js and exercise it with stub DOM/canvas.
const fs = require('fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const a = src.indexOf('// ================= Ch1 JustFloat 波形');
const b = src.indexOf('// ================= 终端输出与交互');
if (a < 0 || b < 0) { console.log('FAIL extract'); process.exit(1); }
const code = src.slice(a, b);

let pass = 0, fail = 0;
const check = (n, c, i = '') => { if (c) { pass++; console.log('PASS ', n); } else { fail++; console.log('FAIL ', n, i); } };

function mkEl(tag) {
  const el = {
    tag, children: [], className: '', textContent: '', title: '', style: {}, listeners: {},
    classList: { _s: new Set(), toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, add(c) { this._s.add(c); } },
    append(...k) { this.children.push(...k); }, appendChild(k) { this.children.push(k); },
    addEventListener(ev, fn) { this.listeners[ev] = fn; },
    getBoundingClientRect() { return { width: 600 }; },
  };
  Object.defineProperty(el, 'textContent', { get() { return this._t || ''; }, set(v) { this._t = String(v); if (v === '') this.children = []; } });
  return el;
}
const ops = { lineTo: 0, moveTo: 0, stroke: 0, fillText: [] };
const ctx = new Proxy({}, { get(t, p) {
  if (p === 'fillText') return (s) => ops.fillText.push(s);
  if (p in ops) return () => { ops[p]++; };
  return t[p] !== undefined ? t[p] : () => {};
}, set(t, p, v) { t[p] = v; return true; } });
const canvas = mkEl('canvas'); canvas.getContext = () => ctx; canvas.parentElement = mkEl('div'); canvas.width = 540; canvas.height = 220;
const nodes = { waveCanvas: canvas, 'wave-info': mkEl('span'), 'wave-legend': mkEl('div'), 'wave-window': mkEl('select'), 'btn-wave-pause': mkEl('button'), 'wave-scale': mkEl('select') };
nodes['wave-scale'].value = 'per';
nodes['wave-window'].value = '2';
const store = {};
const rafQueue = [];
const sandbox = {
  document: { getElementById: id => nodes[id] || null, createElement: mkEl },
  window: { addEventListener() {}, prompt: () => 'Vbus' },
  localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } },
  performance: { now: () => Date.now() + Math.random() * 1000 },
  requestAnimationFrame: fn => rafQueue.push(fn),
  els: {},
  pushCh1ToDashboard: () => {},
  syncCh1Keys: () => {},
  flushTelemetryRender: () => {},
};
const fn = new Function(...Object.keys(sandbox), code + '\nreturn { setupWavePanel, handleWave, drawWave, wave };');
const m = fn(...Object.values(sandbox));

m.setupWavePanel();
check('setup: canvas resized', canvas.width === 576, canvas.width);
check('setup: raf scheduled', rafQueue.length === 1);

// feed 3 channels, 2 s at 500 fps in 50-frame batches
for (let k = 0; k < 20; k++) {
  const frames = [];
  for (let j = 0; j < 50; j++) { const t = (k * 50 + j) * Math.PI / 180; frames.push([Math.sin(t), Math.cos(t), 1500]); }
  m.handleWave({ type: 'wave', nch: 3, frames, fps: 500, decim: 1, resync: 0 });
}
check('data: 3 channels, 1000 samples', m.wave.nch === 3 && m.wave.ch[0].length === 1000, m.wave.ch[0].length);
check('legend: 3 items', nodes['wave-legend'].children.length === 3, nodes['wave-legend'].children.length);
check('info badge text', /500 帧\/s · 3 通道 · 重同步 0/.test(nodes['wave-info'].textContent), nodes['wave-info'].textContent);

// null (NaN from gateway) handled
m.handleWave({ nch: 3, frames: [[null, 0.5, 1500]], fps: 500, decim: 1, resync: 2 });
check('null -> NaN stored', Number.isNaN(m.wave.ch[0][m.wave.ch[0].length - 1]));

// draw (min-max path because 1000 samples > 576 px)
rafQueue.shift()();
check('draw: strokes for 3 visible channels', ops.stroke >= 3, ops.stroke);
check('draw: per-channel mode label', ops.fillText.some(t => t.includes('分通道缩放')), ops.fillText);
nodes['wave-scale'].value = 'shared'; nodes['wave-scale'].listeners.change(); ops.fillText.length = 0; m.drawWave();
check('shared mode: numeric axis labels', ops.fillText.length === 3 && !ops.fillText.some(t => t.includes('分通道')), ops.fillText);
nodes['wave-scale'].value = 'per'; nodes['wave-scale'].listeners.change();
const ys = []; const origLine = ctx.lineTo;

// hide channel, rename channel
const item0 = nodes['wave-legend'].children[0];
item0.children[0].listeners.click();
check('toggle visibility', m.wave.visible[0] === false && item0.classList._s.has('wave-hidden'));
item0.children[1].listeners.click();
check('rename persisted', m.wave.names[0] === 'Vbus' && JSON.parse(store.ch1WaveNames)[0] === 'Vbus');

// channel count change -> rebuild
m.handleWave({ nch: 2, frames: [[1, 2]], fps: 100, decim: 1, resync: 0 });
check('nch change rebuilds', m.wave.nch === 2 && nodes['wave-legend'].children.length === 2 && m.wave.ch[0].length === 1);

// trimming
const big = []; for (let j = 0; j < 23000; j++) big.push([j, -j]);
m.handleWave({ nch: 2, frames: big, fps: 5000, decim: 1, resync: 0 });
check('history trimmed to 20000', m.wave.ch[0].length === 20000 && m.wave.ch[0][19999] === 22999, m.wave.ch[0].length);

// malformed input ignored
m.handleWave({ nch: 99, frames: [[1]] });
m.handleWave({ nch: 2, frames: 'x' });
check('malformed ignored', m.wave.nch === 2);

// pause stops drawing
nodes['btn-wave-pause'].listeners.click();
const before = ops.stroke; m.drawWave();
check('pause freezes canvas', ops.stroke === before && nodes['btn-wave-pause'].textContent === '继续');
nodes['btn-wave-pause'].listeners.click();

// displayRate: small jitter tracked slowly (EMA), large change needs 3 consecutive messages
m.handleWave({ nch: 2, frames: [[1, 2], [3, 4]], fps: 250, decim: 1, resync: 0 });
m.wave.displayRate = 250; m.wave.rateJumpCount = 0;
m.handleWave({ nch: 2, frames: [[1, 2]], fps: 270, decim: 1, resync: 0 }); // +8% jitter
check('small jitter moves displayRate only slightly (EMA)', m.wave.displayRate > 250 && m.wave.displayRate <= 252.1, m.wave.displayRate);
for (let k = 0; k < 60; k++) m.handleWave({ nch: 2, frames: [[1, 2]], fps: 227, decim: 1, resync: 0 }); // wave_div 10->11 style -9%
check('persistent small change is eventually tracked (no permanent deadband error)', Math.abs(m.wave.displayRate - 227) < 2, m.wave.displayRate);
m.wave.displayRate = 250;
m.handleWave({ nch: 2, frames: [[1, 2]], fps: 1000, decim: 2, resync: 0 }); // single decimated outlier (500/s)
check('single outlier message does not jump displayRate', m.wave.displayRate === 250, m.wave.displayRate);
m.handleWave({ nch: 2, frames: [[1, 2]], fps: 250, decim: 1, resync: 0 });
for (let k = 0; k < 3; k++) m.handleWave({ nch: 2, frames: [[1, 2]], fps: 100, decim: 1, resync: 0 });
check('large change (wave_div) switches after 3 consecutive messages', m.wave.displayRate === 100, m.wave.displayRate);

// smooth playhead: advances a bit each 60Hz frame instead of jumping to the newest sample
m.wave.displayRate = 250; m.wave.fps = 250;
m.drawWave(1000);
const burst = Array.from({ length: 30 }, (_, k) => [k, -k]);
m.handleWave({ nch: 2, frames: burst, fps: 250, decim: 1, resync: 0 });
const len = m.wave.ch[0].length;
m.wave.playhead = len - 30 - 0.15 * 250;   // steady-state lag before burst
const p0 = m.wave.playhead;
m.drawWave(1016.7); const p1 = m.wave.playhead;
m.drawWave(1033.3); const p2 = m.wave.playhead;
check('playhead advances smoothly (no jump to newest)', p1 > p0 && p2 > p1 && p2 - p0 < 20, `${p0} -> ${p1} -> ${p2}`);
m.wave.playhead = len - 250;                 // 1 s backlog (e.g. after pause) -> reset to LAG behind newest
m.drawWave(1050);
check('large backlog resets to ~0.15s lag', Math.abs((len - m.wave.playhead) - 37.5) < 1, len - m.wave.playhead);
m.wave.playhead = len; m.drawWave(1066.7);
check('playhead never passes newest sample', m.wave.playhead <= len);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
