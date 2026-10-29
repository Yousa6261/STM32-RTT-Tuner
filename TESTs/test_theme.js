// Theme tests: theme.js API (default, persistence, listeners, palettes), and that every canvas consumer
// (wave_core THEME, Ch1 controller, capture panel) picks up the light colors on change.
const fs = require('fs');
const path = require('path');
const WEB = path.join(__dirname, '..', 'host', 'web');

let pass = 0, fail = 0;
const check = (n, c, i = '') => { if (c) { pass++; console.log('PASS ', n); } else { fail++; console.log('FAIL ', n, typeof i === 'string' ? i : JSON.stringify(i)); } };

function loadTheme(stored) {
  const store = stored ? { uiTheme: stored } : {};
  const attrs = {};
  const btn = { textContent: '', title: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, listeners: {}, addEventListener(e, f) { this.listeners[e] = f; } };
  let ready = null;
  const win = {
    localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } },
    document: {
      documentElement: { style: {}, setAttribute: (k, v) => { attrs[k] = v; } },
      getElementById: id => (id === 'btn-theme' ? btn : null),
      addEventListener: (e, f) => { if (e === 'DOMContentLoaded') ready = f; }
    },
    console
  };
  const code = fs.readFileSync(path.join(WEB, 'theme.js'), 'utf8');
  new Function('window', 'globalThis', 'module', code)(win, win, undefined);
  return { T: win.RTTTheme, attrs, store, btn, ready: () => ready && ready(), win };
}

// ---------------------------------------------------------------- theme.js
{
  const { T, attrs, store, btn, ready } = loadTheme(null);
  check('default theme is dark (existing users unaffected)', T.mode === 'dark' && attrs['data-theme'] === 'dark');
  ready();
  check('header button shows ☀️ in dark mode and is bound', btn.textContent === '☀️' && typeof btn.listeners.click === 'function');
  let got = null;
  T.onChange(m => { got = m; });
  btn.listeners.click();
  check('toggle -> light: attribute, persistence, listener', T.mode === 'light' && attrs['data-theme'] === 'light' && store.uiTheme === 'light' && got === 'light');
  check('button switches to 🌙 with a descriptive title', btn.textContent === '🌙' && /深色/.test(btn.title));
  got = null; T.set('light');
  check('setting the same theme does not re-fire listeners', got === null);
  T.set('bogus');
  check('invalid value falls back to dark', T.mode === 'dark');
  const d = T.palette('dark'), l = T.palette('light');
  check('palettes: 8 colors each, light differs, no near-white trace on white bg', d.length === 8 && l.length === 8 && l.join() !== d.join() && !l.includes('#e6edf3'));
  const p = T.palette(); p[0] = 'x';
  check('palette() returns a copy', T.palette()[0] !== 'x');
}
{
  const { T, attrs } = loadTheme('light');
  check('stored preference applied before first paint', T.mode === 'light' && attrs['data-theme'] === 'light');
}

// ---------------------------------------------------------------- wave_core.setTheme covers every canvas key
const WC = require(path.join(WEB, 'wave_core.js'));
{
  const { T } = loadTheme('light');
  const keys = Object.keys(WC.THEME).filter(k => k !== 'font');
  const lc = T.canvas('light'), dc = T.canvas('dark');
  check('theme.js provides every wave_core canvas color (light + dark)', keys.every(k => typeof lc[k] === 'string' && typeof dc[k] === 'string'), keys.filter(k => !lc[k] || !dc[k]));
  WC.setTheme(lc);
  check('wave_core.setTheme applies light colors', WC.THEME.grid === lc.grid && WC.THEME.overviewBg === lc.overviewBg && WC.THEME.font.includes('monospace'));
  WC.setTheme({ grid: 123, evil: 'x' });
  check('setTheme ignores unknown keys / non-strings', WC.THEME.grid === lc.grid && WC.THEME.evil === undefined);
  WC.setTheme(dc);
}

// ---------------------------------------------------------------- Ch1 controller reacts to theme change
{
  const { T } = loadTheme('dark');
  const src = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
  const a = src.indexOf('// ================= Ch1 JustFloat 波形'), b = src.indexOf('// ================= 终端输出与交互');
  const mkEl = () => ({ children: [], style: {}, classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } }, addEventListener() {}, append(...k) { this.children.push(...k); }, appendChild(k) { this.children.push(k); }, set textContent(v) { this.children = []; }, get textContent() { return ''; } });
  const legend = mkEl();
  const sandbox = {
    document: { getElementById: id => (id === 'wave-legend' ? legend : null), createElement: mkEl },
    window: { RTTWaveCore: WC, RTTTheme: T, addEventListener() {}, prompt() {} },
    localStorage: { getItem: () => null, setItem() {} },
    performance: { now: () => 0 }, requestAnimationFrame() {}, els: { waveLegend: legend },
    pushCh1ToDashboard() {}, syncCh1Keys() {}, flushTelemetryRender() {}
  };
  const m = new Function(...Object.keys(sandbox), src.slice(a, b) + '\nreturn { applyWaveTheme, handleWave, wave, WAVE_COLORS };')(...Object.values(sandbox));
  m.handleWave({ nch: 3, frames: [[1, 2, 3]], fps: 100, decim: 1, resync: 0 });
  T.set('light');
  m.applyWaveTheme();
  check('Ch1: trace palette switched to light colors in place', m.WAVE_COLORS.join() === T.palette('light').join());
  check('Ch1: legend dots repainted with the light palette', legend.children[0].children[0].style.backgroundColor === T.palette('light')[0]);
  check('Ch1: grid layer + overview forced to redraw', m.wave.gridSig === '' && m.wave.ovLast === 0 && m.wave.dirty === true);
  check('Ch1: wave_core canvas colors switched', WC.THEME.grid === T.canvas('light').grid);
  T.set('dark'); m.applyWaveTheme();
  check('Ch1: back to dark palette', m.WAVE_COLORS[7] === '#e6edf3' && WC.THEME.grid === '#1e2430');
}

// ---------------------------------------------------------------- capture panel
{
  const cap = require(path.join(WEB, 'capture_panel.js'));
  check('capture panel exposes onThemeChange (redraws on switch)', typeof cap.onThemeChange === 'function');
  cap.onThemeChange();   // no DOM / no theme in node: must not throw, keeps dark defaults
  check('capture panel onThemeChange is safe without DOM', true);
}

// ---------------------------------------------------------------- CSS + HTML wiring
{
  const css = fs.readFileSync(path.join(WEB, 'style.css'), 'utf8');
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const lightBlock = css.slice(css.indexOf(':root[data-theme="light"]'));
  ['--bg-primary', '--bg-card', '--text-main', '--text-muted', '--border-color', '--accent-blue'].forEach(v => {
    check(`light theme overrides ${v}`, new RegExp(`${v}:\\s*#`).test(lightBlock));
  });
  const head = html.slice(0, html.indexOf('</head>'));
  check('theme.js loaded synchronously in <head> before style.css (no flash)', head.indexOf('theme.js') > 0 && head.indexOf('theme.js') < head.indexOf('style.css') && !/theme\.js"[^>]*(defer|async)/.test(head));
  check('header theme toggle button present', /id="btn-theme"/.test(html));
  check('slider send-mode toggle present with both modes', /id="slider-send-mode"/.test(html) && /data-mode="live"/.test(html) && /data-mode="release"/.test(html));
  // WCAG AA contrast of main/muted text on light card background
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const lum = h => { const [r, g, b] = hex(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const val = name => (new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(lightBlock) || [])[1];
  const bg = val('--bg-card');
  ['--text-main', '--text-muted', '--text-dim', '--accent-blue', '--accent-green-bright', '--accent-orange', '--accent-red', '--accent-cyan'].forEach(v => {
    const r = ratio(val(v), bg);
    check(`light contrast ${v} on card >= 4.5:1 (${r.toFixed(2)})`, r >= 4.5, r);
  });
  const { T } = loadTheme('light');
  T.palette('light').forEach((c, i) => {
    const r = ratio(c, '#ffffff');
    check(`light trace color ${i} (${c}) readable on white (>= 3:1, got ${r.toFixed(2)})`, r >= 3, r);
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
