// Node harness: parameter slider send modes (live throttle / release-to-send), auto-sync switch,
// step clamping, and the safe incremental dynamic-parameter rows (no innerHTML from firmware data).
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'host', 'web', 'app.js'), 'utf8');
const cut = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b); if (i < 0 || j < 0) { console.log('FAIL extract', a); process.exit(1); } return src.slice(i, j); };
const code = cut('// ================= 参数双向绑定', '// ================= PID 预设与专属控制')
  + cut('// ================= 动态自注册参数生成', '// ================= 实时波形绘制');

let pass = 0, fail = 0;
const check = (n, c, i = '') => { if (c) { pass++; console.log('PASS ', n); } else { fail++; console.log('FAIL ', n, typeof i === 'string' ? i : JSON.stringify(i)); } };

function mkEl(tag) {
  const el = {
    tag, id: '', children: [], parentNode: null, className: '', type: '', value: '', min: '', max: '', step: '', title: '', dataset: {}, attrs: {}, listeners: {},
    classList: { _s: new Set(), toggle(c, on) { if (on === undefined) on = !this._s.has(c); on ? this._s.add(c) : this._s.delete(c); }, add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    append(...k) { k.forEach(x => { x.parentNode = this; this.children.push(x); }); },
    appendChild(k) { k.parentNode = this; this.children.push(k); return k; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    fire(ev) { (this.listeners[ev] || []).forEach(fn => fn({ target: this })); },
    querySelectorAll(sel) { const out = []; const want = sel.replace('.', ''); const walk = n => n.children.forEach(c => { if (c.className.split(' ').includes(want)) out.push(c); walk(c); }); walk(this); return out; },
  };
  Object.defineProperty(el, 'textContent', { get() { return this._t || ''; }, set(v) { this._t = String(v); this.children = []; } });
  Object.defineProperty(el, 'innerHTML', { get() { return this._h || ''; }, set(v) { el.innerHTMLWrites = (el.innerHTMLWrites || 0) + 1; this._h = String(v); this.children = []; } });
  return el;
}
// static Kp row + step buttons + mode toggle
const nodes = {};
const add = (id, tag, props) => { const e = mkEl(tag); e.id = id; Object.assign(e, props || {}); nodes[id] = e; return e; };
const sKp = add('slider-pid_kp', 'input', { type: 'range', min: '0', max: '20', value: '1.85' });
const iKp = add('input-pid_kp', 'input', { type: 'number', value: '1.85' });
const btnSendKp = mkEl('button');
const stepUp = mkEl('button'); stepUp.dataset = { target: 'pid_kp', step: '0.1' };
const modeGroup = add('slider-send-mode', 'div');
const bLive = mkEl('button'); bLive.className = 'seg-btn active'; bLive.dataset = { mode: 'live' };
const bRel = mkEl('button'); bRel.className = 'seg-btn'; bRel.dataset = { mode: 'release' };
modeGroup.append(bLive, bRel);
const dyn = mkEl('div');
const badges = {};
const sent = [];
let clock = 0;
let timers = [];
const store = {};
const sandbox = {
  document: {
    getElementById: id => nodes[id] || (id.startsWith('ack-') ? null : null) || findIn(dyn, id),
    querySelector: sel => (sel.includes('pid_kp') ? btnSendKp : null),
    querySelectorAll: sel => (sel === '.btn-step' ? [stepUp] : []),
    createElement: mkEl,
    activeElement: null,
  },
  localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = String(v); } },
  performance: { now: () => clock },
  setTimeout: (fn, ms) => { const t = { fn, at: clock + ms, id: timers.length + 1 }; timers.push(t); return t; },
  clearTimeout: t => { timers = timers.filter(x => x !== t); },
  autoSyncEnabled: true,
  dynamicParams: new Map(),
  els: { dynamicContainer: dyn, dynamicCount: mkEl('span') },
  pendingSends: new Map(),
  sendRttCommand: s => sent.push({ t: clock, s }),
  updateAckBadge: (name, cls, text, sticky) => { badges[name] = { cls, text, sticky: !!sticky }; },
};
function findIn(root, id) { for (const c of root.children) { if (c.id === id) return c; const r = findIn(c, id); if (r) return r; } return null; }
const fn = new Function(...Object.keys(sandbox), code + `
return { setupParamBindings, setupSliderModeToggle, setSliderSendMode, syncSliderModeEnabled, renderDynamicParams, handleParamMeta,
         setAuto: v => { autoSyncEnabled = v; }, mode: () => sliderSendMode, dynamicRows };`);
const m = fn(...Object.values(sandbox));
const advance = ms => { const end = clock + ms; for (;;) { timers.sort((a, b) => a.at - b.at); const t = timers[0]; if (!t || t.at > end) break; timers.shift(); clock = t.at; t.fn(); } clock = end; };
const drag = (slider, values, dt = 16) => { values.forEach((v, k) => { if (k) advance(dt); slider.value = String(v); slider.fire('input'); }); };
const sets = () => sent.map(x => x.s);

m.setupParamBindings();
m.setupSliderModeToggle();
check('default mode = live (drag sends immediately)', m.mode() === 'live' && bLive.classList.contains('active') && !bRel.classList.contains('active'));

// ---------------------------------------------------------------- live mode: throttled during drag
const vals = Array.from({ length: 13 }, (_, k) => (2 + k * 0.5).toFixed(2));   // 13 input events over 192 ms
drag(sKp, vals);
const duringDrag = sent.length;
check('live: first value sent immediately (no waiting for a pause)', sent[0] && sent[0].t === 0 && sent[0].s === '$SET:pid_kp=2.00', sent[0]);
check(`live: throttled while dragging (~every 50 ms, got ${duringDrag} sends in 192 ms)`, duringDrag >= 4 && duringDrag <= 5, sets());
check('live: input box mirrors slider', iKp.value === vals[vals.length - 1]);
sKp.fire('change');
advance(200);
check('live: release sends the final value exactly once', sets().filter(x => x === `$SET:pid_kp=${vals[12]}`).length === 1 && sets()[sets().length - 1] === `$SET:pid_kp=${vals[12]}`, sets());
const gaps = sent.slice(1).map((x, i) => x.t - sent[i].t);
check('live: consecutive sends are >= 50 ms apart during drag', gaps.slice(0, duringDrag - 1).every(g => g >= 50), gaps);
check('live: no duplicate consecutive values', sets().every((x, i, a) => i === 0 || x !== a[i - 1]));

// keyboard arrow on focused slider: input + change together -> one send
sent.length = 0; advance(100);
sKp.value = '8.50'; sKp.fire('input'); sKp.fire('change');
advance(100);
check('live: keyboard step (input+change) sends once', sent.length === 1 && sent[0].s === '$SET:pid_kp=8.50', sets());

// ---------------------------------------------------------------- release mode
bRel.fire('click');
check('mode toggle -> release, persisted, buttons updated', m.mode() === 'release' && store.sliderSendMode === 'release' && bRel.classList.contains('active') && bRel.attrs['aria-checked'] === 'true' && !bLive.classList.contains('active'));
sent.length = 0;
drag(sKp, ['3.00', '6.00', '9.00', '12.00']);
advance(300);
check('release: nothing sent while dragging', sent.length === 0, sets());
check('release: badge previews the pending value (sticky, no fade)', badges.pid_kp && badges.pid_kp.cls === 'ack-pending' && /12\.00/.test(badges.pid_kp.text) && badges.pid_kp.sticky);
check('release: input box still mirrors slider', iKp.value === '12.00');
sKp.fire('change');
check('release: one send on mouse release with the final value', sent.length === 1 && sent[0].s === '$SET:pid_kp=12.00', sets());

// ---------------------------------------------------------------- auto-sync off
m.setAuto(false); m.syncSliderModeEnabled();
check('auto-sync off greys out the mode toggle', modeGroup.classList.contains('disabled'));
sent.length = 0;
drag(sKp, ['4.00', '5.00']); sKp.fire('change');
m.setSliderSendMode('live');
drag(sKp, ['6.00', '7.00']); sKp.fire('change'); advance(200);
check('auto-sync off: sliders never send (both modes)', sent.length === 0, sets());
iKp.value = '7.25'; iKp.fire('change');
check('number box change always sends', sent.length === 1 && sent[0].s === '$SET:pid_kp=7.25' && sKp.value === '7.25');
btnSendKp.fire('click');
check('send button sends current value', sent.length === 2 && sent[1].s === '$SET:pid_kp=7.25');
m.setAuto(true); m.syncSliderModeEnabled();
check('auto-sync on re-enables the toggle', !modeGroup.classList.contains('disabled'));

// a pending throttled value must not fire after the user typed a value
sent.length = 0;
drag(sKp, ['1.00', '1.50']);           // 1.00 sent now, 1.50 queued
iKp.value = '9.99'; iKp.fire('change');  // typed value wins
advance(200);
check('typed value cancels a queued slider send', sets().join() === '$SET:pid_kp=1.00,$SET:pid_kp=9.99', sets());

// ---------------------------------------------------------------- step clamp
sent.length = 0;
iKp.value = '19.95'; sKp.value = '19.95';
stepUp.fire('click');
check('step button clamps to slider max (no OUT_OF_RANGE)', sent.length === 1 && sent[0].s === '$SET:pid_kp=20' && iKp.value === 20, sets());

// ---------------------------------------------------------------- dynamic params: safe + incremental
const evil = '<img src=x onerror=alert(1)>';
sandbox.dynamicParams.set(evil, { name: evil, type_code: 0, min: 0, max: 10, val: 3 });
m.renderDynamicParams();
const row = dyn.children[0];
check('dynamic: row created without innerHTML (firmware strings are text only)', dyn.children.length === 1 && !dyn.innerHTMLWrites && !row.innerHTMLWrites);
const nameEl = row.children[0].children[0];
check('dynamic: parameter name rendered as plain text', nameEl.textContent === evil && nameEl.children.length === 0);
const dSlider = row.children[1].children[0], dInput = row.children[1].children[1].children[0];
check('dynamic: slider range/value from meta', dSlider.min === '0' && dSlider.max === '10' && dSlider.value === '3' && dSlider.step === '0.01' && dInput.value === '3');
sandbox.dynamicParams.set('wave_div', { name: 'wave_div', type_code: 1, min: 1, max: 50, val: 2 });
m.renderDynamicParams();
check('dynamic: incremental (existing row object kept, new row appended)', dyn.children.length === 2 && dyn.children[0] === row);
sandbox.document.activeElement = dSlider;
sandbox.dynamicParams.set(evil, { name: evil, type_code: 0, min: 0, max: 20, val: 7 });
m.renderDynamicParams();
check('dynamic: update while dragging keeps the user value, still updates range', dSlider.value === '3' && dSlider.max === '20' && dInput.value === '7');
sandbox.document.activeElement = null;
sent.length = 0;
m.setSliderSendMode('release');
const wdRow = dyn.children[1];
const wdSlider = wdRow.children[1].children[0];
wdSlider.value = '4'; wdSlider.fire('input'); wdSlider.fire('change');
check('dynamic sliders follow the send mode too', sent.length === 1 && sent[0].s === '$SET:wave_div=4', sets());
const meta = { name: 'max_current', type_code: 1, min: 0, max: 1, val: 0 };
sandbox.dynamicParams.set('max_current', meta);
m.renderDynamicParams();
check('dynamic: known keys are not duplicated as dynamic rows', dyn.children.length === 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
