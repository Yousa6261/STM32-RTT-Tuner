/**
 * STM32 SEGGER RTT v3.0 — Ch2 触发采集与时频分析面板 (capture_panel.js)
 *
 * 功能:
 *  1. 触发采集控制 ($CAP:CFG / ARM / FORCE / STOP / READ / INFO / STAT)
 *  2. 采集历史管理 (最近 10 次采集 + Ch1 连续波形一键快照导入 + JSON 导入/导出 + CSV 导出)
 *  3. 采集波形画布交互 (滚轮缩放、拖拽平移、双击复位、A/B 双光标 Δt / 1/Δt / Δy、触发线与阶跃特征点叠加)
 *  4. 三大分析引擎联动 (依赖 analysis.js / window.RTTAnalysis):
 *     - 阶跃响应 (延迟时间 td、上升时间 tr、峰值时间 tp、超调量 σ%、调节时间 ts、稳态误差 ess、等效 ζ / ωn)
 *     - 频谱 FFT (Hann/Hamming/Blackman-Harris/矩形窗、主瓣能量幅值修正、前 5 峰值标注、THD 总谐波失真)
 *     - 时频 STFT (短时傅里叶变换时频热力图、时间-频率双轴与峰值追踪)
 *
 * 既可在浏览器作为 <script src="capture_panel.js"> 运行，也可在 Node.js 中 require() 进行自动化测试。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RTTCapturePanel = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // v3.1: 配色随主题 (theme.js) 切换; Node 测试或未加载 theme.js 时使用深色默认值
  const DARK_COLORS = ['#58a6ff', '#3fb950', '#d29922', '#f778ba', '#a371f7', '#39c5bb', '#f85149', '#e6edf3'];
  const DARK_CANVAS = { grid: '#1e2430', text: '#8b949e', trigger: '#d29922', band: 'rgba(63, 185, 80, 0.45)',
                        peak: '#f85149', spectrum: '#39c5bb', cursorA: '#58a6ff', cursorB: '#f778ba' };
  const COLORS = DARK_COLORS.slice();
  let TH = Object.assign({}, DARK_CANVAS);
  function themeApi() { return (typeof window !== 'undefined' && window.RTTTheme) || null; }
  function loadTheme() {
    const T = themeApi();
    const pal = T ? T.palette() : DARK_COLORS;
    for (let k = 0; k < COLORS.length; k++) COLORS[k] = pal[k % pal.length];
    TH = Object.assign({}, DARK_CANVAS, T ? T.canvas() : {});
    if (T) { TH.cursorA = pal[0]; TH.cursorB = pal[3]; }
  }
  loadTheme();
  const MAX_HISTORY = 10;

  const state = {
    history: [],          // 最近采集列表 (最新在前)
    current: null,        // 当前选中的采集对象
    fwInfo: null,         // $ACK:CAP:INFO 解析结果
    fwStat: null,         // $ACK:CAP:STAT 解析结果
    names: ['ref', 'plant', 'sine', 'count'],
    visible: [],
    activeTab: 'step',
    lastStepResult: null,
    lastFftResult: null,
    lastStftResult: null,
    // 视图缩放与双光标状态 (样本索引区间 [viewStart, viewEnd))
    viewStart: 0,
    viewEnd: 0,
    cursorA: null,        // 样本索引
    cursorB: null,        // 样本索引
    dragging: false,
    dragStartX: 0,
    dragViewStart: 0,
    dragViewEnd: 0
  };

  const els = {};

  function getAnalysis() {
    if (typeof window !== 'undefined' && window.RTTAnalysis) return window.RTTAnalysis;
    if (typeof globalThis !== 'undefined' && globalThis.RTTAnalysis) return globalThis.RTTAnalysis;
    if (typeof require === 'function') {
      try { return require('./analysis.js'); } catch (_) { /* ignore */ }
    }
    return null;
  }

  function sendRtt(cmd) {
    if (typeof window !== 'undefined' && window.RTTApp && typeof window.RTTApp.sendRtt === 'function') {
      window.RTTApp.sendRtt(cmd);
    }
  }

  function logTerm(type, text) {
    if (typeof window !== 'undefined' && window.RTTApp && typeof window.RTTApp.logTerminal === 'function') {
      window.RTTApp.logTerminal(type, text);
    }
  }

  // =========================================================================
  // 1. 固件 $ACK:CAP:... 应答解析
  // =========================================================================

  function parseKvList(str) {
    const out = {};
    String(str || '').split(',').forEach(part => {
      const eq = part.indexOf('=');
      if (eq > 0) {
        const k = part.slice(0, eq).trim();
        const v = part.slice(eq + 1).trim();
        out[k] = v;
      }
    });
    return out;
  }

  function parseCapAck(line) {
    const s = String(line || '').trim();
    if (s.startsWith('$ACK:ERR:CAP:')) {
      return { ok: false, kind: 'ERR', error: s.slice('$ACK:ERR:CAP:'.length) };
    }
    if (!s.startsWith('$ACK:CAP:')) {
      return { ok: false, kind: 'UNKNOWN', raw: s };
    }
    const rest = s.slice('$ACK:CAP:'.length);
    const colon = rest.indexOf(':');
    const kind = colon >= 0 ? rest.slice(0, colon) : rest;
    const body = colon >= 0 ? rest.slice(colon + 1) : '';
    const kv = parseKvList(body);

    if (kind === 'INFO') {
      const names = kv.names ? kv.names.split('|').map(x => x.trim()).filter(Boolean) : [];
      const fmtNum = Number(kv.fmt);
      const fmtStr = (kv.fmt === '0' || fmtNum === 0) ? 'f32' : ((kv.fmt === '1' || fmtNum === 1) ? 'i16' : (kv.fmt || 'f32'));
      return {
        ok: true,
        kind: 'INFO',
        ver: Number(kv.ver) || 1,
        max_ch: Number(kv.nch || kv.max_ch) || 4,
        buf: Number(kv.buf) || 0,
        depth: Number(kv.depth) || 0,
        base_hz: Number(kv.fs || kv.base_hz) || 0,
        fmt: fmtStr,
        state: Number(kv.state) || 0,
        names
      };
    }
    if (kind === 'STAT' || kind === 'STAT2') {
      return {
        ok: true,
        kind,
        state: kv.state || '0',
        cap_id: Number(kv.id || kv.cap_id) || 0,
        trig_cnt: Number(kv.caps || kv.trig_cnt) || 0,
        tx_drop: Number(kv.full || kv.tx_drop) || 0,
        isr_avg_cy: Number(kv.cyc_avg || kv.isr_avg_cy) || 0,
        isr_max_cy: Number(kv.cyc_max || kv.isr_max_cy) || 0,
        ns_max: Number(kv.ns_max) || 0
      };
    }
    return { ok: true, kind, kv, raw: s };
  }

  function buildCfgCommand(cfg) {
    const ch = Math.max(0, Number(cfg.ch) | 0);
    const edge = ['rise', 'fall', 'both'].includes(cfg.edge) ? cfg.edge : 'rise';
    const lvl = Number.isFinite(Number(cfg.level)) ? Number(cfg.level) : 0;
    const pre = Math.max(0, Math.min(99, Number(cfg.pre) | 0));
    const div = Math.max(1, Number(cfg.div) | 0);
    const run = ['single', 'normal', 'auto'].includes(cfg.run || cfg.mode) ? (cfg.run || cfg.mode) : 'single';
    const autoMs = Math.max(1, Number(cfg.auto !== undefined ? cfg.auto : cfg.auto_ms) | 0);
    return `$CAP:CFG:ch=${ch},edge=${edge},level=${lvl},pre=${pre},div=${div},run=${run},auto=${autoMs}`;
  }

  // =========================================================================
  // 2. DOM 绑定与初始化
  // =========================================================================

  function bindDom() {
    if (typeof document === 'undefined') return;
    const ids = [
      'cap-status', 'cap-progress', 'cap-ch', 'cap-edge', 'cap-level', 'cap-pre',
      'cap-div', 'cap-run', 'cap-auto', 'btn-cap-arm', 'btn-cap-force', 'btn-cap-stop',
      'btn-cap-read', 'btn-cap-info', 'cap-history', 'btn-cap-csv', 'btn-cap-json',
      'cap-import', 'cap-legend', 'capCanvas', 'cap-cursor',
      'step-ref', 'step-y', 'step-rise', 'step-band', 'step-smooth', 'btn-step-run', 'step-result',
      'fft-ch', 'fft-win', 'fft-scale', 'fft-range', 'fft-fmax', 'fft-f1', 'fftCanvas', 'fft-result',
      'stft-ch', 'stft-win', 'stft-ovl', 'stft-range', 'stftCanvas', 'stft-result'
    ];
    ids.forEach(id => { els[id] = document.getElementById(id); });
    if (!els['capCanvas']) return;
    const T = themeApi();
    if (T && typeof T.onChange === 'function') T.onChange(onThemeChange);

    populateChannelSelects(state.names);

    // 按钮事件
    if (els['btn-cap-arm']) {
      els['btn-cap-arm'].addEventListener('click', () => {
        const cfgCmd = buildCfgCommand({
          ch: els['cap-ch'] ? els['cap-ch'].value : 0,
          edge: els['cap-edge'] ? els['cap-edge'].value : 'rise',
          level: els['cap-level'] ? els['cap-level'].value : 0.5,
          pre: els['cap-pre'] ? els['cap-pre'].value : 20,
          div: els['cap-div'] ? els['cap-div'].value : 1,
          mode: els['cap-run'] ? els['cap-run'].value : 'single',
          auto_ms: els['cap-auto'] ? els['cap-auto'].value : 200
        });
        sendRtt(cfgCmd);
        sendRtt('$CAP:ARM');
      });
    }
    if (els['btn-cap-force']) els['btn-cap-force'].addEventListener('click', () => sendRtt('$CAP:FORCE'));
    if (els['btn-cap-stop']) els['btn-cap-stop'].addEventListener('click', () => sendRtt('$CAP:STOP'));
    if (els['btn-cap-read']) els['btn-cap-read'].addEventListener('click', () => sendRtt('$CAP:READ'));
    if (els['btn-cap-info']) {
      els['btn-cap-info'].addEventListener('click', () => {
        sendRtt('$CAP:INFO');
        sendRtt('$CAP:STAT');
      });
    }

    if (els['cap-history']) {
      els['cap-history'].addEventListener('change', () => {
        const idx = Number(els['cap-history'].value);
        if (Number.isInteger(idx) && state.history[idx]) {
          selectCapture(state.history[idx]);
        }
      });
    }

    if (els['btn-cap-csv']) els['btn-cap-csv'].addEventListener('click', exportCurrentCsv);
    if (els['btn-cap-json']) els['btn-cap-json'].addEventListener('click', exportCurrentJson);
    if (els['cap-import']) {
      els['cap-import'].addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const obj = JSON.parse(String(reader.result));
            onCapture(obj);
            logTerm('system', `📂 已导入采集文件: ${file.name}`);
          } catch (err) {
            logTerm('ack-err', `导入 JSON 失败: ${err.message}`);
          }
        };
        reader.readAsText(file);
        e.target.value = '';
      });
    }

    // Tab 切换
    document.querySelectorAll('.cap-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        if (!tab) return;
        state.activeTab = tab;
        document.querySelectorAll('.cap-tab').forEach(b => b.classList.toggle('active', b === btn));
        ['step', 'fft', 'stft'].forEach(t => {
          const pane = document.getElementById(`cap-pane-${t}`);
          if (pane) pane.classList.toggle('hidden', t !== tab);
        });
        runActiveAnalysis();
        drawCaptureCanvas();
      });
    });

    // 分析控件变更自动重算
    if (els['btn-step-run']) els['btn-step-run'].addEventListener('click', () => { runStepAnalysis(); drawCaptureCanvas(); });
    ['step-ref', 'step-y', 'step-rise', 'step-band', 'step-smooth'].forEach(id => {
      if (els[id]) els[id].addEventListener('change', () => { runStepAnalysis(); drawCaptureCanvas(); });
    });
    ['fft-ch', 'fft-win', 'fft-scale', 'fft-range', 'fft-fmax', 'fft-f1'].forEach(id => {
      if (els[id]) els[id].addEventListener('change', runFftAnalysis);
    });
    ['stft-ch', 'stft-win', 'stft-ovl', 'stft-range'].forEach(id => {
      if (els[id]) els[id].addEventListener('change', runStftAnalysis);
    });

    setupCanvasInteraction(els['capCanvas']);
    const resizeAll = () => {
      ['capCanvas', 'fftCanvas', 'stftCanvas'].forEach(id => {
        const c = els[id];
        if (!c || !c.parentElement) return;
        const rect = c.parentElement.getBoundingClientRect();
        if (rect.width > 100) c.width = Math.max(320, Math.floor(rect.width - 24));
      });
      drawCaptureCanvas();
      if (state.activeTab === 'fft') drawFftCanvas();
      if (state.activeTab === 'stft') drawStftCanvas();
    };
    window.addEventListener('resize', resizeAll);
    setTimeout(resizeAll, 50);
  }

  function populateChannelSelects(names) {
    const nch = Math.max(1, names.length);
    const selects = [
      { el: els['cap-ch'], def: 0 },
      { el: els['step-ref'], def: 0 },
      { el: els['step-y'], def: Math.min(1, nch - 1) },
      { el: els['fft-ch'], def: Math.min(2, nch - 1) },
      { el: els['stft-ch'], def: Math.min(2, nch - 1) }
    ];
    selects.forEach(({ el, def }) => {
      if (!el) return;
      const prev = Number(el.value);
      el.textContent = '';
      for (let i = 0; i < nch; i++) {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = `CH${i} (${names[i] || 'CH' + i})`;
        el.appendChild(opt);
      }
      el.value = String((Number.isInteger(prev) && prev >= 0 && prev < nch) ? prev : def);
    });
  }

  // =========================================================================
  // 3. 接收网关消息 (onCapture / onStatus / onAck / onConnected / importCh1Snapshot)
  // =========================================================================

  function onConnected() {
    setTimeout(() => {
      sendRtt('$CAP:INFO');
    }, 250);
  }

  function onStatus(msg) {
    if (!msg) return;
    const badge = els['cap-status'];
    const prog = els['cap-progress'];
    if (msg.stage === 'receiving') {
      const rx = Number(msg.received) || 0;
      const tot = Math.max(1, Number(msg.total) || 1);
      const pct = Math.round((rx / tot) * 100);
      if (prog) { prog.max = tot; prog.value = rx; }
      if (badge) badge.textContent = `接收中 #${msg.cap_id}: ${rx}/${tot} (${pct}%)`;
    } else if (msg.stage === 'online') {
      if (badge) badge.textContent = 'Ch2 已就绪';
    } else if (msg.stage === 'offline') {
      if (badge) badge.textContent = 'Ch2 未就绪';
    } else if (msg.stage === 'error') {
      if (badge) badge.textContent = `错误: ${msg.message || '传输异常'}`;
      logTerm('ack-err', `[Ch2] ${msg.message}`);
    }
  }

  function onAck(msg) {
    if (!msg || !msg.data) return;
    const parsed = parseCapAck(msg.data);
    const badge = els['cap-status'];
    if (!parsed.ok) {
      if (badge) badge.textContent = `采集命令错误: ${parsed.error || msg.data}`;
      return;
    }
    if (parsed.kind === 'INFO') {
      state.fwInfo = parsed;
      if (parsed.names && parsed.names.length) {
        state.names = parsed.names.slice();
        populateChannelSelects(state.names);
      }
      if (badge) {
        badge.textContent = `Ch2 就绪 (${parsed.depth}点 @ ${(parsed.base_hz / 1000).toFixed(1)}kHz, ${parsed.fmt})`;
      }
      logTerm('ack-ok', `[Ch2 INFO] 深度=${parsed.depth} 点, 基准采样率=${parsed.base_hz} Hz, 格式=${parsed.fmt}, 通道=${state.names.join('|')}`);
    } else if (parsed.kind === 'STAT') {
      state.fwStat = Object.assign(state.fwStat || {}, parsed);
      const nsInfo = parsed.ns_max ? ` (${parsed.ns_max}ns)` : '';
      if (badge) {
        badge.textContent = `ISR均值:${parsed.isr_avg_cy}cy 峰值:${parsed.isr_max_cy}cy${nsInfo}`;
      }
      logTerm('ack-ok', `[Ch2 STAT] ISR耗时 avg=${parsed.isr_avg_cy} / max=${parsed.isr_max_cy} cycles${nsInfo}`);
    } else if (parsed.kind === 'STAT2') {
      state.fwStat = Object.assign(state.fwStat || {}, parsed);
      logTerm('ack-ok', `[Ch2 STAT2] state=${parsed.state}, 已完成=${parsed.trig_cnt}, 满缓冲重试=${parsed.tx_drop}, id=${parsed.cap_id}`);
    } else if (parsed.kind === 'ARM' || parsed.kind === 'ARMED') {
      if (badge) badge.textContent = '已布防 (等待触发...)';
    } else if (parsed.kind === 'FORCE' || parsed.kind === 'FORCED') {
      if (badge) badge.textContent = '已强制触发，等待数据回传...';
    } else if (parsed.kind === 'STOP' || parsed.kind === 'STOPPED') {
      if (badge) badge.textContent = '已停止采集';
    }
  }

  function normalizeCapture(raw) {
    if (!raw || !Array.isArray(raw.channels) || raw.channels.length === 0) return null;
    const nch = raw.channels.length;
    const total = raw.channels[0].length;
    if (total < 2) return null;
    const channels = raw.channels.map(col => col.map(v => (typeof v === 'number' && Number.isFinite(v)) ? v : 0));
    const names = [];
    for (let i = 0; i < nch; i++) {
      names.push((Array.isArray(raw.names) && raw.names[i]) || state.names[i] || `CH${i}`);
    }
    const fs = Math.max(1, Number(raw.fs || raw.sample_hz) || 1000);
    const trigIdx = Math.max(0, Math.min(total - 1, Number(raw.trig_index !== undefined ? raw.trig_index : raw.trigger_index) | 0));
    const trigCh = Number(raw.trig_ch !== undefined ? raw.trig_ch : raw.trigger_ch) | 0;
    return {
      cap_id: Number(raw.cap_id) || 0,
      fs,
      sample_hz: fs,
      nch,
      fmt: raw.fmt !== undefined ? raw.fmt : 0,
      fmt_name: raw.fmt_name || (raw.fmt === 1 ? 'i16' : 'f32'),
      flags: Number(raw.flags) || 0,
      trig_index: trigIdx,
      trigger_index: trigIdx,
      trig_ch: trigCh,
      trigger_ch: trigCh,
      total,
      names,
      channels,
      crc_errors: Number(raw.crc_errors) || 0,
      ts: raw.ts || new Date().toTimeString().slice(0, 8)
    };
  }

  function onCapture(rawMsg) {
    const cap = normalizeCapture(rawMsg);
    if (!cap) return null;

    state.names = cap.names.slice();
    while (state.visible.length < cap.nch) state.visible.push(true);
    populateChannelSelects(state.names);

    state.history.unshift(cap);
    if (state.history.length > MAX_HISTORY) state.history.pop();
    rebuildHistorySelect();
    selectCapture(cap);

    const prog = els['cap-progress'];
    if (prog) { prog.max = 1; prog.value = 1; }
    logTerm('ack-ok', `[Ch2 采集完成] #${cap.cap_id}: ${cap.total} 点 × ${cap.nch} 通道 @ ${cap.sample_hz} Hz (触发点 #${cap.trigger_index})`);
    return cap;
  }

  function importCh1Snapshot() {
    if (typeof window === 'undefined' || !window.RTTApp || typeof window.RTTApp.getCh1Snapshot !== 'function') return null;
    const snap = window.RTTApp.getCh1Snapshot();
    if (!snap || !snap.nch || !snap.channels || !snap.channels[0] || snap.channels[0].length < 4) return null;
    const cap = onCapture({
      cap_id: 9000 + state.history.length + 1,
      sample_hz: snap.sample_hz,
      nch: snap.nch,
      fmt_name: 'ch1_f32',
      trigger_index: 0,
      trigger_ch: 0,
      total: snap.channels[0].length,
      names: snap.names,
      channels: snap.channels
    });
    if (cap) {
      logTerm('system', `📊 已将 Ch1 连续波形快照 (${cap.total} 点 @ ${cap.sample_hz} Hz) 导入分析面板`);
    }
    return cap;
  }

  function rebuildHistorySelect() {
    const sel = els['cap-history'];
    if (!sel) return;
    sel.textContent = '';
    if (!state.history.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '(无采集)';
      sel.appendChild(opt);
      sel.value = '';
      return;
    }
    state.history.forEach((c, idx) => {
      const opt = document.createElement('option');
      opt.value = String(idx);
      opt.textContent = `#${c.cap_id} (${c.total}点@${c.sample_hz}Hz ${c.ts})`;
      sel.appendChild(opt);
    });
    sel.value = '0';
  }

  /** v3.1: 主题切换后重绘图例圆点、采集画布与当前分析页 */
  function onThemeChange() {
    loadTheme();
    if (state.current) {
      rebuildLegend(state.current);
      runActiveAnalysis();
    }
    drawCaptureCanvas();
  }

  /** v3.1: 清空采集记录与画布 (波形面板 "全部清空" 调用) */
  function clearHistory() {
    state.history = [];
    state.current = null;
    state.lastStepResult = null;
    state.lastFftResult = null;
    state.lastStftResult = null;
    rebuildHistorySelect();
    drawCaptureCanvas();
    ['fftCanvas', 'stftCanvas'].forEach(id => {
      const cv = els[id];
      if (cv && cv.getContext) cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
    });
    ['step-result', 'fft-result', 'stft-result'].forEach(id => { if (els[id]) els[id].textContent = ''; });
    if (els['cap-legend']) els['cap-legend'].textContent = '';
    if (els['cap-status']) els['cap-status'].textContent = '已清空';
  }

  function selectCapture(cap) {
    state.current = cap;
    state.viewStart = 0;
    state.viewEnd = cap.total;
    state.cursorA = cap.trigger_index;
    state.cursorB = Math.min(cap.total - 1, cap.trigger_index + Math.max(1, Math.round(cap.total * 0.1)));

    const badge = els['cap-status'];
    if (badge) {
      const durMs = ((cap.total / cap.sample_hz) * 1000).toFixed(1);
      badge.textContent = `#${cap.cap_id} · ${cap.total}点×${cap.nch}ch @ ${cap.sample_hz}Hz (${durMs}ms)`;
    }

    rebuildLegend(cap);
    runActiveAnalysis();
    drawCaptureCanvas();
    updateCursorReadout();
  }

  function rebuildLegend(cap) {
    const leg = els['cap-legend'];
    if (!leg) return;
    leg.textContent = '';
    for (let i = 0; i < cap.nch; i++) {
      const item = document.createElement('span');
      item.className = 'wave-legend-item' + (state.visible[i] === false ? ' wave-hidden' : '');
      const dot = document.createElement('span');
      dot.className = 'wave-dot';
      dot.style.backgroundColor = COLORS[i % COLORS.length];
      dot.title = '点击显示/隐藏该通道';
      dot.addEventListener('click', () => {
        state.visible[i] = state.visible[i] === false;
        item.classList.toggle('wave-hidden', !state.visible[i]);
        drawCaptureCanvas();
      });

      const name = document.createElement('span');
      name.className = 'wave-name';
      name.textContent = cap.names[i] || `CH${i}`;
      name.title = '点击修改通道名称';
      name.addEventListener('click', () => {
        const next = window.prompt(`修改通道 ${i} 名称:`, cap.names[i] || `CH${i}`);
        if (next && next.trim()) {
          cap.names[i] = next.trim().slice(0, 24);
          state.names[i] = cap.names[i];
          name.textContent = cap.names[i];
          populateChannelSelects(state.names);
        }
      });

      const chArr = cap.channels[i];
      let mn = Infinity, mx = -Infinity;
      for (let k = 0; k < chArr.length; k++) {
        const v = chArr[k];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      const val = document.createElement('span');
      val.className = 'wave-val';
      val.textContent = `[${Number(mn.toPrecision(4))} .. ${Number(mx.toPrecision(4))}]`;

      item.append(dot, name, val);
      leg.appendChild(item);
    }
  }

  // =========================================================================
  // 4. 采集波形画布绘制与缩放/平移/双光标交互
  // =========================================================================

  function setupCanvasInteraction(canvas) {
    if (!canvas) return;

    const xToSample = (clientX) => {
      const cap = state.current;
      if (!cap) return 0;
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
      const span = Math.max(2, state.viewEnd - state.viewStart);
      return Math.max(0, Math.min(cap.total - 1, Math.round(state.viewStart + ratio * (span - 1))));
    };

    canvas.addEventListener('wheel', (e) => {
      if (!state.current) return;
      e.preventDefault();
      const cap = state.current;
      const centerIdx = xToSample(e.clientX);
      const span = Math.max(8, state.viewEnd - state.viewStart);
      const factor = e.deltaY < 0 ? 0.75 : 1.33;
      const nextSpan = Math.max(16, Math.min(cap.total, Math.round(span * factor)));
      const frac = (centerIdx - state.viewStart) / Math.max(1, span);
      let s0 = Math.round(centerIdx - frac * nextSpan);
      s0 = Math.max(0, Math.min(cap.total - nextSpan, s0));
      state.viewStart = s0;
      state.viewEnd = s0 + nextSpan;
      drawCaptureCanvas();
    }, { passive: false });

    canvas.addEventListener('mousedown', (e) => {
      if (!state.current) return;
      if (e.button === 2 || e.shiftKey) {
        state.cursorB = xToSample(e.clientX);
        updateCursorReadout();
        drawCaptureCanvas();
        return;
      }
      state.dragging = true;
      state.dragMoved = false;
      state.dragStartX = e.clientX;
      state.dragViewStart = state.viewStart;
      state.dragViewEnd = state.viewEnd;
    });

    window.addEventListener('mousemove', (e) => {
      if (!state.dragging || !state.current) return;
      const dx = e.clientX - state.dragStartX;
      if (Math.abs(dx) > 4) state.dragMoved = true;
      if (!state.dragMoved) return;
      const rect = canvas.getBoundingClientRect();
      const span = state.dragViewEnd - state.dragViewStart;
      const shift = Math.round((-dx / Math.max(1, rect.width)) * span);
      let s0 = Math.max(0, Math.min(state.current.total - span, state.dragViewStart + shift));
      state.viewStart = s0;
      state.viewEnd = s0 + span;
      drawCaptureCanvas();
    });

    window.addEventListener('mouseup', (e) => {
      if (!state.dragging) return;
      const moved = state.dragMoved;
      state.dragging = false;
      if (!moved && state.current && e.button === 0 && !e.shiftKey) {
        state.cursorA = xToSample(e.clientX);
        updateCursorReadout();
        drawCaptureCanvas();
      }
    });

    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!state.current) return;
      state.cursorB = xToSample(e.clientX);
      updateCursorReadout();
      drawCaptureCanvas();
    });

    canvas.addEventListener('dblclick', () => {
      if (!state.current) return;
      state.viewStart = 0;
      state.viewEnd = state.current.total;
      drawCaptureCanvas();
    });
  }

  function updateCursorReadout() {
    const el = els['cap-cursor'];
    const cap = state.current;
    if (!el || !cap) return;
    const a = state.cursorA !== null ? state.cursorA : cap.trigger_index;
    const b = state.cursorB !== null ? state.cursorB : cap.trigger_index;
    const taMs = ((a - cap.trigger_index) / cap.sample_hz) * 1000;
    const tbMs = ((b - cap.trigger_index) / cap.sample_hz) * 1000;
    const dtMs = tbMs - taMs;
    const invHz = Math.abs(dtMs) > 1e-9 ? (1000 / Math.abs(dtMs)).toFixed(2) + ' Hz' : '∞';
    // 默认展示阶跃响应通道或第 0 通道在 A/B 处的数值差
    const chIdx = els['step-y'] ? (Number(els['step-y'].value) | 0) : 0;
    const col = cap.channels[Math.min(cap.nch - 1, Math.max(0, chIdx))] || cap.channels[0];
    const ya = col[a] !== undefined ? col[a] : 0;
    const yb = col[b] !== undefined ? col[b] : 0;
    const dy = yb - ya;
    const chName = cap.names[chIdx] || `CH${chIdx}`;
    el.textContent = `光标 A (#${a}): t=${taMs.toFixed(3)} ms, ${chName}=${Number(ya.toPrecision(5))}  |  `
      + `光标 B (#${b}): t=${tbMs.toFixed(3)} ms, ${chName}=${Number(yb.toPrecision(5))}  |  `
      + `Δt=${dtMs.toFixed(3)} ms (1/|Δt|=${invHz}), Δ${chName}=${Number(dy.toPrecision(5))}`;
  }

  function drawCaptureCanvas() {
    const canvas = els['capCanvas'];
    if (!canvas || !canvas.getContext) return;
    const c = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    c.clearRect(0, 0, w, h);

    // 网格
    c.strokeStyle = TH.grid;
    c.lineWidth = 1;
    for (let y = 24; y < h; y += 44) {
      c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
    }
    for (let x = 0; x < w; x += Math.max(60, Math.floor(w / 10))) {
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke();
    }

    const cap = state.current;
    if (!cap) return;

    const s0 = Math.max(0, state.viewStart | 0);
    const s1 = Math.max(s0 + 2, Math.min(cap.total, state.viewEnd | 0));
    const n = s1 - s0;
    const xOfIdx = idx => ((idx - s0) / Math.max(1, n - 1)) * w;

    // 各可见通道独立归一化缩放 (保留一张纵轴范围表用于叠加阶跃标记)
    const chRanges = [];
    for (let i = 0; i < cap.nch; i++) {
      if (state.visible[i] === false) continue;
      const a = cap.channels[i];
      let lo = Infinity, hi = -Infinity;
      for (let k = s0; k < s1; k++) {
        const v = a[k];
        if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
      }
      if (!Number.isFinite(lo)) continue;
      const pad = Math.max((hi - lo) * 0.1, Math.abs(hi) * 0.02, 1e-6);
      chRanges[i] = [lo - pad, hi + pad];
    }

    const yIn = (v, r) => h - 14 - ((v - r[0]) / (r[1] - r[0])) * (h - 28);

    // 绘制各通道曲线
    const perPx = n / Math.max(1, w);
    for (let i = 0; i < cap.nch; i++) {
      if (state.visible[i] === false || !chRanges[i]) continue;
      const a = cap.channels[i];
      const r = chRanges[i];
      c.strokeStyle = COLORS[i % COLORS.length];
      c.lineWidth = 1.6;
      c.beginPath();
      if (perPx <= 1.5) {
        for (let k = s0; k < s1; k++) {
          const x = xOfIdx(k);
          const y = yIn(a[k], r);
          if (k === s0) c.moveTo(x, y); else c.lineTo(x, y);
        }
      } else {
        for (let px = 0; px < w; px++) {
          const k0 = s0 + Math.floor(px * perPx);
          const k1 = Math.min(s1, s0 + Math.floor((px + 1) * perPx));
          let mn = Infinity, mx = -Infinity;
          for (let k = k0; k < k1; k++) {
            const v = a[k];
            if (v < mn) mn = v;
            if (v > mx) mx = v;
          }
          if (!Number.isFinite(mn)) continue;
          if (px === 0) c.moveTo(px, yIn(mn, r)); else c.lineTo(px, yIn(mn, r));
          c.lineTo(px, yIn(mx, r));
        }
      }
      c.stroke();
    }

    // 触发位置竖线 (黄色虚线)
    if (cap.trigger_index >= s0 && cap.trigger_index < s1) {
      const tx = xOfIdx(cap.trigger_index);
      c.strokeStyle = TH.trigger;
      c.lineWidth = 1.2;
      c.setLineDash([4, 4]);
      c.beginPath(); c.moveTo(tx, 0); c.lineTo(tx, h); c.stroke();
      c.setLineDash([]);
      c.fillStyle = TH.trigger;
      c.font = '11px monospace';
      c.fillText('T=0 (Trig)', Math.min(w - 70, tx + 4), 14);
    }

    // 若当前在阶跃响应页且有分析结果，叠加阶跃特征点 (峰值点 & 调节时间线)
    if (state.activeTab === 'step' && state.lastStepResult && state.lastStepResult.ok) {
      const sr = state.lastStepResult;
      const yCh = els['step-y'] ? (Number(els['step-y'].value) | 0) : Math.min(1, cap.nch - 1);
      const r = chRanges[yCh];
      if (r) {
        // 终值水平参考线 yf
        const y1Px = yIn(sr.yf, r);
        c.strokeStyle = TH.band;
        c.setLineDash([2, 4]);
        c.beginPath(); c.moveTo(0, y1Px); c.lineTo(w, y1Px); c.stroke();
        c.setLineDash([]);

        // 峰值点圆圈
        const idxPeak = sr.marks && sr.marks.peak !== null ? sr.marks.peak : -1;
        if (idxPeak >= s0 && idxPeak < s1) {
          const px = xOfIdx(idxPeak);
          const yPeakVal = cap.channels[yCh][idxPeak];
          const py = yIn(yPeakVal, r);
          c.fillStyle = TH.peak;
          c.beginPath(); c.arc(px, py, 4, 0, Math.PI * 2); c.fill();
          c.fillText(`Peak (${sr.overshootPct.toFixed(1)}%)`, Math.min(w - 95, px + 6), Math.max(14, py - 6));
        }
      }
    }

    // 光标 A / B
    const drawCursor = (idx, label, color) => {
      if (idx === null || idx < s0 || idx >= s1) return;
      const x = xOfIdx(idx);
      c.strokeStyle = color;
      c.lineWidth = 1;
      c.setLineDash([2, 2]);
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke();
      c.setLineDash([]);
      c.fillStyle = color;
      c.font = '11px monospace';
      c.fillText(label, Math.min(w - 20, x + 3), h - 6);
    };
    drawCursor(state.cursorA, 'A', TH.cursorA);
    drawCursor(state.cursorB, 'B', TH.cursorB);

    // 顶部视图范围提示
    c.fillStyle = TH.text;
    c.font = '11px monospace';
    const t0Ms = (((s0 - cap.trigger_index) / cap.sample_hz) * 1000).toFixed(2);
    const t1Ms = (((s1 - 1 - cap.trigger_index) / cap.sample_hz) * 1000).toFixed(2);
    c.fillText(`视图: [${t0Ms} ms .. ${t1Ms} ms] (${n}/${cap.total} 点)`, 6, 14);
  }

  // =========================================================================
  // 5. 三大分析引擎渲染 (阶跃响应 / FFT / STFT)
  // =========================================================================

  function runActiveAnalysis() {
    if (!state.current) return;
    if (state.activeTab === 'step') runStepAnalysis();
    else if (state.activeTab === 'fft') runFftAnalysis();
    else if (state.activeTab === 'stft') runStftAnalysis();
  }

  function renderMetricsTable(container, items) {
    if (!container) return;
    container.textContent = '';
    const grid = document.createElement('div');
    grid.className = 'cap-metrics-grid';
    items.forEach(({ label, value, sub, highlight }) => {
      const box = document.createElement('div');
      box.className = 'cap-metric-box' + (highlight ? ' highlight' : '');
      const lEl = document.createElement('div');
      lEl.className = 'cap-metric-label';
      lEl.textContent = label;
      const vEl = document.createElement('div');
      vEl.className = 'cap-metric-value';
      vEl.textContent = value;
      box.append(lEl, vEl);
      if (sub) {
        const sEl = document.createElement('div');
        sEl.className = 'cap-metric-sub';
        sEl.textContent = sub;
        box.appendChild(sEl);
      }
      grid.appendChild(box);
    });
    container.appendChild(grid);
  }

  function runStepAnalysis() {
    const A = getAnalysis();
    const cap = state.current;
    const box = els['step-result'];
    if (!A || !cap) return null;

    const refIdx = els['step-ref'] ? (Number(els['step-ref'].value) | 0) : 0;
    const yIdx = els['step-y'] ? (Number(els['step-y'].value) | 0) : Math.min(1, cap.nch - 1);
    const riseParts = (els['step-rise'] ? els['step-rise'].value : '0.1,0.9').split(',').map(Number);
    const settleBand = els['step-band'] ? Number(els['step-band'].value) : 0.02;
    const smooth = els['step-smooth'] ? Math.max(1, Number(els['step-smooth'].value) | 0) : 1;

    const ref = cap.channels[Math.min(cap.nch - 1, Math.max(0, refIdx))];
    const y = cap.channels[Math.min(cap.nch - 1, Math.max(0, yIdx))];
    const res = A.stepResponse(y, cap.sample_hz, {
      ref,
      rise: [riseParts[0] || 0.1, riseParts[1] || 0.9],
      band: settleBand || 0.02,
      smooth
    });
    state.lastStepResult = res;

    if (!res.ok) {
      if (box) box.textContent = `⚠️ 阶跃分析未完成: ${res.reason}`;
      return res;
    }

    const fmtMs = s => (typeof s === 'number' && Number.isFinite(s)) ? `${(s * 1000).toFixed(3)} ms` : '未收敛/越界';
    const items = [
      {
        label: '阶跃激励 / 稳态响应',
        value: `y0=${res.y0.toPrecision(4)} → yf=${res.yf.toPrecision(4)}`,
        sub: `响应幅值 Δy=${res.amplitude.toPrecision(4)}${res.refFinal !== null ? `, 参考终值=${res.refFinal.toPrecision(4)}` : ''}`
      },
      {
        label: '延迟时间 td (0→50%)',
        value: fmtMs(res.delayTime),
        sub: `阶跃起点 #${res.stepIndex} (t0=${((res.stepIndex / cap.sample_hz) * 1000).toFixed(2)} ms)`
      },
      {
        label: `上升时间 tr (${Math.round((riseParts[0] || 0.1) * 100)}%→${Math.round((riseParts[1] || 0.9) * 100)}%)`,
        value: fmtMs(res.riseTime),
        highlight: true
      },
      {
        label: '峰值时间 tp',
        value: fmtMs(res.peakTime),
        sub: `峰值下标 #${res.marks.peak}`
      },
      {
        label: '超调量 σ%',
        value: `${res.overshootPct.toFixed(2)} %`,
        sub: res.overshootPct > 25 ? '超调偏大 (可适当减小 Kp 或增大 Kd)' : '阻尼良好',
        highlight: true
      },
      {
        label: `调节时间 ts (±${Math.round(settleBand * 100)}%)`,
        value: fmtMs(res.settlingTime),
        highlight: true
      },
      {
        label: '稳态误差 ess',
        value: res.steadyStateError !== null ? Number(res.steadyStateError.toPrecision(4)).toString() : '--',
        sub: res.steadyStateError !== null && Math.abs(res.amplitude) > 1e-9
          ? `相对响应幅值 ${((Math.abs(res.steadyStateError) / Math.abs(res.amplitude)) * 100).toFixed(2)} %`
          : ''
      },
      {
        label: '等效二阶模型估计',
        value: res.zeta !== null ? `ζ ≈ ${res.zeta.toFixed(3)}` : '无明显超调 (ζ ≥ 1)',
        sub: res.wn !== null ? `ωn ≈ ${res.wn.toFixed(1)} rad/s (fn ≈ ${(res.wn / (2 * Math.PI)).toFixed(1)} Hz)` : '一阶或过阻尼响应'
      }
    ];
    renderMetricsTable(box, items);
    return res;
  }

  function getRangeSlice(arr, trigIdx, mode) {
    if (mode === 'post' && trigIdx < arr.length - 8) return arr.slice(trigIdx);
    if (mode === 'pre' && trigIdx >= 8) return arr.slice(0, trigIdx);
    return arr;
  }

  function runFftAnalysis() {
    const A = getAnalysis();
    const cap = state.current;
    if (!A || !cap) return null;

    const chIdx = els['fft-ch'] ? (Number(els['fft-ch'].value) | 0) : 0;
    const winName = els['fft-win'] ? els['fft-win'].value : 'hann';
    const rangeMode = els['fft-range'] ? els['fft-range'].value : 'all';
    const f1Input = els['fft-f1'] ? Number(els['fft-f1'].value) : 0;

    const raw = cap.channels[Math.min(cap.nch - 1, Math.max(0, chIdx))];
    const seg = getRangeSlice(raw, cap.trigger_index, rangeMode);
    if (seg.length < 8) return null;

    const spec = A.spectrum(seg, cap.sample_hz, { window: winName, maxPeaks: 5 });
    if (!spec) return null;
    const peaks = spec.peaks || [];
    const f1 = f1Input > 0 ? f1Input : (peaks[0] ? peaks[0].f : 0);
    const thdRes = f1 > 0 ? A.thd(spec, f1, 5) : null;

    state.lastFftResult = { spec, peaks, thdRes, fs: cap.sample_hz };
    drawFftCanvas();

    const box = els['fft-result'];
    if (box) {
      const topPeak = peaks[0];
      const peakListStr = peaks.map((p, idx) => `#${idx + 1}: ${p.f.toFixed(1)}Hz (${p.amp.toPrecision(4)}, ${p.db.toFixed(1)}dB)`).join('  |  ');
      renderMetricsTable(box, [
        {
          label: '主峰频率 / 幅值',
          value: topPeak ? `${topPeak.f.toFixed(2)} Hz (${topPeak.amp.toPrecision(4)})` : '无明显峰值',
          sub: topPeak ? `幅值电平 ${topPeak.db.toFixed(2)} dB` : '',
          highlight: true
        },
        {
          label: '总谐波失真 (THD)',
          value: (thdRes && Number.isFinite(thdRes.thdPct)) ? `${thdRes.thdPct.toFixed(3)} %` : '--',
          sub: thdRes ? `基波 f1=${f1.toFixed(2)} Hz, A1=${thdRes.fundamental.toPrecision(4)} (统计 ${thdRes.harmonicsUsed} 次谐波)` : '',
          highlight: true
        },
        {
          label: 'FFT 规模与分辨率',
          value: `N=${spec.nfft} 点, Δf=${spec.df.toFixed(2)} Hz`,
          sub: `窗函数: ${winName} (原序列 ${spec.n} 点)`
        },
        {
          label: '前 5 大谱峰列表',
          value: peakListStr || '无'
        }
      ]);
    }
    return state.lastFftResult;
  }

  function drawFftCanvas() {
    const canvas = els['fftCanvas'];
    if (!canvas || !canvas.getContext || !state.lastFftResult) return;
    const c = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    c.clearRect(0, 0, w, h);

    const { spec, peaks, fs } = state.lastFftResult;
    const scaleMode = els['fft-scale'] ? els['fft-scale'].value : 'db';
    const fmaxInput = els['fft-fmax'] ? Number(els['fft-fmax'].value) : 0;
    const nyquist = fs / 2;
    const fMax = (fmaxInput > 0 && fmaxInput <= nyquist) ? fmaxInput : nyquist;
    const maxBin = Math.max(2, Math.min(spec.freq.length - 1, Math.ceil(fMax / spec.df)));

    const padL = 48, padR = 16, padT = 18, padB = 26;
    const pw = Math.max(50, w - padL - padR);
    const ph = Math.max(40, h - padT - padB);

    // 背景网格
    c.strokeStyle = TH.grid;
    c.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padT + (i / 4) * ph;
      c.beginPath(); c.moveTo(padL, y); c.lineTo(padL + pw, y); c.stroke();
    }

    let yMin = 0, yMax = 1;
    if (scaleMode === 'db') {
      let mxDb = -120;
      for (let k = 1; k <= maxBin; k++) if (spec.db[k] > mxDb) mxDb = spec.db[k];
      yMax = Math.ceil(mxDb / 10) * 10 + 5;
      yMin = yMax - 90;
    } else {
      let mxLin = 1e-6;
      for (let k = 1; k <= maxBin; k++) if (spec.amp[k] > mxLin) mxLin = spec.amp[k];
      yMax = mxLin * 1.12;
      yMin = 0;
    }

    const xOfFreq = f => padL + (f / fMax) * pw;
    const yOfVal = v => padT + (1 - Math.max(0, Math.min(1, (v - yMin) / Math.max(1e-9, yMax - yMin)))) * ph;

    // 频谱曲线
    c.strokeStyle = TH.spectrum;
    c.lineWidth = 1.5;
    c.beginPath();
    for (let k = 0; k <= maxBin; k++) {
      const x = xOfFreq(spec.freq[k]);
      const v = scaleMode === 'db' ? spec.db[k] : spec.amp[k];
      const y = yOfVal(v);
      if (k === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();

    // 峰值标注
    c.fillStyle = TH.peak;
    c.font = '11px monospace';
    peaks.slice(0, 5).forEach((p, idx) => {
      if (p.f > fMax) return;
      const x = xOfFreq(p.f);
      const v = scaleMode === 'db' ? p.db : p.amp;
      const y = yOfVal(v);
      c.beginPath(); c.arc(x, y, 3.5, 0, Math.PI * 2); c.fill();
      c.fillText(`${p.f.toFixed(0)}Hz`, Math.min(w - 55, x + 4), Math.max(14, y - 4 - (idx % 2) * 10));
    });

    // 坐标轴刻度
    c.fillStyle = TH.text;
    c.font = '11px monospace';
    c.fillText(scaleMode === 'db' ? `${yMax.toFixed(0)}dB` : yMax.toPrecision(3), 4, padT + 8);
    c.fillText(scaleMode === 'db' ? `${yMin.toFixed(0)}dB` : '0', 4, padT + ph);
    for (let i = 0; i <= 5; i++) {
      const f = (i / 5) * fMax;
      const x = xOfFreq(f);
      c.fillText(`${f >= 1000 ? (f / 1000).toFixed(2) + 'k' : f.toFixed(0)}Hz`, Math.max(padL, x - 18), h - 6);
    }
  }

  function runStftAnalysis() {
    const A = getAnalysis();
    const cap = state.current;
    if (!A || !cap) return null;

    const chIdx = els['stft-ch'] ? (Number(els['stft-ch'].value) | 0) : 0;
    const winSize = els['stft-win'] ? (Number(els['stft-win'].value) | 0) : 256;
    const ovl = els['stft-ovl'] ? Number(els['stft-ovl'].value) : 0.75;
    const hop = Math.max(1, Math.round(winSize * (1 - ovl)));

    const raw = cap.channels[Math.min(cap.nch - 1, Math.max(0, chIdx))];
    const res = A.stft(raw, cap.sample_hz, { win: winSize, hop, window: 'hann' });
    if (!res) return null;

    // 寻找时频能量峰值坐标
    let peakDb = -200, peakT = 0, peakF = 0;
    for (let ti = 0; ti < res.times.length; ti++) {
      const col = res.db[ti];
      for (let fi = 1; fi < col.length; fi++) {
        if (col[fi] > peakDb) {
          peakDb = col[fi];
          peakT = res.times[ti];
          peakF = res.freqs[fi];
        }
      }
    }
    res.maxDb = peakDb;
    state.lastStftResult = res;
    drawStftCanvas();

    const box = els['stft-result'];
    if (box) {
      const dtMs = ((hop / cap.sample_hz) * 1000).toFixed(2);
      const dfHz = (cap.sample_hz / winSize).toFixed(2);
      renderMetricsTable(box, [
        {
          label: 'STFT 时频网格规模',
          value: `${res.times.length} 帧 × ${res.freqs.length} 频点`,
          sub: `窗长=${winSize}, 步进 hop=${hop} 点 (重叠 ${(ovl * 100).toFixed(1)}%)`
        },
        {
          label: '时间步进 / 频率分辨率',
          value: `Δt = ${dtMs} ms  |  Δf = ${dfHz} Hz`,
          highlight: true
        },
        {
          label: '全局最强时频能量点',
          value: `f = ${peakF.toFixed(1)} Hz @ t = ${(peakT * 1000).toFixed(1)} ms`,
          sub: `峰值电平 ${peakDb.toFixed(1)} dB`,
          highlight: true
        }
      ]);
    }
    return res;
  }

  // 热力图配色映射 (0..1 -> RGB: 深蓝 -> 紫 -> 橙红 -> 亮黄)
  function colormapMagma(t) {
    const x = Math.max(0, Math.min(1, t));
    const r = Math.round(255 * Math.min(1, Math.max(0, 1.6 * x - 0.1)));
    const g = Math.round(255 * Math.pow(x, 2.2));
    const b = Math.round(255 * (x < 0.5 ? 0.25 + 1.2 * x : 1.35 - 1.5 * x));
    return [r, g, Math.max(0, Math.min(255, b))];
  }

  function drawStftCanvas() {
    const canvas = els['stftCanvas'];
    if (!canvas || !canvas.getContext || !state.lastStftResult) return;
    const c = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    c.clearRect(0, 0, w, h);

    const res = state.lastStftResult;
    const nT = res.times.length;
    const nF = res.freqs.length;
    if (nT === 0 || nF === 0) return;

    const dynRange = els['stft-range'] ? Math.max(20, Number(els['stft-range'].value) || 80) : 80;
    const maxDb = res.maxDb || 0;
    const minDb = maxDb - dynRange;

    const padL = 52, padR = 16, padT = 14, padB = 26;
    const pw = Math.max(50, w - padL - padR);
    const ph = Math.max(40, h - padT - padB);

    const cellW = pw / nT;
    const cellH = ph / nF;

    for (let ti = 0; ti < nT; ti++) {
      const col = res.db[ti];
      const x0 = Math.floor(padL + ti * cellW);
      const x1 = Math.ceil(padL + (ti + 1) * cellW);
      for (let fi = 0; fi < nF; fi++) {
        const norm = (col[fi] - minDb) / dynRange;
        const [r, g, b] = colormapMagma(norm);
        c.fillStyle = `rgb(${r},${g},${b})`;
        const y0 = Math.floor(padT + (nF - 1 - fi) * cellH);
        const y1 = Math.ceil(padT + (nF - fi) * cellH);
        c.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
      }
    }

    // 坐标轴文字
    c.fillStyle = TH.text;
    c.font = '11px monospace';
    const fMax = res.freqs[nF - 1] || 1;
    c.fillText(`${fMax >= 1000 ? (fMax / 1000).toFixed(1) + 'k' : fMax.toFixed(0)}Hz`, 4, padT + 10);
    c.fillText(`${(fMax / 2) >= 1000 ? (fMax / 2000).toFixed(1) + 'k' : (fMax / 2).toFixed(0)}Hz`, 4, padT + ph / 2);
    c.fillText('0Hz', 18, padT + ph);

    const cap = state.current;
    const trigS = cap ? (cap.trigger_index / cap.sample_hz) : 0;
    for (let i = 0; i <= 4; i++) {
      const ti = Math.min(nT - 1, Math.floor((i / 4) * (nT - 1)));
      const tMs = ((res.times[ti] - trigS) * 1000).toFixed(1);
      const x = padL + (i / 4) * pw;
      c.fillText(`${tMs}ms`, Math.max(padL, x - 18), h - 6);
    }
  }

  // =========================================================================
  // 6. 导出 CSV 与 JSON
  // =========================================================================

  function triggerDownload(content, filename, mime) {
    if (typeof document === 'undefined') return;
    const blob = new Blob([content], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function exportCurrentCsv() {
    const A = getAnalysis();
    const cap = state.current;
    if (!A || !cap) {
      logTerm('system', '⚠️ 尚无采集数据可导出');
      return null;
    }
    const csv = A.toCSV(cap, cap.names);
    triggerDownload(csv, `capture_${cap.cap_id}_${cap.sample_hz}Hz.csv`, 'text/csv;charset=utf-8');
    return csv;
  }

  function exportCurrentJson() {
    const cap = state.current;
    if (!cap) {
      logTerm('system', '⚠️ 尚无采集数据可导出');
      return null;
    }
    const json = JSON.stringify(cap, null, 2);
    triggerDownload(json, `capture_${cap.cap_id}_${cap.sample_hz}Hz.json`, 'application/json;charset=utf-8');
    return json;
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    window.addEventListener('DOMContentLoaded', bindDom);
  }

  return {
    state,
    parseCapAck,
    buildCfgCommand,
    normalizeCapture,
    onConnected,
    onStatus,
    onAck,
    onCapture,
    importCh1Snapshot,
    clearHistory,
    onThemeChange,
    runStepAnalysis,
    runFftAnalysis,
    runStftAnalysis,
    exportCurrentCsv,
    exportCurrentJson,
    bindDom
  };
});
