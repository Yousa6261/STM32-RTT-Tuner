// Node harness for the v3.1 Ch1 wave controller in app.js (+ wave_core.js):
// live/browse state machine, drag/wheel/box zoom, cursors, markers, clear, layouts, Y modes,
// settings persistence, binary + legacy JSON ingest, capacity planning, export / analysis ranges.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'host', 'web', 'app.js'), 'utf8');
const WC = require(path.join(__dirname, '..', 'host', 'web', 'wave_core.js'));
const a = src.indexOf('// ================= Ch1 JustFloat 波形');
const b = src.indexOf('// ================= 终端输出与交互');
if (a < 0 || b < 0) { console.log('FAIL extract'); process.exit(1); }
const code = src.slice(a, b);

let pass = 0, fail = 0;
const check = (n, c, i = '') => { if (c) { pass++; console.log('PASS ', n); } else { fail++; console.log('FAIL ', n, i); } };

// ------------------------------------------------------------------ DOM stubs
function mkEl(tag) {
  const el = {
    tag, children: [], parentNode: null, className: '', title: '', style: {}, listeners: {}, attrs: {}, value: '', disabled: false, checked: false,
    offsetWidth: 150, options: [],
    classList: {
      _s: new Set(),
      toggle(c, on) { if (on === undefined) on = !this._s.has(c); on ? this._s.add(c) : this._s.delete(c); },
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); }
    },
    append(...k) { k.forEach(x => { x.parentNode = this; this.children.push(x); }); },
    appendChild(k) { k.parentNode = this; this.children.push(k); return k; },
    insertBefore(k, ref) { if (k.parentNode) k.remove(); k.parentNode = this; const i = this.children.indexOf(ref); i < 0 ? this.children.push(k) : this.children.splice(i, 0, k); },
    remove() { if (this.parentNode) { const i = this.parentNode.children.indexOf(this); if (i >= 0) this.parentNode.children.splice(i, 1); this.parentNode = null; } },
    get nextSibling() { if (!this.parentNode) return null; const s = this.parentNode.children; return s[s.indexOf(this) + 1] || null; },
    setAttribute(k, v) { this.attrs[k] = v; },
    querySelector(q) { const m = /\[(.+?)\]/.exec(q); const walk = n => { for (const c of n.children) { if (m && c.attrs[m[1]] !== undefined) return c; const r = walk(c); if (r) return r; } return null; }; return walk(this); },
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    fire(ev, e) { (this.listeners[ev] || []).forEach(fn => fn(Object.assign({ preventDefault() {}, button: 0, clientX: 0, clientY: 0 }, e || {}))); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 240 }; },
  };
  Object.defineProperty(el, 'textContent', { get() { return this._t || ''; }, set(v) { this._t = String(v); if (v === '') this.children = []; } });
  Object.defineProperty(el, 'innerHTML', { get() { return this._h || ''; }, set(v) { this._h = String(v); this.children = []; } });
  return el;
}
const ops = { lineTo: 0, moveTo: 0, stroke: 0, fillText: [], clearRect: 0, setTransform: 0 };
function mkCtx() {
  return new Proxy({}, {
    get(t, p) {
      if (p === 'fillText') return (s) => ops.fillText.push(String(s));
      if (p === 'measureText') return s => ({ width: String(s).length * 6 });
      if (p in ops) return () => { ops[p]++; };
      return t[p] !== undefined ? t[p] : () => {};
    },
    set(t, p, v) { t[p] = v; return true; }
  });
}
const mkCanvas = () => { const c = mkEl('canvas'); const ctx = mkCtx(); c.getContext = () => ctx; return c; };
const ids = ['waveStage', 'waveGrid', 'waveCanvas', 'waveOverlay', 'waveOverview', 'wave-info', 'wave-legend', 'wave-window',
  'wave-layout', 'btn-wave-pause', 'btn-wave-live', 'btn-wave-clear', 'btn-wave-settings', 'wave-settings', 'btn-wave-analyze',
  'btn-wave-csv', 'btn-wave-wide', 'wave-readout', 'wave-tip', 'wave-card', 'capture-card'];
const nodes = {};
ids.forEach(id => { nodes[id] = /^wave(Grid|Canvas|Overlay|Overview)$/.test(id) ? mkCanvas() : mkEl(id); });
nodes['wave-window'].value = '2';
const rightCol = mkEl('section'), main = mkEl('main');
rightCol.append(nodes['wave-card'], mkEl('terminal-card'));
main.append(rightCol, nodes['capture-card']);
let docKey = null;
const store = {};
let clock = 1000;
const rafQueue = [];
const sent = { rtt: [], json: [], log: [] };
const dynamicParams = new Map();
const dash = [];
const sandbox = {
  document: {
    getElementById: id => nodes[id] || null, createElement: mkEl,
    addEventListener(ev, fn) { if (ev === 'keydown') docKey = fn; }, activeElement: null
  },
  window: { addEventListener() {}, prompt: () => 'Vbus', RTTWaveCore: WC, devicePixelRatio: 2 },
  localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } },
  performance: { now: () => clock },
  requestAnimationFrame: fn => rafQueue.push(fn),
  els: {},
  pushCh1ToDashboard: (row) => dash.push(row),
  syncCh1Keys: () => {},
  flushTelemetryRender: () => {},
  logTerminal: (t, s) => sent.log.push(s),
  sendRttCommand: s => sent.rtt.push(s),
  sendJson: o => sent.json.push(o),
  resetTelemetryDashboard: () => { sent.log.push('dash-reset'); },
  dynamicParams,
};
const fn = new Function(...Object.keys(sandbox), code + `
return { setupWavePanel, handleWave, handleWaveBinary, renderWaveFrame, drawWave, wave, waveOnAck, clearWave, exportWaveCsv,
         getCh1Snapshot, maybeResizeStore, toggleWaveSettings, setWaveLayout, buildWaveGroups, waveSubscribe, waveOnConnected,
         loadWaveSettings, updateDisplayRate, undoWaveView, goLive, toggleWavePause, setWaveCursor, setWaveVisible };`);
const m = fn(...Object.values(sandbox));
const W = m.wave;
const ov = nodes.waveOverlay;
const render = (dt = 16.7) => { clock += dt; m.renderWaveFrame(clock); };
const feed = (n, nch = 3, fps = 500, start = 0) => {
  const frames = [];
  for (let j = 0; j < n; j++) { const k = start + j; frames.push([Math.sin(k / 30), Math.cos(k / 30), 1500].slice(0, nch)); }
  m.handleWave({ type: 'wave', nch, frames, fps, decim: 1, resync: 0 });
};

// ------------------------------------------------------------------ 1. setup
m.setupWavePanel();
check('setup: defaults (60 s history, 2 s window, overlay)', W.settings.historySec === 60 && W.settings.windowSec === 2 && W.settings.layout === 'overlay');
check('setup: raf scheduled', rafQueue.length === 1);
check('setup: three layers + overview bound', !!W.layers && !!W.overview && (ov.listeners.pointerdown || []).length === 1 && (ov.listeners.wheel || []).length === 1);
check('setup: keyboard handler registered', typeof docKey === 'function');
m.renderWaveFrame(clock);
check('empty render does not throw, readout shows hint', /等待 Ch1 数据/.test(nodes['wave-readout'].children[0].textContent));

// ------------------------------------------------------------------ 2. ingest (legacy JSON + binary)
for (let k = 0; k < 20; k++) feed(50, 3, 500, k * 50);
check('json: 1000 samples stored in ring buffer', W.store.count === 1000 && W.store.nch === 3, W.store.count);
check('json: legend 3 items', nodes['wave-legend'].children.length === 3);
check('json: info badge', /500 帧\/s · 3 通道 · 重同步 0/.test(nodes['wave-info'].textContent), nodes['wave-info'].textContent);
m.handleWave({ nch: 3, frames: [[null, 0.5, 1500]], fps: 500, decim: 1, resync: 2 });
check('json: null -> NaN stored', Number.isNaN(W.store.get(0, W.store.head - 1)));
check('json: dashboard receives raw last row', dash[dash.length - 1][0] === null);
const bin = WC.encodeWaveBinary([[1, 2, 3], [NaN, 5, 6]], 3, 500, 1, 2);
m.handleWaveBinary(bin);
check('binary: frames appended', W.store.count === 1003 && W.store.get(2, W.store.head - 1) === 6);
check('binary: NaN preserved', Number.isNaN(W.store.get(0, W.store.head - 1)));
check('binary: dashboard gets numeric last row', Array.isArray(dash[dash.length - 1]) && dash[dash.length - 1][2] === 6);
m.handleWaveBinary(new ArrayBuffer(4));
m.handleWave({ nch: 99, frames: [[1]] });
m.handleWave({ nch: 3, frames: 'x' });
check('malformed input ignored', W.nch === 3 && W.store.count === 1003);

// ------------------------------------------------------------------ 3. rendering & dirty logic
render();
check('canvas sized with devicePixelRatio (800 css px x2)', nodes.waveCanvas.width === 1600 && nodes.waveGrid.height === 480 && nodes.waveStage.style.height === '240px', [nodes.waveCanvas.width, nodes.waveGrid.height]);
check('first frame: grid + traces drawn', W.perf.gridDraws === 1 && W.perf.vertices > 0 && W.plots.length === 1);
const span0 = W.lastView.i1 - W.lastView.i0;
check('live view = 2 s x 500 fps = 1000 samples', Math.abs(span0 - 1000) < 1, span0);
const frames0 = W.perf.frames;
render(); render();
check('idle: no redraw when nothing changed (dirty flags)', W.perf.frames === frames0, W.perf.frames - frames0);
feed(10, 3, 500, 2000);
render();
check('live: new data -> redraw, grid NOT redrawn (stable axis + fixed ticks)', W.perf.frames > frames0 && W.perf.gridDraws === 1, [W.perf.frames, W.perf.gridDraws]);

// ------------------------------------------------------------------ 4. pause -> browse (frozen but interactive)
for (let k = 0; k < 30; k++) feed(100, 3, 500, 2010 + k * 100);   // ~8 s of history so panning has room
render();
nodes['btn-wave-pause'].fire('click');
check('pause enters browse mode', W.mode === 'browse' && /实时/.test(nodes['btn-wave-pause'].textContent) && !nodes['btn-wave-live'].classList.contains('hidden'));
render();
const fb = W.perf.frames, vb = Object.assign({}, W.lastView);
feed(200, 3, 500, 3000);
render(); render();
check('browse: new data does not move the view (frozen)', W.perf.frames === fb && W.lastView.i0 === vb.i0, [W.perf.frames - fb]);
check('browse: data still accumulates in background', W.store.head > vb.i1 + 150);

// drag pan
const p0 = W.plots[0];
const spp = (W.lastView.i1 - W.lastView.i0) / (p0.x1 - p0.x0);
ov.fire('pointerdown', { clientX: 400, clientY: 100 });
ov.fire('pointermove', { clientX: 450, clientY: 100 });
ov.fire('pointermove', { clientX: 500, clientY: 100 });
ov.fire('pointerup', { clientX: 500, clientY: 100 });
render();
check('drag right pans back in time by dx x samples/px', Math.abs((vb.i0 - W.lastView.i0) - 100 * spp) < 1, [vb.i0 - W.lastView.i0, 100 * spp]);
check('drag does not place a cursor', W.cursors.a === null);

// click / right-click cursors
ov.fire('pointerdown', { clientX: 300, clientY: 100 });
ov.fire('pointerup', { clientX: 300, clientY: 100 });
ov.fire('contextmenu', { clientX: 600, clientY: 100 });
render();
const ia = W.lastView.i0 + (300 - p0.x0) / (p0.x1 - p0.x0) * (W.lastView.i1 - W.lastView.i0);
check('click places cursor A at sample under pointer', Math.abs(W.cursors.a - Math.round(ia)) <= 1, [W.cursors.a, ia]);
check('right-click places cursor B', W.cursors.b > W.cursors.a);
clock += 200; render();
const ro = nodes['wave-readout'].children[1].textContent;
check('readout shows Δt, 1/Δt and per-channel Δ', /Δt/.test(ro) && /1\/Δt/.test(ro) && /ΔCH0/.test(ro), ro);

// wheel zoom in browse + undo
const before = Object.assign({}, W.lastView);
ov.fire('wheel', { clientX: 400, clientY: 100, deltaY: -100 });
render();
check('wheel in browse zooms around pointer (x0.8)', Math.abs((W.lastView.i1 - W.lastView.i0) / (before.i1 - before.i0) - 0.8) < 1e-6);
m.undoWaveView(); render();
check('Ctrl+Z / undo restores previous view', Math.abs(W.lastView.i0 - before.i0) < 1e-6 && Math.abs(W.lastView.i1 - before.i1) < 1e-6);

// box zoom
ov.fire('pointerdown', { clientX: 200, clientY: 100, ctrlKey: true });
ov.fire('pointermove', { clientX: 260, clientY: 100, ctrlKey: true });
check('ctrl+drag shows selection box', W.select && W.select.x1 === 260);
ov.fire('pointermove', { clientX: 400, clientY: 100, ctrlKey: true });
const ib0 = W.lastView.i0 + (200 - p0.x0) / (p0.x1 - p0.x0) * (W.lastView.i1 - W.lastView.i0);
const ib1 = W.lastView.i0 + (400 - p0.x0) / (p0.x1 - p0.x0) * (W.lastView.i1 - W.lastView.i0);
ov.fire('pointerup', { clientX: 400, clientY: 100 });
render();
check('box zoom sets view to selected range', Math.abs(W.lastView.i0 - ib0) < 1e-6 && Math.abs(W.lastView.i1 - ib1) < 1e-6 && W.select === null);

// shift+wheel -> Y zoom; shift+drag -> Y pan; dblclick -> reset
ov.fire('wheel', { clientX: 400, clientY: 100, deltaY: -100, shiftKey: true });
check('shift+wheel zooms Y of the plot under pointer', Math.abs(W.yView[1].zoom - 1.25) < 1e-9, W.yView[1]);
ov.fire('pointerdown', { clientX: 400, clientY: 100, shiftKey: true });
ov.fire('pointermove', { clientX: 400, clientY: 150, shiftKey: true });
ov.fire('pointerup', { clientX: 400, clientY: 150 });
check('shift+drag pans Y', W.yView[1].pan > 0);
ov.fire('dblclick', { clientX: 400, clientY: 100 });
check('dblclick resets Y view', W.yView[1].zoom === 1 && W.yView[1].pan === 0);

// keyboard
W.hoverStage = true;
docKey({ key: 'Escape', target: {} });
check('Esc clears cursors', W.cursors.a === null && W.cursors.b === null);
docKey({ key: 'End', target: {} });
check('End returns to live', W.mode === 'live' && nodes['btn-wave-live'].classList.contains('hidden'));
docKey({ key: ' ', target: {} });
check('Space toggles pause', W.mode === 'browse');
docKey({ key: ' ', target: { tagName: 'INPUT' } });
check('keys ignored while typing in inputs', W.mode === 'browse');
docKey({ key: ' ', target: {} });
W.hoverStage = false;
docKey({ key: ' ', target: {} });
check('keys ignored when pointer is not over the chart', W.mode === 'live');

// wheel in live -> window size
render();
ov.fire('wheel', { clientX: 400, clientY: 100, deltaY: 100 });
check('wheel in live mode changes the time window (stays live)', W.mode === 'live' && W.settings.windowSec === 2.5, W.settings.windowSec);
check('window select shows custom value', nodes['wave-window'].value === '2.5', nodes['wave-window'].value);
check('setting persisted', JSON.parse(store.ch1WaveSettings).windowSec === 2.5);
nodes['wave-window'].value = '2'; nodes['wave-window'].fire('change');
check('window select change applies', W.settings.windowSec === 2 && !nodes['wave-window'].querySelector('[data-custom]'));

// ------------------------------------------------------------------ 5. hover tooltip
render();
ov.fire('pointermove', { clientX: 500, clientY: 120 });
render();
check('hover: tooltip visible with time + channel values', nodes['wave-tip'].style.display === 'block' && /^t = /.test(nodes['wave-tip'].children[0].textContent)
  && nodes['wave-tip'].children.length === 4 && nodes['wave-tip'].children[1].children[2].textContent !== '', nodes['wave-tip'].children[0].textContent);
ov.fire('pointerleave', {});
render();
check('hover: tooltip hidden on leave', nodes['wave-tip'].style.display === 'none');

// ------------------------------------------------------------------ 6. layouts & Y modes
m.setWaveLayout('split');
render();
check('split: one plot per channel, auto height grows', W.plots.length === 3 && nodes.waveStage.style.height === `${3 * 118 + 24}px`, [W.plots.length, nodes.waveStage.style.height]);
check('split: each single-channel plot has a numeric axis', W.plots.every(p => p.axis && p.axis[1] > p.axis[0]));
m.setWaveLayout('custom');
W.settings.groups = [1, 1, 2];
render();
check('custom groups: CH0+CH1 together, CH2 alone', W.plots.length === 2 && W.plots[0].chans.join() === '0,1' && W.plots[1].chans.join() === '2');
W.settings.yCfg[2] = { mode: 'manual', min: 1000, max: 2000 };
W.settings.yCfg[1] = { mode: 'sym', sym: 0 };
W.dirty = true; render();
check('manual Y range applied', W.plots[1].axis[0] === 1000 && W.plots[1].axis[1] === 2000);
check('symmetric auto Y range', Math.abs(W.plots[0].axis[0] + W.plots[0].axis[1]) < 1e-9 && W.plots[0].axis[1] >= 1);
m.setWaveVisible(2, false); render();
check('hiding a channel removes its subplot', W.plots.length === 1);
m.setWaveVisible(2, true);
m.setWaveLayout('overlay');
W.settings.yCfg = {};
render();
check('overlay: per-channel scaling (no shared numeric axis) by default', W.plots.length === 1 && W.plots[0].axis === null && Object.keys(W.plots[0].ranges).length === 3);

// ------------------------------------------------------------------ 7. ACK markers
m.waveOnAck({ type: 'ack', success: true, param: 'pid_kp', val: '1.0000' });
check('ack: first value only records baseline', W.markers.length === 0);
m.waveOnAck({ type: 'ack', success: true, param: 'pid_kp', val: '1.0000' });
check('ack: unchanged value -> no marker', W.markers.length === 0);
m.waveOnAck({ type: 'ack', success: true, param: 'pid_kp', val: '2.5000' });
check('ack: changed value -> marker "old→new" at newest sample', W.markers.length === 1 && W.markers[0].text === 'pid_kp: 1.0000→2.5000' && W.markers[0].idx === W.store.head - 1, W.markers[0]);
m.waveOnAck({ type: 'ack', success: false, param: 'pid_kp', val: '9' });
check('ack: failed ACK ignored', W.markers.length === 1);

// ------------------------------------------------------------------ 8. export / analysis ranges
const full = m.exportWaveCsv(false);
check('csv: no cursors -> full history', full.rows === W.store.count && full.src === '全部历史' && full.csv.startsWith('index,t_s,"CH0","CH1","CH2"\n'));
const line2 = full.csv.split('\n')[2].split(',');
check('csv: time column from time axis (1/500 s)', Math.abs(Number(line2[1]) - 0.002) < 1e-9, line2);
m.setWaveCursor('a', W.store.head - 300); m.setWaveCursor('b', W.store.head - 100);
const part = m.exportWaveCsv(false);
check('csv: A-B cursor range', part.rows === 201 && part.src === 'A–B 光标区间', [part.rows, part.src]);
const snapAB = m.getCh1Snapshot();
check('analysis: A-B range used', snapAB.channels[0].length === 201 && snapAB.sample_hz === 500, [snapAB.channels[0].length, snapAB.sample_hz]);
W.cursors = { a: null, b: null };
render(16.7);
const snapV = m.getCh1Snapshot();
check('analysis: no cursors -> current view', Math.abs(snapV.channels[0].length - (W.lastView.i1 - Math.max(W.store.oldest, Math.floor(W.lastView.i0)))) <= 1, snapV.channels[0].length);

// ------------------------------------------------------------------ 9. settings panel
m.toggleWaveSettings(true);
const panelText = JSON.stringify(nodes['wave-settings'], (k, v) => (k === 'parentNode' ? undefined : v));
check('settings: panel built with all sections', ['显示与历史', '布局与纵轴', '采样与传输', '选项'].every(s => panelText.includes(s)));
check('settings: wave_div disabled when firmware lacks the parameter', panelText.includes('固件未注册 wave_div'));
dynamicParams.set('wave_div', { name: 'wave_div', min: 1, max: 50, val: 2 });
m.toggleWaveSettings(true);
const findAll = (n, pred, out = []) => { if (pred(n)) out.push(n); n.children.forEach(c => findAll(c, pred, out)); return out; };
const applyBtn = findAll(nodes['wave-settings'], n => n.tag === 'button' && n.textContent === '应用')[0];
const divInput = findAll(nodes['wave-settings'], n => n.tag === 'input' && n.title && n.title.includes('wave_div'))[0];
check('settings: wave_div enabled when registered', applyBtn && !applyBtn.disabled && divInput && divInput.value === '2');
divInput.value = '5';
applyBtn.fire('click');
check('settings: apply sends $SET:wave_div', sent.rtt[sent.rtt.length - 1] === '$SET:wave_div=5', sent.rtt);
const transportSel = findAll(nodes['wave-settings'], n => n.tag === 'select' && n.children.some(o => o.value === 'decim'))[0];
transportSel.value = 'full'; transportSel.fire('change');
check('settings: transport change re-subscribes (full=true)', sent.json.some(o => o.type === 'wave_subscribe' && o.format === 'bin' && o.full === true));
const transportSel2 = findAll(nodes['wave-settings'], n => n.tag === 'select' && n.children.some(o => o.value === 'decim'))[0];
transportSel2.value = 'auto';
transportSel2.fire('change');
check('settings: auto transport omits full flag (gateway decides local/LAN)', (() => { const o = sent.json[sent.json.length - 1]; return o.type === 'wave_subscribe' && !('full' in o); })());
m.toggleWaveSettings(false);
check('settings: close hides panel', nodes['wave-settings'].classList.contains('hidden'));

// ------------------------------------------------------------------ 10. capacity & history
for (let k = 0; k < 40; k++) feed(50, 3, 500, 5000 + k * 50);
clock += 1500;
m.maybeResizeStore(false);
check('capacity follows measured rate (60 s x 500 fps)', Math.abs(W.store.cap - Math.ceil(60 * W.displayRate * 1.15)) <= 2, [W.store.cap, W.displayRate]);
W.settings.historySec = 10; m.maybeResizeStore(true);
check('history 10 s -> capacity shrinks', Math.abs(W.store.cap - Math.ceil(10 * W.displayRate * 1.15)) <= 2 && W.store.count <= W.store.cap, W.store.cap);
check('memory readout data available', W.capInfo && W.capInfo.seconds === 10 && !W.capInfo.limited);
W.settings.historySec = 60; m.maybeResizeStore(true);

// ------------------------------------------------------------------ 11. clear
W.resync = 7;
m.setWaveCursor('a', W.store.head - 10);
m.clearWave(true);
check('clear: buffer, cursors, markers emptied; back to live', W.store.count === 0 && W.cursors.a === null && W.markers.length === 0 && W.mode === 'live');
check('clear: resync counter re-based', /重同步 0/.test(nodes['wave-info'].textContent));
feed(100, 3, 500, 0);
render();
check('clear: time axis restarts at 0', Math.abs(W.axis.timeOf(W.store.oldest)) < 1e-9 && W.store.count === 100);
W.settings.clearOnConnect = true;
m.waveOnConnected();
check('clearOnConnect clears on (re)connect', W.store.count === 0);
W.settings.clearOnConnect = false;

// ------------------------------------------------------------------ 12. overview drag
for (let k = 0; k < 20; k++) feed(100, 3, 500, k * 100);
render(300);   // overview redraw (>250 ms)
check('overview drawn with window rect', W.ovInfo && W.ovInfo.xb > W.ovInfo.xa);
const oc = nodes.waveOverview;
const vBeforeOv = Object.assign({}, W.lastView);
oc.fire('pointerdown', { clientX: W.ovInfo.x0 + 5, clientY: 10 });
render();
check('overview click outside window jumps there (browse)', W.mode === 'browse' && W.lastView.i0 < vBeforeOv.i0);
const vj = Object.assign({}, W.lastView);
oc.fire('pointermove', { clientX: W.ovInfo.x0 + 25, clientY: 10 });
oc.fire('pointerup', {});
render();
check('overview drag pans', W.lastView.i0 > vj.i0);
m.goLive();

// ------------------------------------------------------------------ 13. displayRate smoothing & playhead (FIX-024 semantics preserved)
m.handleWave({ nch: 2, frames: [[1, 2], [3, 4]], fps: 250, decim: 1, resync: 0 });
check('nch change resets store', W.nch === 2 && W.store.nch === 2 && W.store.count === 2);
W.displayRate = 250; W.rateJumpCount = 0;
m.handleWave({ nch: 2, frames: [[1, 2]], fps: 270, decim: 1, resync: 0 });
check('small jitter moves displayRate only slightly (EMA)', W.displayRate > 250 && W.displayRate <= 252.1, W.displayRate);
for (let k = 0; k < 60; k++) m.handleWave({ nch: 2, frames: [[1, 2]], fps: 227, decim: 1, resync: 0 });
check('persistent small change is eventually tracked', Math.abs(W.displayRate - 227) < 2, W.displayRate);
W.displayRate = 250;
m.handleWave({ nch: 2, frames: [[1, 2]], fps: 1000, decim: 2, resync: 0 });
check('single outlier message does not jump displayRate', W.displayRate === 250, W.displayRate);
m.handleWave({ nch: 2, frames: [[1, 2]], fps: 250, decim: 1, resync: 0 });
for (let k = 0; k < 3; k++) m.handleWave({ nch: 2, frames: [[1, 2]], fps: 100, decim: 1, resync: 0 });
check('large change (wave_div) switches after 3 consecutive messages', W.displayRate === 100, W.displayRate);
check('time axis gets a new segment on wave_div change', W.axis.segs.length >= 2 && W.axis.rate === 100, W.axis.segs);

W.displayRate = 250; W.fps = 250; W.axis.setRate(W.store.head, 250);
for (let k = 0; k < 10; k++) m.handleWave({ nch: 2, frames: Array.from({ length: 30 }, (_, j) => [j, -j]), fps: 250, decim: 1, resync: 0 });
clock = 50000; m.renderWaveFrame(clock);
const head = W.store.head;
m.handleWave({ nch: 2, frames: Array.from({ length: 30 }, (_, j) => [j, -j]), fps: 250, decim: 1, resync: 0 });
W.playhead = W.store.head - 30 - 0.15 * 250;
const q0 = W.playhead;
clock += 16.7; m.renderWaveFrame(clock); const q1 = W.playhead;
clock += 16.7; m.renderWaveFrame(clock); const q2 = W.playhead;
check('playhead advances smoothly (no jump to newest)', q1 > q0 && q2 > q1 && q2 - q0 < 20, `${q0} -> ${q1} -> ${q2}`);
W.playhead = W.store.head - 250;
clock += 16.7; m.renderWaveFrame(clock);
check('large backlog resets to ~0.15 s lag', Math.abs((W.store.head - W.playhead) - 37.5) < 1, W.store.head - W.playhead);
W.playhead = W.store.head; clock += 16.7; m.renderWaveFrame(clock);
check('playhead never passes newest sample', W.playhead <= W.store.head && head > 0);
W.settings.smooth = false;
clock += 16.7; m.renderWaveFrame(clock);
check('smooth off: right edge = newest sample', W.lastView.i1 === W.store.head);
W.settings.smooth = true;

// ------------------------------------------------------------------ 14. settings persistence + wide mode + fps cap
const reloaded = m.loadWaveSettings();
check('settings persisted to localStorage and reloaded', reloaded.transport === 'auto' && reloaded.historySec === 60 && reloaded.layout === 'overlay');
store.ch1WaveSettings = JSON.stringify({ windowSec: 'abc', layout: 'evil', fpsCap: 999, groups: [0, 99, 'x'], yCfg: { 1: { mode: 'hack', min: 'NaN' } } });
const sane = m.loadWaveSettings();
check('corrupt settings sanitized', sane.windowSec === 2 && sane.layout === 'overlay' && sane.fpsCap === 60 && sane.groups.join() === '1,8,1' && sane.yCfg[1].mode === 'per', sane);
nodes['btn-wave-wide'].fire('click');
check('wide: card moved before capture card and spans both columns', nodes['wave-card'].parentNode === main && main.children.indexOf(nodes['wave-card']) === main.children.indexOf(nodes['capture-card']) - 1 && nodes['wave-card'].classList.contains('wave-wide'));
nodes['btn-wave-wide'].fire('click');
check('wide: restored to original column position', nodes['wave-card'].parentNode === rightCol && rightCol.children[0] === nodes['wave-card'] && !nodes['wave-card'].classList.contains('wave-wide'));
const f0 = W.perf.hist.length;
W.lastFrameTs = 0;
m.drawWave(100000); m.drawWave(100005); m.drawWave(100020);
check('fps cap (60): frames closer than ~14.7 ms are skipped', W.perf.hist.length - f0 === 2 || W.perf.hist.length === 120, W.perf.hist.length - f0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
