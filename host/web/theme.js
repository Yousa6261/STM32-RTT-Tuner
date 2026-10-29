/**
 * STM32 SEGGER RTT v3.1 — 界面主题 (theme.js)
 *
 * 在 <head> 中同步加载: 首次绘制前就把 data-theme 写到 <html>, 不会出现"先黑后白"闪烁。
 * CSS 通过 :root[data-theme="light"] 覆盖颜色变量; 画布 (Ch1 波形 / 遥测趋势 / Ch2 采集 / FFT / STFT)
 * 无法使用 CSS 变量, 统一从 RTTTheme.canvas() 取色, 并通过 onChange 在切换时重绘。
 *
 * 默认深色 (保持老用户习惯); 选择会保存在浏览器本地 (localStorage 'uiTheme')。
 */
(function (root) {
  'use strict';
  const KEY = 'uiTheme';

  // 通道配色: 深色背景用亮色; 浅色背景用加深色 (深色方案第 8 色为近白, 浅色方案换成近黑)
  const PALETTES = {
    dark: ['#58a6ff', '#3fb950', '#d29922', '#f778ba', '#a371f7', '#39c5bb', '#f85149', '#e6edf3'],
    light: ['#0969da', '#1a7f37', '#b35900', '#bf3989', '#8250df', '#127a83', '#cf222e', '#24292f']
  };
  const CANVAS = {
    dark: {
      grid: '#1e2430', gridStrong: '#2a3140', zero: '#3a4250', frame: '#30363d', text: '#8b949e', textDim: '#6e7681',
      cursorA: '#ffa657', cursorB: '#d2a8ff', marker: '#e3b341', labelBg: 'rgba(13,17,23,0.85)', cursorText: '#0d1117',
      crosshair: 'rgba(230,237,243,0.45)', dotStroke: '#0d1117', overviewBg: 'rgba(22,27,34,0.9)',
      select: 'rgba(88,166,255,0.15)', selectStroke: 'rgba(88,166,255,0.8)',
      window: 'rgba(88,166,255,0.18)', windowStroke: 'rgba(88,166,255,0.9)',
      target: '#58a6ff', actual: '#3fb950', trigger: '#d29922', band: 'rgba(63, 185, 80, 0.45)', peak: '#f85149', spectrum: '#39c5bb'
    },
    light: {
      grid: '#e6e9ee', gridStrong: '#d0d7de', zero: '#afb8c1', frame: '#d0d7de', text: '#59636e', textDim: '#818b98',
      cursorA: '#d1581b', cursorB: '#8250df', marker: '#9a6700', labelBg: 'rgba(255,255,255,0.9)', cursorText: '#ffffff',
      crosshair: 'rgba(31,35,40,0.45)', dotStroke: '#ffffff', overviewBg: 'rgba(246,248,250,1)',
      select: 'rgba(9,105,218,0.12)', selectStroke: 'rgba(9,105,218,0.8)',
      window: 'rgba(9,105,218,0.12)', windowStroke: 'rgba(9,105,218,0.85)',
      target: '#0969da', actual: '#1a7f37', trigger: '#b35900', band: 'rgba(26, 127, 55, 0.4)', peak: '#cf222e', spectrum: '#127a83'
    }
  };
  const listeners = [];

  function read() {
    try { const v = root.localStorage && root.localStorage.getItem(KEY); return v === 'light' ? 'light' : 'dark'; } catch (e) { return 'dark'; }
  }

  let mode = read();

  function applyAttr() {
    const doc = root.document;
    if (doc && doc.documentElement) {
      doc.documentElement.setAttribute('data-theme', mode);
      doc.documentElement.style.colorScheme = mode;   // 原生控件 (滚动条/下拉框/日期等) 跟随主题
    }
    const btn = doc && doc.getElementById && doc.getElementById('btn-theme');
    if (btn) {
      btn.textContent = mode === 'light' ? '🌙' : '☀️';
      btn.title = mode === 'light' ? '切换为深色主题' : '切换为浅色 (白色) 主题';
      btn.setAttribute('aria-label', btn.title);
    }
  }

  const api = {
    get mode() { return mode; },
    palette(m) { return PALETTES[m || mode].slice(); },
    canvas(m) { return Object.assign({}, CANVAS[m || mode]); },
    set(m) {
      m = m === 'light' ? 'light' : 'dark';
      if (m === mode) { applyAttr(); return; }
      mode = m;
      try { root.localStorage && root.localStorage.setItem(KEY, mode); } catch (e) { /* 隐私模式 */ }
      applyAttr();
      listeners.slice().forEach(fn => { try { fn(mode); } catch (e) { if (root.console) root.console.error(e); } });
    },
    toggle() { api.set(mode === 'light' ? 'dark' : 'light'); },
    onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }
  };

  applyAttr();
  if (root.document && root.document.addEventListener) {
    root.document.addEventListener('DOMContentLoaded', () => {
      applyAttr();
      const btn = root.document.getElementById('btn-theme');
      if (btn) btn.addEventListener('click', api.toggle);
    });
  }
  root.RTTTheme = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
