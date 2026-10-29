/**
 * STM32 SEGGER RTT 实时调参网页前端控制逻辑
 * 支持双向 WebSocket 通信、实时参数下发、ACK 往返时延测量与动态波形渲染
 */

(function () {
  'use strict';

  // ================= 状态与配置 =================
  let ws = null;
  let isConnected = false;
  let autoSyncEnabled = true;
  let pendingSends = new Map(); // param_name -> timestamp
  let dynamicParams = new Map(); // param_name -> meta

  // 遥测波形数据缓冲
  const MAX_HISTORY = 100;
  const telemetryHistory = {
    target: new Array(MAX_HISTORY).fill(0),
    actual: new Array(MAX_HISTORY).fill(0)
  };

  // ================= DOM 元素映射 =================
  const els = {
    connMode: document.getElementById('conn-mode'),
    chipPreset: document.getElementById('chip-preset'),
    pylinkParams: document.getElementById('pylink-params'),
    telnetParams: document.getElementById('telnet-params'),
    openocdParams: document.getElementById('openocd-params'),
    targetChip: document.getElementById('target-chip'),
    telnetHost: document.getElementById('telnet-host'),
    telnetPort: document.getElementById('telnet-port'),
    openocdTarget: document.getElementById('openocd-target'),
    openocdRam: document.getElementById('openocd-ram'),
    btnConnect: document.getElementById('btn-connect'),
    statusLed: document.getElementById('status-led'),
    statusText: document.getElementById('status-text'),
    latencyVal: document.getElementById('latency-val'),
    btnPing: document.getElementById('btn-ping'),
    btnRefreshAll: document.getElementById('btn-refresh-all'),
    autoSyncToggle: document.getElementById('auto-sync-toggle'),
    btnSyncAllPid: document.getElementById('btn-sync-all-pid'),
    switchMotor: document.getElementById('switch-motor_en'),
    dynamicContainer: document.getElementById('dynamic-params-container'),
    dynamicCount: document.getElementById('dynamic-param-count'),
    termOutput: document.getElementById('terminal-output'),
    termInput: document.getElementById('term-input'),
    btnTermSend: document.getElementById('btn-term-send'),
    btnClearTerm: document.getElementById('btn-clear-term'),
    autoScrollCheck: document.getElementById('auto-scroll-check'),
    filterTelemetryCheck: document.getElementById('filter-telemetry-check'),
    canvas: document.getElementById('telemetryCanvas'),
    teleRateBadge: document.getElementById('tele-rate-badge'),
    btnClearTele: document.getElementById('btn-clear-tele'),
    telemetryGrid: document.getElementById('telemetry-grid')
  };

  const ctx = els.canvas.getContext('2d');

  // ================= 初始化与事件绑定 =================

  function init() {
    setupModeSelector();
    setupChipPresets();
    setupWebSocket();
    setupTelemetryDashboard();
    setupParamBindings();
    setupPidControls();
    setupModeButtons();
    setupMotorSwitch();
    setupTerminal();
    setupCanvas();
    startRenderLoop();
    setupWavePanel();
    setupSliderModeToggle();
    if (window.RTTTheme && typeof window.RTTTheme.onChange === 'function') {
      window.RTTTheme.onChange(() => { canvasTheme = themeCanvas(); });
    }

    els.btnConnect.addEventListener('click', toggleConnect);
    els.btnPing.addEventListener('click', sendPing);
    els.btnRefreshAll.addEventListener('click', () => sendRttCommand('$GET:ALL'));
    els.autoSyncToggle.addEventListener('change', (e) => {
      autoSyncEnabled = e.target.checked;
      syncSliderModeEnabled();
    });
  }

  // v3.1 主题: 画布颜色取自 theme.js (CSS 变量无法用于 canvas); 未加载 theme.js 时使用深色默认值
  function themeCanvas() {
    return (window.RTTTheme && typeof window.RTTTheme.canvas === 'function')
      ? window.RTTTheme.canvas()
      : { grid: '#1e2430', target: '#58a6ff', actual: '#3fb950' };
  }
  let canvasTheme = themeCanvas();

  // ================= 芯片预设切换 =================
  // v3 P0: 预设来自 chips.json (与网关共用的单一数据源)。加载失败 (如直接用 file:// 打开) 时
  // 保留 index.html 中的静态选项, 并使用下方最小内置表。
  const chipProfiles = {
    h723: { part: 'STM32H723VG', openocd_target: 'stm32h7x', ram_base: '0x24000000' }
  };

  function applyChipProfile(id) {
    const cfg = chipProfiles[id];
    if (!cfg) return;
    if (els.targetChip) els.targetChip.value = cfg.part;
    if (els.openocdTarget) els.openocdTarget.value = cfg.openocd_target;
    if (els.openocdRam) els.openocdRam.value = cfg.ram_base;
    const extra = cfg.rtt_scan_size ? `, 扫描 ${cfg.rtt_scan_size}` : '';
    logTerminal('system', `已切换芯片预设: ${cfg.part} (OpenOCD: ${cfg.openocd_target}, RAM: ${cfg.ram_base}${extra})${cfg.note ? ' — ' + cfg.note : ''}`);
  }

  function setupChipPresets() {
    if (!els.chipPreset) return;
    els.chipPreset.addEventListener('change', (e) => applyChipProfile(e.target.value));
    fetch('chips.json', { cache: 'no-cache' })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(data => {
        const list = Array.isArray(data.chips) ? data.chips : [];
        if (!list.length) return;
        const prev = els.chipPreset.value;
        els.chipPreset.textContent = '';
        list.forEach(c => {
          chipProfiles[c.id] = c;
          const opt = document.createElement('option');
          opt.value = c.id;
          opt.textContent = c.board ? `${c.label} ★` : c.label;   // ★ = 用户手头有开发板
          opt.title = c.note || '';
          els.chipPreset.appendChild(opt);
        });
        const custom = document.createElement('option');
        custom.value = 'custom';
        custom.textContent = '自定义...';
        els.chipPreset.appendChild(custom);
        els.chipPreset.value = chipProfiles[prev] ? prev : list[0].id;
      })
      .catch(err => logTerminal('system', `chips.json 加载失败, 使用内置预设 (${err.message})`));
  }

  // ================= 连接模式切换 =================

  function setupModeSelector() {
    els.connMode.addEventListener('change', (e) => {
      const mode = e.target.value;
      els.pylinkParams.classList.toggle('hidden', mode !== 'pylink');
      els.telnetParams.classList.toggle('hidden', mode !== 'telnet');
      if (els.openocdParams) {
        els.openocdParams.classList.toggle('hidden', mode !== 'stlink' && mode !== 'daplink');
      }
    });
  }

  // ================= WebSocket 客户端 =================

  function setupWebSocket() {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHost = window.location.host || '127.0.0.1:8765';
    const wsUrl = `${wsProtocol}//${wsHost}/ws`;

    logTerminal('system', `正在连接调参网关服务 (${wsUrl})...`);

    try {
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';   // v3.1: Ch1 波形以二进制帧推送

      ws.onopen = () => {
        logTerminal('system', '✅ WebSocket 网关已成功握手');
        waveSubscribe();
        sendJson({ type: 'get_status' });
      };

      ws.onmessage = (event) => {
        if (typeof event.data === 'string') handleServerMessage(event.data);
        else handleWaveBinary(event.data);
      };

      ws.onclose = () => {
        setConnectionState(false, '网关断开');
        logTerminal('system', '❌ 与 Python 网关服务连接中断，3秒后尝试重连...');
        setTimeout(setupWebSocket, 3000);
      };

      ws.onerror = () => {
        setConnectionState(false, '连接错误');
      };
    } catch (err) {
      logTerminal('system', `WebSocket 初始化异常: ${err}`);
    }
  }

  function sendJson(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  function sendRttCommand(raw) {
    if (!isConnected) {
      logTerminal('system', '⚠️ 目标单片机未连接，请先点击【连接目标】');
      return;
    }
    sendJson({ type: 'send_rtt', raw: raw });
  }

  function sendPing() {
    if (!isConnected) return;
    pendingSends.set('$PING', performance.now());
    sendJson({ type: 'ping' });
  }

  // ================= 消息分发 =================

  function handleServerMessage(rawText) {
    try {
      const msg = JSON.parse(rawText);

      switch (msg.type) {
        case 'status':
          updateConnectionStatus(msg);
          if (msg.connected && window.RTTCapturePanel && typeof window.RTTCapturePanel.onConnected === 'function') {
            window.RTTCapturePanel.onConnected();
          }
          break;

        case 'connect_result':
          logTerminal(msg.success ? 'system' : 'ack-err', msg.message);
          if (msg.status) updateConnectionStatus(msg.status);
          if (msg.success && msg.status && msg.status.connected) waveOnConnected();
          if (msg.success && window.RTTCapturePanel && typeof window.RTTCapturePanel.onConnected === 'function') {
            window.RTTCapturePanel.onConnected();
          }
          break;

        case 'rtt_tx':
          logTerminal('tx', `[TX -> MCU] ${msg.data.trim()}`);
          break;

        case 'rtt_rx':
          if (msg.fragment) {
            // FIX-018: 网关检测到行内粘连帧头, 前段为残帧 (已丢弃, 不进入看板/波形)
            logTerminal('ack-err', `[RX <- MCU][残帧已丢弃] ${msg.data}`);
          } else if (!msg.data.startsWith('$DATA:') || !els.filterTelemetryCheck.checked) {
            logTerminal('rx', `[RX <- MCU] ${msg.data}`);
          }
          break;

        case 'ack':
          handleAckMessage(msg);
          waveOnAck(msg);
          break;

        case 'pong':
          handlePong(msg);
          break;

        case 'param_meta':
          handleParamMeta(msg);
          break;

        case 'param_list_sync_done':
          logTerminal('system', `✅ 参数列表同步完成 (共 ${msg.count} 个注册变量)`);
          break;

        case 'telemetry':
          handleTelemetry(msg.payload);
          // FIX-018: 网关不再为 $DATA 重复发送 rtt_rx, 终端显示改由此处按"过滤"复选框决定
          if (!els.filterTelemetryCheck.checked) {
            logTerminal('rx', `[RX <- MCU] $DATA:${msg.payload}`);
          }
          break;

        case 'error':
          logTerminal('ack-err', `[ERROR] ${msg.message}`);
          break;

        case 'wave':
          handleWave(msg);
          break;

        case 'wave_subscribed':
          wave.sub = msg;
          updateWaveInfo();
          if (wave.settingsOpen) buildWaveSettingsPanel();
          break;

        case 'wave_status':
          logTerminal(msg.connected ? 'system' : 'ack-err', `[Ch1] ${msg.message}`);
          if (!msg.connected && els.waveInfo) els.waveInfo.textContent = 'Ch1 未连接';
          break;

        case 'capture':
          if (window.RTTCapturePanel && typeof window.RTTCapturePanel.onCapture === 'function') {
            window.RTTCapturePanel.onCapture(msg);
          }
          break;

        case 'capture_status':
          if (window.RTTCapturePanel && typeof window.RTTCapturePanel.onStatus === 'function') {
            window.RTTCapturePanel.onStatus(msg);
          }
          break;

        case 'cap_ack':
          if (window.RTTCapturePanel && typeof window.RTTCapturePanel.onAck === 'function') {
            window.RTTCapturePanel.onAck(msg);
          }
          break;
      }
    } catch (e) {
      logTerminal('rx', rawText);
    }
  }

  // ================= 状态与 ACK 处理 =================

  function setConnectionState(connected, label) {
    isConnected = connected;
    els.statusLed.className = 'status-led ' + (connected ? 'connected' : 'disconnected');
    els.statusText.textContent = label;

    if (connected) {
      els.btnConnect.classList.add('disconnecting');
      els.btnConnect.querySelector('.btn-text').textContent = '断开连接';
    } else {
      els.btnConnect.classList.remove('disconnecting');
      els.btnConnect.querySelector('.btn-text').textContent = '连接目标';
      els.latencyVal.textContent = '-- ms';
    }
  }

  function updateConnectionStatus(status) {
    if (status.connected) {
      const modeNames = {
        mock: '仿真模拟',
        pylink: `J-Link (${status.target})`,
        telnet: `Telnet (${status.host}:${status.port})`,
        stlink: `ST-Link (${status.openocd_target || 'OpenOCD'})`,
        daplink: `DAP-Link (${status.openocd_target || 'OpenOCD'})`
      };
      setConnectionState(true, modeNames[status.mode] || '已连接');
    } else {
      setConnectionState(false, '未连接');
    }
  }

  function toggleConnect() {
    if (isConnected) {
      sendJson({ type: 'disconnect' });
    } else {
      const mode = els.connMode.value;
      const target = els.targetChip.value.trim() || 'STM32H723VG';
      const host = els.telnetHost.value.trim() || '127.0.0.1';
      const port = parseInt(els.telnetPort.value.trim()) || 19021;
      const ocdTarget = els.openocdTarget ? (els.openocdTarget.value.trim() || 'stm32h7x') : 'stm32h7x';
      const ocdRam = els.openocdRam ? (els.openocdRam.value.trim() || '0x24000000') : '0x24000000';
      // 无线 DAPLink 适配: SWD 时钟可选 (原先写死 4000; WCH 无线 DAPLink 实测 4MHz 掉线, 1MHz 稳定)
      const speedSel = document.getElementById('openocd-speed');
      const ocdSpeed = (speedSel && (mode === 'stlink' || mode === 'daplink'))
        ? (parseInt(speedSel.value, 10) || 4000) : 4000;

      els.statusLed.className = 'status-led connecting';
      els.statusText.textContent = '正在连接...';

      sendJson({
        type: 'connect',
        mode: mode,
        target: target,
        host: host,
        port: port,
        speed: ocdSpeed,
        openocd_target: ocdTarget,
        openocd_ram: ocdRam,
        chip: els.chipPreset ? els.chipPreset.value : null
      });
    }
  }

  function handlePong(msg) {
    if (msg.latency_ms !== null && msg.latency_ms !== undefined) {
      els.latencyVal.textContent = `${msg.latency_ms} ms`;
      logTerminal('system', `⏱️ 心跳延迟: ${msg.latency_ms} ms`);
    }
  }

  function handleAckMessage(msg) {
    const tNow = performance.now();
    const param = msg.param;

    if (msg.success) {
      // 计算时延
      let lat = msg.latency_ms;
      if (lat === null || lat === undefined) {
        if (pendingSends.has(param)) {
          lat = Math.round(tNow - pendingSends.get(param));
          pendingSends.delete(param);
        }
      }
      const latStr = lat !== null && lat !== undefined ? ` (${lat}ms)` : '';

      logTerminal('ack-ok', `[ACK 收到] ✅ ${param} = ${msg.val}${latStr}`);

      // 更新对应参数 UI 的 ACK 状态指示灯
      updateAckBadge(param, 'ack-success', `已确认: ${msg.val}${latStr}`);

      // 同步输入框数值 (如果不是用户正在输入的)
      syncInputValue(param, msg.val);
    } else {
      logTerminal('ack-err', `[ACK 错误] ❌ ${msg.error_msg}`);
      updateAckBadge(param, 'ack-error', `失败: ${msg.error_msg}`);
    }
  }

  function updateAckBadge(paramName, className, text, sticky = false) {
    const badge = document.getElementById(`ack-${paramName}`);
    if (badge) {
      badge.className = `param-ack-badge ${className}`;
      badge.textContent = text;
      if (sticky) return;   // 例如 "松手后发送" 预览: 保持显示直到松手下发

      // 3秒后淡化为已就绪
      setTimeout(() => {
        if (badge.classList.contains(className)) {
          badge.className = 'param-ack-badge';
          badge.textContent = '已同步';
        }
      }, 3500);
    }
  }

  // ================= 参数双向绑定 =================

  // v3.1: 滑动条下发时机可切换 (所有参数滑动条通用, 保存在浏览器本地 localStorage 'sliderSendMode'):
  //   'live'    拖动即发: 拖动过程中节流下发 (每 SLIDER_THROTTLE_MS 最多一次, 首次立即发), 松手时补发最终值;
  //             旧实现是 40ms "尾随防抖": 连续拖动时 input 事件间隔约 16ms < 40ms, 实际要停顿才会发出, 并不实时。
  //   'release' 松手发送: 拖动时只在数字框与 ACK 标签预览数值, 松开鼠标 (change 事件) 时下发一次,
  //             适合大幅调整 Kp / 目标转速等参数, 避免中间值逐个冲击被控对象。
  // "实时同步" 开关关闭时, 两种模式都不自动下发 (只在输入框回车 / 点击发送时下发)。
  const SLIDER_MODE_KEY = 'sliderSendMode';
  const SLIDER_THROTTLE_MS = 50;
  let sliderSendMode = loadSliderSendMode();
  const sliderSendState = {};   // name -> { last, timer, pending, sent }

  function loadSliderSendMode() {
    try { return localStorage.getItem(SLIDER_MODE_KEY) === 'release' ? 'release' : 'live'; } catch (e) { return 'live'; }
  }

  function setSliderSendMode(mode) {
    sliderSendMode = mode === 'release' ? 'release' : 'live';
    try { localStorage.setItem(SLIDER_MODE_KEY, sliderSendMode); } catch (e) { /* 隐私模式 */ }
    const group = document.getElementById('slider-send-mode');
    if (group) {
      group.querySelectorAll('.seg-btn').forEach(b => {
        const on = b.dataset.mode === sliderSendMode;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    }
  }

  function syncSliderModeEnabled() {
    const group = document.getElementById('slider-send-mode');
    if (group) group.classList.toggle('disabled', !autoSyncEnabled);
  }

  function setupSliderModeToggle() {
    const group = document.getElementById('slider-send-mode');
    if (group) group.querySelectorAll('.seg-btn').forEach(b => b.addEventListener('click', () => setSliderSendMode(b.dataset.mode)));
    setSliderSendMode(sliderSendMode);
    syncSliderModeEnabled();
  }

  function sliderState(name) {
    if (!sliderSendState[name]) sliderSendState[name] = { last: -Infinity, timer: null, pending: null, sent: null };
    return sliderSendState[name];
  }

  /** 节流下发: 距上次下发 ≥ SLIDER_THROTTLE_MS 立即发, 否则排队到间隔结束 (只保留最新值) */
  function throttleSend(name, value) {
    const st = sliderState(name);
    st.pending = String(value);
    const wait = SLIDER_THROTTLE_MS - (performance.now() - st.last);
    if (wait <= 0) flushSliderSend(name);
    else if (!st.timer) st.timer = setTimeout(() => flushSliderSend(name), wait);
  }

  /** 立即下发排队中的值; endOfDrag=true 表示一次拖动结束 (同一次拖动内相同值不重复下发) */
  function flushSliderSend(name, finalValue, endOfDrag) {
    const st = sliderState(name);
    if (finalValue !== undefined) st.pending = String(finalValue);
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    if (st.pending !== null && st.pending !== st.sent) {
      sendParamUpdate(name, st.pending);
      st.sent = st.pending;
      st.last = performance.now();
    }
    st.pending = null;
    if (endOfDrag) st.sent = null;
  }

  function cancelSliderSend(name) {
    const st = sliderSendState[name];
    if (!st) return;
    if (st.timer) clearTimeout(st.timer);
    st.timer = null;
    st.pending = null;
    st.sent = null;
  }

  /** 绑定一组 "滑动条 + 数字框" (固定参数与动态注册参数共用) */
  function bindParamSlider(name, slider, input) {
    slider.addEventListener('input', () => {
      input.value = slider.value;
      if (!autoSyncEnabled) return;
      if (sliderSendMode === 'live') throttleSend(name, slider.value);
      else updateAckBadge(name, 'ack-pending', `松手后发送: ${slider.value}`, true);
    });
    // change: 松开鼠标 / 触摸结束 / 键盘方向键每步
    slider.addEventListener('change', () => {
      input.value = slider.value;
      if (!autoSyncEnabled) return;
      if (sliderSendMode === 'release') {
        cancelSliderSend(name);
        sendParamUpdate(name, slider.value);
      } else {
        flushSliderSend(name, slider.value, true);
      }
    });
    // 数字框回车 / 失焦: 总是立即下发
    input.addEventListener('change', () => {
      slider.value = input.value;
      cancelSliderSend(name);
      sendParamUpdate(name, input.value);
    });
  }

  function setupParamBindings() {
    const bindList = [
      { id: 'pid_kp', isFloat: true },
      { id: 'pid_ki', isFloat: true },
      { id: 'pid_kd', isFloat: true },
      { id: 'target_speed', isFloat: true },
      { id: 'max_current', isFloat: false }
    ];

    bindList.forEach(item => {
      const slider = document.getElementById(`slider-${item.id}`);
      const input = document.getElementById(`input-${item.id}`);
      const btnSend = document.querySelector(`.btn-send[data-target="${item.id}"]`);

      if (!slider || !input) return;
      bindParamSlider(item.id, slider, input);

      // 发送按钮点击
      if (btnSend) {
        btnSend.addEventListener('click', () => {
          cancelSliderSend(item.id);
          sendParamUpdate(item.id, input.value);
        });
      }
    });

    // 步进按钮 (+0.1, -0.1 等)
    document.querySelectorAll('.btn-step').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.target;
        const step = parseFloat(btn.dataset.step);
        const input = document.getElementById(`input-${target}`);
        const slider = document.getElementById(`slider-${target}`);
        if (input && slider) {
          let cur = parseFloat(input.value) || 0;
          let next = cur + step;
          // 小数点精度处理
          if (Math.abs(step) < 0.1) {
            next = Math.round(next * 1000) / 1000;
          } else {
            next = Math.round(next * 100) / 100;
          }
          // v3.1: 按滑动条范围钳位 (旧实现滑动条被浏览器钳位, 但数字框与下发值越界, 固件回 OUT_OF_RANGE)
          const lo = parseFloat(slider.min), hi = parseFloat(slider.max);
          if (Number.isFinite(lo)) next = Math.max(lo, next);
          if (Number.isFinite(hi)) next = Math.min(hi, next);
          input.value = next;
          slider.value = next;
          cancelSliderSend(target);
          sendParamUpdate(target, next);
        }
      });
    });
  }

  function syncInputValue(paramName, valStr) {
    const input = document.getElementById(`input-${paramName}`);
    const slider = document.getElementById(`slider-${paramName}`);
    if (input && document.activeElement !== input) {
      input.value = valStr;
    }
    if (slider && document.activeElement !== slider) {
      slider.value = valStr;
    }
  }

  function sendParamUpdate(paramName, value) {
    updateAckBadge(paramName, 'ack-sending', '⏳ 发送中...');
    pendingSends.set(paramName, performance.now());
    sendRttCommand(`$SET:${paramName}=${value}`);
  }

  // ================= PID 预设与专属控制 =================

  function setupPidControls() {
    // 预设参数加载
    document.querySelectorAll('.btn-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        const kp = btn.dataset.kp;
        const ki = btn.dataset.ki;
        const kd = btn.dataset.kd;

        applyAndSend('pid_kp', kp);
        applyAndSend('pid_ki', ki);
        applyAndSend('pid_kd', kd);
      });
    });

    // 一键下发全部 PID
    els.btnSyncAllPid.addEventListener('click', () => {
      const kp = document.getElementById('input-pid_kp').value;
      const ki = document.getElementById('input-pid_ki').value;
      const kd = document.getElementById('input-pid_kd').value;

      updateAckBadge('pid_kp', 'ack-sending', '⏳ 发送中...');
      updateAckBadge('pid_ki', 'ack-sending', '⏳ 发送中...');
      updateAckBadge('pid_kd', 'ack-sending', '⏳ 发送中...');

      sendRttCommand(`$SET:pid_kp=${kp},pid_ki=${ki},pid_kd=${kd}`);
    });
  }

  function applyAndSend(name, val) {
    const input = document.getElementById(`input-${name}`);
    const slider = document.getElementById(`slider-${name}`);
    if (input) input.value = val;
    if (slider) slider.value = val;
    sendParamUpdate(name, val);
  }

  // ================= 运行模式与电机大开关 =================

  function setupModeButtons() {
    const modeButtons = document.querySelectorAll('#mode-selector .btn-mode');
    modeButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        modeButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const modeVal = btn.dataset.mode;
        sendParamUpdate('work_mode', modeVal);
      });
    });
  }

  function setupMotorSwitch() {
    els.switchMotor.addEventListener('change', (e) => {
      const state = e.target.checked ? 1 : 0;
      sendParamUpdate('motor_en', state);
    });
  }

  // ================= 动态自注册参数生成 ($GET:ALL) =================

  function handleParamMeta(meta) {
    dynamicParams.set(meta.name, meta);
    els.dynamicCount.textContent = `已同步 ${dynamicParams.size} 项`;

    // 如果是已知参数，直接更新 UI
    const existingInput = document.getElementById(`input-${meta.name}`);
    if (existingInput) {
      existingInput.value = meta.val;
      const slider = document.getElementById(`slider-${meta.name}`);
      if (slider) {
        slider.min = meta.min;
        slider.max = meta.max;
        slider.value = meta.val;
      }
      updateAckBadge(meta.name, 'ack-success', `同步: ${meta.val}`);
      return;
    }

    // 否则在动态容器中创建新行
    renderDynamicParams();
  }

  // v3.1 安全修复: 旧实现用 innerHTML 拼接固件上报的 name/min/max/val, 且每收到一条 param_meta 就整体重建
  // (N 个参数 → O(N²) 次 DOM 重建, 正在拖动的动态滑动条会被打断)。改为 textContent 构建 + 按参数名增量更新。
  const dynamicRows = new Map();   // name -> { row, slider, input, badge }
  const DYNAMIC_KNOWN_KEYS = ['pid_kp', 'pid_ki', 'pid_kd', 'target_speed', 'max_current', 'work_mode', 'motor_en'];

  function renderDynamicParams() {
    const unknowns = [];
    dynamicParams.forEach((meta, name) => {
      if (!DYNAMIC_KNOWN_KEYS.includes(name)) unknowns.push(meta);
    });

    if (unknowns.length === 0) {
      if (!dynamicRows.size) {
        els.dynamicContainer.textContent = '';
        const hint = document.createElement('div');
        hint.className = 'empty-hint';
        hint.textContent = '所有注册参数均已在上方专属控制面板中显示。';
        els.dynamicContainer.appendChild(hint);
      }
      return;
    }
    if (!dynamicRows.size) els.dynamicContainer.textContent = '';
    unknowns.forEach(meta => {
      const ref = dynamicRows.get(meta.name);
      if (ref) updateDynamicRow(ref, meta);
      else {
        const created = createDynamicRow(meta);
        dynamicRows.set(meta.name, created);
        els.dynamicContainer.appendChild(created.row);
      }
    });
  }

  function createDynamicRow(meta) {
    const mk = (tag, cls, text) => {
      const el = document.createElement(tag);
      if (cls) el.className = cls;
      if (text !== undefined) el.textContent = text;
      return el;
    };
    const name = String(meta.name);
    const row = mk('div', 'param-row');
    const info = mk('div', 'param-info');
    const tag = mk('span', 'param-tag');
    const badge = mk('span', 'param-ack-badge', `已同步: ${meta.val}`);
    badge.id = `ack-${name}`;
    info.append(mk('span', 'param-name', name), tag, badge);
    const control = mk('div', 'param-control');
    const slider = mk('input', 'range-slider');
    slider.type = 'range';
    slider.id = `slider-${name}`;
    slider.step = meta.type_code === 0 ? '0.01' : '1';
    const group = mk('div', 'num-box-group');
    const input = mk('input', 'num-input');
    input.type = 'number';
    input.id = `input-${name}`;
    const btn = mk('button', 'btn btn-xs btn-send', '发送');
    group.append(input, btn);
    control.append(slider, group);
    row.append(info, control);
    const ref = { row, slider, input, badge, tag };
    updateDynamicRow(ref, meta);
    bindParamSlider(name, slider, input);
    btn.addEventListener('click', () => {
      cancelSliderSend(name);
      sendParamUpdate(name, input.value);
    });
    return ref;
  }

  function updateDynamicRow(ref, meta) {
    const num = v => (Number.isFinite(Number(v)) ? String(Number(v)) : '');
    ref.tag.textContent = `Type ${meta.type_code} [${meta.min}..${meta.max}]`;
    if (num(meta.min) !== '') ref.slider.min = num(meta.min);
    if (num(meta.max) !== '') ref.slider.max = num(meta.max);
    // 用户正在拖动 / 输入时不覆盖其操作
    if (document.activeElement !== ref.slider) ref.slider.value = num(meta.val);
    if (document.activeElement !== ref.input) ref.input.value = num(meta.val);
  }

  // ================= 实时波形绘制 =================

  function setupCanvas() {
    function resize() {
      const rect = els.canvas.parentElement.getBoundingClientRect();
      els.canvas.width = rect.width - 24;
      els.canvas.height = 180;
    }
    window.addEventListener('resize', resize);
    resize();
  }

  // ================= 实时遥测数据监控看板 (通用自适应引擎) =================
  // 设计约束:
  //  1. 设备上报的键/值一律以纯文本写入 DOM (textContent)，不经 innerHTML，杜绝注入。
  //  2. 解析与波形采样逐帧进行；看板数字按 TELE_RENDER_INTERVAL_MS 节流渲染，
  //     避免高频帧逐帧写 DOM，同时保证人眼可读。
  //  3. 单位仅在命名无歧义时推断；速度/位置等因项目而异的量，只有带显式后缀才给单位。
  //  4. 键名必须符合 C 标识符规则，用于拦截固件端截断/粘包产生的畸形帧。
  const TELE_RENDER_INTERVAL_MS = 100;   // 看板数字刷新上限 10Hz
  const TELE_STALE_MS = 2000;            // 超过该时长未更新的指标标记为"陈旧"
  const TELE_MAX_METRICS = 32;           // 看板指标数量上限，防止异常帧无限创建磁贴
  const TELE_MAX_VALUE_LEN = 32;         // 单个值的显示长度上限
  const TELE_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

  const teleMetrics = new Map();         // key -> { tile, valEl, deltaEl, timeEl, lastShownNum, lastUpdate }
  const telePending = new Map();         // key -> 最新值字符串 (等待下一次节流渲染)
  const waveSrc = { target: null, actual: null }; // 波形通道锁定的源键名
  let teleRenderTimer = null;
  let teleFrameCount = 0;
  let teleLastFpsTime = performance.now();
  let teleEmptyHintHtml = '';

  function isFiniteNumber(s) {
    // 使用 Number() 而非 parseFloat()：parseFloat('12V') === 12，会把非数值误判为数值
    return typeof s === 'string' && s.trim() !== '' && Number.isFinite(Number(s));
  }

  function setupTelemetryDashboard() {
    if (els.telemetryGrid) {
      // 复用 index.html 中的静态提示，避免 JS 与 HTML 两处文案漂移
      teleEmptyHintHtml = els.telemetryGrid.innerHTML;
    }
    if (els.btnClearTele) {
      els.btnClearTele.addEventListener('click', resetTelemetryDashboard);
    }

    setInterval(() => {
      const now = performance.now();
      if (!isConnected) {
        // 断线期间持续归零计数窗口，避免重连后首个读数被陈旧计数拉偏
        teleFrameCount = 0;
        teleLastFpsTime = now;
        if (els.teleRateBadge) els.teleRateBadge.textContent = '0.0 Hz';
      } else {
        const dt = (now - teleLastFpsTime) / 1000.0;
        if (dt > 0.5) {
          if (els.teleRateBadge) {
            const ch0Hz = teleFrameCount / dt;
            if (ch0Hz > 0) {
              els.teleRateBadge.textContent = `${ch0Hz.toFixed(1)} Hz`;
            } else if (wave.nch > 0 && wave.fps > 0 && now - wave.lastRx < TELE_STALE_MS) {
              // 无 $DATA、仅 Ch1 时显示 Ch1 帧率 (看板本身按 10Hz 刷新); 2s 未收到 Ch1 则回到 0
              els.teleRateBadge.textContent = `Ch1 ${wave.fps.toFixed(0)} Hz`;
            } else {
              els.teleRateBadge.textContent = '0.0 Hz';
            }
          }
          teleFrameCount = 0;
          teleLastFpsTime = now;
        }
      }
      // 陈旧标记: 断线或固件停止上报后，旧数值必须能与实时值区分
      teleMetrics.forEach(item => {
        item.tile.classList.toggle('tile-stale', now - item.lastUpdate > TELE_STALE_MS);
      });
    }, 1000);
  }

  function resetTelemetryDashboard() {
    teleMetrics.clear();
    telePending.clear();
    waveSrc.target = null;
    waveSrc.actual = null;
    if (teleRenderTimer !== null) {
      clearTimeout(teleRenderTimer);
      teleRenderTimer = null;
    }
    if (els.telemetryGrid) els.telemetryGrid.innerHTML = teleEmptyHintHtml;
    teleFrameCount = 0;
    teleLastFpsTime = performance.now();
    if (els.teleRateBadge) els.teleRateBadge.textContent = '0.0 Hz';
  }

  // ---- 单位/类别推断 ----
  // 优先级: 显式多字母单位后缀 > 状态类 (含非数值) > 首段词元。
  // 不使用单字母后缀 (_v/_a/_c/_w)：会与三相标签冲突，如 i_c 是 C 相电流而非温度。
  const TELE_SUFFIX_UNITS = {
    mv: ['mV', 'voltage'], kv: ['kV', 'voltage'],
    ma: ['mA', 'current'], ua: ['μA', 'current'],
    mw: ['mW', 'power'], kw: ['kW', 'power'],
    degc: ['℃', 'temp'],
    rpm: ['RPM', 'speed'], rads: ['rad/s', 'speed'],
    hz: ['Hz', 'freq'], khz: ['kHz', 'freq'],
    pct: ['%', 'duty'],
    deg: ['°', 'angle'], rad: ['rad', 'angle'],
    ms: ['ms', 'default'], us: ['μs', 'default'],
    nm: ['N·m', 'default']
  };
  const TELE_HEAD_RULES = [
    [['v', 'u', 'volt', 'voltage', 'vout', 'vin', 'vbus', 'vbat', 'vset', 'vref'], 'V', 'voltage'],
    [['i', 'curr', 'current', 'iout', 'iin', 'ia', 'ib', 'ic', 'iset', 'ilimit'], 'A', 'current'],
    [['p', 'pwr', 'power', 'pout'], 'W', 'power'],
    [['t', 'temp', 'temperature'], '℃', 'temp'],
    [['freq', 'frequency'], 'Hz', 'freq'],
    [['duty', 'soc'], '%', 'duty'],
    [['rpm'], 'RPM', 'speed'],
    // 速度/位置单位因项目而异 (RPM / rad/s / ° / rad)，无后缀时只着色、不标单位
    [['speed', 'vel', 'velocity', 'omega'], '-', 'speed'],
    [['pos', 'position', 'angle', 'theta'], '-', 'angle']
  ];
  // 中文通道名的单位推断 (FIX-024 改为"以关键词结尾"才命中, 与英文规则一样宁缺勿错):
  // "母线电压"/"A相电流"/"电机温度"/"目标转速" 命中; "电流环Kp"/"电压误差系数" 等不命中, 避免标错单位。
  // 顺序有意义: "角速度" 须先于 "速度" 判断 (endsWith 下两者都会命中 "速度")。
  const TELE_CN_RULES = [
    [['电压'], 'V', 'voltage'],
    [['电流'], 'A', 'current'],
    [['功率'], 'W', 'power'],
    [['温度', '温升'], '℃', 'temp'],
    [['频率'], 'Hz', 'freq'],
    [['占空比', '电量'], '%', 'duty'],
    [['转速'], 'RPM', 'speed'],
    [['角速度', '速度'], '-', 'speed'],
    [['角度', '位置', '相位'], '-', 'angle']
  ];
  const TELE_STATUS_HEADS = new Set(['mode', 'state', 'status', 'err', 'error', 'fault', 'flag']);

  function detectMetricMeta(rawKey, rawVal) {
    const tokens = rawKey.toLowerCase().split('_').filter(Boolean);
    if (tokens.length === 0) return { unit: '-', type: 'default' };
    const head = tokens[0];
    const tail = tokens[tokens.length - 1];

    if (tokens.length > 1 && Object.prototype.hasOwnProperty.call(TELE_SUFFIX_UNITS, tail)) {
      const [unit, type] = TELE_SUFFIX_UNITS[tail];
      return { unit, type };
    }
    if (TELE_STATUS_HEADS.has(head) || !isFiniteNumber(rawVal)) {
      return { unit: 'STATE', type: 'status' };
    }
    for (const [heads, unit, type] of TELE_HEAD_RULES) {
      if (heads.includes(head)) return { unit, type };
    }
    for (const [kws, unit, type] of TELE_CN_RULES) {
      if (kws.some(kw => rawKey.endsWith(kw))) return { unit, type };
    }
    return { unit: '-', type: 'default' };
  }

  // ---- 波形通道选择 ----
  // 每个波形槽位按别名优先级锁定首个出现的源键，之后只认该键 (重置看板时解锁)。
  // 修复: 旧实现对多个别名逐个赋值，同一帧同时含 actual 与 v_out 时 actual 被覆盖；
  // 锁定也避免分帧上报时 (运动帧 + 电源帧交替) 波形在不同量纲间来回跳变。
  function pickWaveValue(frame, slot, aliases) {
    if (waveSrc[slot] === null) {
      const hit = aliases.find(a => frame.has(a) && isFiniteNumber(frame.get(a)));
      if (!hit) return null;
      waveSrc[slot] = hit;
    }
    const k = waveSrc[slot];
    return (frame.has(k) && isFiniteNumber(frame.get(k))) ? Number(frame.get(k)) : null;
  }

  function pushWaveSample(buf, val) {
    if (val === null) return;
    buf.push(val);
    buf.shift();
  }

  function handleTelemetry(payload) {
    // 协议: k1=v1,k2=v2,...  例: v_out=12.05,i_out=2.31,temp=38.2,mode=CV
    if (!payload) return;

    const frame = new Map();
    payload.split(',').forEach(p => {
      const eq = p.indexOf('=');
      if (eq <= 0) return;
      const k = p.slice(0, eq).trim();
      const v = p.slice(eq + 1).trim();
      if (TELE_KEY_RE.test(k) && v !== '') frame.set(k, v.slice(0, TELE_MAX_VALUE_LEN));
    });
    if (frame.size === 0) return;
    teleFrameCount++;
    ingestTelemetryFrame(frame);
  }

  // 看板数据入口 (Ch0 $DATA 与 Ch1 JustFloat 共用)
  // feedChart: 只有 Ch0 $DATA 驱动上方旧波形图的 target/actual 槽位。FIX-024: Ch1 有专用波形卡片,
  // 旧实现把 Ch1 也喂进来, 用户把 Ch1 通道改名为 target / v_out 时, 会以 10Hz 混入旧波形图。
  function ingestTelemetryFrame(frame, feedChart = true) {
    if (feedChart) {
      pushWaveSample(telemetryHistory.target, pickWaveValue(frame, 'target', ['target', 'v_set']));
      pushWaveSample(telemetryHistory.actual, pickWaveValue(frame, 'actual', ['actual', 'v_out']));
    }

    frame.forEach((v, k) => telePending.set(k, v));
    if (teleRenderTimer === null) {
      teleRenderTimer = setTimeout(flushTelemetryRender, TELE_RENDER_INTERVAL_MS);
    }
  }

  // 2026-10-23: Ch1 (JustFloat) 通道值也送入看板。
  // 原因: 看板原本只解析 Ch0 的 $DATA 文本帧, 只发 JustFloat 的固件 (如 DM_H7 当前固件) 在真机上看板始终为空。
  // 键名取 Ch1 波形卡片中的通道名 (可点击改名, 改成 v_out / temp 等即可获得单位推断)。
  // 通道名来自本机用户输入而非设备, 且看板以 textContent 写入, 故不套用 $DATA 的 C 标识符限制, 允许中文名。
  // 按 10Hz 取最新一帧; 不计入看板顶部的 $DATA 帧率 (Ch1 帧率见波形卡片)。
  // 已知限制: Ch1 通道名若与 Ch0 $DATA 键名相同, 两者写入同一磁贴。
  let teleCh1LastPush = 0;
  let teleCh1Keys = new Map();   // 看板键名 -> Ch1 通道序号; 仅在通道数/通道名变化时由 syncCh1Keys 重算

  function waveNameToKey(name, i) {
    const k = String(name || '').trim().slice(0, 32);
    return k || `CH${i}`;
  }

  function buildCh1KeyMap() {
    const m = new Map();
    for (let i = 0; i < wave.nch; i++) {
      const base = waveNameToKey(wave.names[i], i);
      let key = base;
      for (let s = i; m.has(key); s++) key = `${base}_${s}`;   // 同名通道加序号, 避免互相覆盖
      m.set(key, i);
    }
    return m;
  }

  function setTileRenamable(item, key, on) {
    item.nameEl.classList.toggle('tele-name-renamable', on);
    item.nameEl.title = on ? `${key}（点击重命名，支持中文）` : key;
  }

  // 通道名或通道数变化后调用: 删除不再属于 Ch1 的旧磁贴 (修复改名后旧 CH0 磁贴残留), 并更新可重命名标记
  function syncCh1Keys() {
    const next = buildCh1KeyMap();
    teleCh1Keys.forEach((_, k) => { if (!next.has(k)) removeMetricTile(k); });
    teleCh1Keys = next;
    teleMetrics.forEach((item, k) => setTileRenamable(item, k, next.has(k)));
  }

  function pushCh1ToDashboard(lastFrame, force = false) {
    const now = performance.now();
    if (!Array.isArray(lastFrame)) return;
    if (!force && now - teleCh1LastPush < TELE_RENDER_INTERVAL_MS) return;
    teleCh1LastPush = now;
    const frame = new Map();
    teleCh1Keys.forEach((i, key) => {
      const v = lastFrame[i];
      // 非有限值 (网关把 NaN/Inf 发为 null) 不送看板: 保留上一读数并在 2s 后标记陈旧;
      // 旧实现送 'NaN' 字符串, 若首帧恰为 NaN, 磁贴会被永久判定为"状态"类型
      if (typeof v === 'number' && Number.isFinite(v)) frame.set(key, Number(v.toPrecision(6)).toString());
    });
    if (frame.size) ingestTelemetryFrame(frame, false);
  }

  function removeMetricTile(key) {
    telePending.delete(key);
    const item = teleMetrics.get(key);
    if (!item) return;
    item.tile.remove();
    teleMetrics.delete(key);
  }

  function createMetricTile(key, firstVal) {
    const meta = detectMetricMeta(key, firstVal);
    const mk = (tag, cls, text) => {
      const el = document.createElement(tag);
      el.className = cls;
      if (text !== undefined) el.textContent = text;
      return el;
    };

    const tile = mk('div', `tele-metric-tile type-${meta.type}`);
    tile.dataset.key = key;

    const header = mk('div', 'tele-metric-header');
    const nameEl = mk('span', 'tele-metric-name', key);
    // 点击时按当前映射查通道序号 (映射可能在磁贴创建后因改名而变化); Ch0 $DATA 磁贴查不到, 点击无动作
    nameEl.addEventListener('click', () => {
      const i = teleCh1Keys.get(key);
      if (i !== undefined) renameWaveChannel(i);
    });
    header.append(nameEl, mk('span', 'tele-metric-unit', meta.unit));

    const row = mk('div', 'tele-metric-value-row');
    const valEl = mk('span', 'tele-metric-val');
    row.append(valEl);

    const sub = mk('div', 'tele-metric-sub');
    const deltaEl = mk('span', 'tele-metric-delta neutral', '-');
    const timeEl = mk('span', 'tele-metric-time');
    sub.append(deltaEl, timeEl);

    tile.append(header, row, sub);
    els.telemetryGrid.appendChild(tile);
    const item = { tile, nameEl, valEl, deltaEl, timeEl, lastShownNum: null, lastUpdate: 0 };
    setTileRenamable(item, key, teleCh1Keys.has(key));
    return item;
  }

  function flushTelemetryRender() {
    teleRenderTimer = null;
    if (telePending.size === 0 || !els.telemetryGrid) return;

    const hint = els.telemetryGrid.querySelector('#tele-empty-hint');
    if (hint) hint.remove();

    const now = performance.now();
    const timeStr = new Date().toTimeString().slice(0, 8);

    telePending.forEach((v, k) => {
      let item = teleMetrics.get(k);
      if (!item) {
        if (teleMetrics.size >= TELE_MAX_METRICS) return;
        item = createMetricTile(k, v);
        teleMetrics.set(k, item);
      }
      item.valEl.textContent = v;
      item.timeEl.textContent = timeStr;
      item.lastUpdate = now;
      item.tile.classList.remove('tile-stale');

      if (!isFiniteNumber(v)) return;
      const num = Number(v);
      if (item.lastShownNum !== null) {
        const delta = num - item.lastShownNum;
        // 差值按固件上报的小数位数显示，避免浮点误差制造虚假精度 (如 0.0100000002)
        const dp = Math.min((v.split('.')[1] || '').length, 6);
        if (Math.abs(delta) < Math.pow(10, -dp) / 2) {
          item.deltaEl.textContent = 'Δ 0';
          item.deltaEl.className = 'tele-metric-delta neutral';
        } else {
          item.deltaEl.textContent = `Δ ${delta > 0 ? '+' : ''}${delta.toFixed(dp)}`;
          item.deltaEl.className = `tele-metric-delta ${delta > 0 ? 'positive' : 'negative'}`;
        }
      }
      item.lastShownNum = num;
    });
    telePending.clear();
  }

  function startRenderLoop() {
    function draw() {
      const w = els.canvas.width;
      const h = els.canvas.height;
      ctx.clearRect(0, 0, w, h);

      // 绘制背景网格
      ctx.strokeStyle = canvasTheme.grid;
      ctx.lineWidth = 1;
      for (let y = 30; y < h; y += 35) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // 计算纵向缩放自适应
      // 修复: 旧实现固定默认量程 -100..2000、仅当跨度 > 10 才自适应且上下各留 200，
      // 导致 12V 电源电压等小量程信号被压成一条直线。改为按数据跨度比例留白。
      const allVals = [...telemetryHistory.target, ...telemetryHistory.actual];
      let minVal = Math.min(...allVals);
      let maxVal = Math.max(...allVals);
      const pad = Math.max((maxVal - minVal) * 0.1, Math.abs(maxVal) * 0.02, 1e-3);
      minVal -= pad;
      maxVal += pad;

      function valToY(v) {
        const norm = (v - minVal) / (maxVal - minVal);
        return h - (norm * (h - 20) + 10);
      }

      // 绘制 Target 曲线 (蓝色虚线)
      ctx.strokeStyle = canvasTheme.target;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      for (let i = 0; i < MAX_HISTORY; i++) {
        const x = (i / (MAX_HISTORY - 1)) * w;
        const y = valToY(telemetryHistory.target[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // 绘制 Actual 曲线 (绿色实线)
      ctx.strokeStyle = canvasTheme.actual;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      for (let i = 0; i < MAX_HISTORY; i++) {
        const x = (i / (MAX_HISTORY - 1)) * w;
        const y = valToY(telemetryHistory.actual[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      requestAnimationFrame(draw);
    }
    requestAnimationFrame(draw);
  }

  // ================= Ch1 JustFloat 波形 (v3.1 重构) =================
  // 数据来源: 网关读取 OpenOCD 19022 (RTT Channel 1) 并解码 JustFloat; VOFA+ 同时直连 19022 / 网关 1347, 两边同源。
  // v3.1: 网页订阅二进制帧 (本机全速不抽取 / 局域网 min-max 抽取); 旧版 JSON 'wave' 消息仍兼容。
  // 数据层与渲染器在 wave_core.js (不依赖 DOM, 将来可原样放进 Web Worker), 本段负责界面、交互、设置:
  //   - 实时跟随 / 历史浏览 状态机: 暂停只是停止跟随, 浏览时仍可拖拽、缩放、读数; 新数据在后台继续写入
  //   - 三层画布: 网格层 (几乎静止) / 波形层 (有新数据或视图变化才重绘) / 交互层 (十字光标、框选)
  //   - 叠加 / 分图 / 自定义分组, 所有子图共用横轴; 每个子图纵轴独立 (分通道铺满 / 共用自动 / 手动 / 对称)
  const WC = (typeof window !== 'undefined' && window.RTTWaveCore) || null;
  const WAVE_COLORS = ['#58a6ff', '#3fb950', '#d29922', '#f778ba', '#a371f7', '#39c5bb', '#f85149', '#e6edf3'];
  const WAVE_NAMES_KEY = 'ch1WaveNames';
  const WAVE_SETTINGS_KEY = 'ch1WaveSettings';
  // 平滑播放参数 (FIX-024 调整): 曲线右端比最新样本滞后约 WAVE_PLAY_LAG_S。
  // 无线 OpenOCD 轮询间隔实测 100~260ms, 滞后取 0.15s 时, 间隔不超过约 0.2s 就不会出现"停住等数据"。
  // 代价: 曲线比图例数值晚约 0.15s 显示。积压超过 WAVE_PLAY_RESET_S (如暂停后恢复) 直接跳到最新。
  // v3.1: 设置中可关闭"平滑滚动", 右端直接对齐最新样本 (延迟最低, 但成批到达时会一顿一顿)。
  const WAVE_PLAY_LAG_S = 0.15;
  const WAVE_PLAY_RESET_S = 0.6;
  const WAVE_MEM_LIMIT = 200 * 1024 * 1024;    // 历史缓存内存上限
  const WAVE_MAX_MARKERS = 300;
  const WAVE_ANALYSIS_MAX = 262144;            // 送入分析的最大点数 (更长时取区间内最新的这么多点)
  const WAVE_OVERVIEW_H = 36;
  const WAVE_HISTORY_PRESETS = [10, 30, 60, 120, 300];
  const WAVE_WINDOW_PRESETS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 60];
  const WAVE_DEFAULTS = {
    xMode: 'time', windowSec: 2, points: 2000, historySec: 60,
    layout: 'overlay', groups: [], yCfg: {}, fpsCap: 60, transport: 'auto',
    markers: true, clearOnConnect: false, smooth: true, wide: false, height: 0
  };

  const wave = {
    nch: 0, names: [], visible: [], valEls: [], nameEls: [], last: null,
    store: null, axis: null, capInfo: null,
    mode: 'live', view: null, lastView: null, undo: [], lastUndoTs: 0,
    fps: 0, displayRate: 0, rateJumpCount: 0, decim: 1, resync: 0, resyncBase: 0, sub: null,
    playhead: 0, lastDrawTs: 0, lastRx: 0, lastLegendUpdate: 0, lastCapCheck: 0, lastFrameTs: 0,
    cursors: { a: null, b: null }, markers: [], ackVals: {},
    hover: null, hoverStage: false, drag: null, select: null, ovDrag: null, ovInfo: null,
    yState: {}, yView: {}, plots: [], tickStep: 0,
    settings: null, settingsOpen: false,
    stage: null, layers: null, overview: null, cssW: 0, cssH: 0, dpr: 1, stageW: 0,
    dirty: true, overlayDirty: false, layoutSig: '', gridSig: '', ovLast: 0, colBuf: null,
    perf: { hist: [], ms: 0, p95: 0, vertices: 0, gridDraws: 0, frames: 0 },
    ui: {}, lastReadout: 0, lastSettingsRefresh: 0, homeParent: null, homeNext: null
  };

  // ---- 外部依赖 (typeof 保护: 本段在单元测试中会被单独抽取运行) ----
  function waveLog(type, text) { if (typeof logTerminal === 'function') logTerminal(type, text); }
  function waveSendRtt(raw) { if (typeof sendRttCommand === 'function') sendRttCommand(raw); }
  function waveSendJson(obj) { if (typeof sendJson === 'function') sendJson(obj); }
  function waveParamMeta(name) {
    try { return (typeof dynamicParams !== 'undefined' && dynamicParams.get(name)) || null; } catch (e) { return null; }
  }
  const waveNow = () => performance.now();
  const clampNum = (v, lo, hi, dflt) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt; };

  // ---------------------------------------------------------------- 设置持久化
  function loadWaveSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(WAVE_SETTINGS_KEY) || '{}') || {}; } catch (e) { s = {}; }
    const d = WAVE_DEFAULTS;
    const yCfg = {};
    if (s.yCfg && typeof s.yCfg === 'object') {
      Object.keys(s.yCfg).forEach(k => {
        const c = s.yCfg[k] || {};
        yCfg[k] = { mode: ['per', 'auto', 'manual', 'sym'].includes(c.mode) ? c.mode : 'per',
                    min: Number(c.min) || 0, max: Number(c.max) || 0, sym: Math.abs(Number(c.sym) || 0) };
      });
    }
    return {
      xMode: s.xMode === 'points' ? 'points' : 'time',
      windowSec: clampNum(s.windowSec, 0.01, 3600, d.windowSec),
      points: Math.round(clampNum(s.points, 10, 5e6, d.points)),
      historySec: clampNum(s.historySec, 1, 3600, d.historySec),
      layout: ['overlay', 'split', 'custom'].includes(s.layout) ? s.layout : d.layout,
      groups: Array.isArray(s.groups) ? s.groups.map(g => Math.max(1, Math.min(8, Number(g) | 0 || 1))) : [],
      yCfg,
      fpsCap: [15, 30, 60].includes(s.fpsCap) ? s.fpsCap : d.fpsCap,
      transport: ['auto', 'full', 'decim'].includes(s.transport) ? s.transport : d.transport,
      markers: s.markers !== false,
      clearOnConnect: s.clearOnConnect === true,
      smooth: s.smooth !== false,
      wide: s.wide === true,
      height: Math.round(clampNum(s.height, 0, 2000, 0))
    };
  }

  function saveWaveSettings() {
    try { localStorage.setItem(WAVE_SETTINGS_KEY, JSON.stringify(wave.settings)); } catch (e) { /* 隐私模式等 */ }
  }

  function loadWaveNames() {
    try {
      const arr = JSON.parse(localStorage.getItem(WAVE_NAMES_KEY) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function saveWaveNames() {
    try { localStorage.setItem(WAVE_NAMES_KEY, JSON.stringify(wave.names)); } catch (e) { /* 隐私模式等 */ }
  }

  // 通道改名的唯一入口: Ch1 图例名称与看板磁贴标题的点击都走这里
  function renameWaveChannel(i) {
    if (!(i >= 0 && i < wave.nch)) return;
    const v = window.prompt(
      `通道 ${i} 名称（支持中文，如 正弦波 / 母线电压 / 目标转速；留空恢复 CH${i}）`,
      wave.names[i]
    );
    if (v === null) return;
    wave.names[i] = v.trim().slice(0, 24) || `CH${i}`;
    if (wave.nameEls[i]) wave.nameEls[i].textContent = wave.names[i];
    saveWaveNames();
    syncCh1Keys();
    rebuildWaveTip();
    if (wave.settingsOpen) buildWaveSettingsPanel();
    // 立即用最新一帧刷新看板, 不必等下一批数据
    if (Array.isArray(wave.last)) {
      pushCh1ToDashboard(wave.last, true);
      flushTelemetryRender();
    }
  }

  // ---------------------------------------------------------------- 初始化
  function setupWavePanel() {
    wave.settings = loadWaveSettings();
    const $ = id => document.getElementById(id);
    els.waveInfo = $('wave-info');
    els.waveLegend = $('wave-legend');
    wave.stage = $('waveStage');
    const mkLayer = id => { const c = $(id); return c && c.getContext ? { canvas: c, ctx: c.getContext('2d') } : null; };
    const grid = mkLayer('waveGrid'), trace = mkLayer('waveCanvas'), overlay = mkLayer('waveOverlay');
    wave.layers = (grid && trace && overlay) ? { grid, trace, overlay } : null;
    wave.overview = mkLayer('waveOverview');
    wave.settingsEl = $('wave-settings');
    wave.tipEl = $('wave-tip');
    wave.readoutEl = $('wave-readout');
    wave.liveBtn = $('btn-wave-live');
    if (!wave.layers) return;

    measureStage();
    if (typeof ResizeObserver === 'function' && wave.stage) {
      new ResizeObserver(() => { measureStage(); wave.dirty = true; }).observe(wave.stage);
    }
    if (window.addEventListener) window.addEventListener('resize', () => { measureStage(); wave.dirty = true; });

    const winSel = $('wave-window');
    wave.ui.winSel = winSel;
    if (winSel) {
      syncWindowSelect();
      winSel.addEventListener('change', () => {
        const v = Number(winSel.value);
        if (v > 0) {
          wave.settings.xMode = 'time';
          wave.settings.windowSec = v;
          saveWaveSettings();
          syncWindowSelect();
          if (wave.mode !== 'live') goLive();
          markDirty();
          if (wave.settingsOpen) buildWaveSettingsPanel();
        }
      });
    }
    const layoutSel = $('wave-layout');
    wave.ui.layoutSel = layoutSel;
    if (layoutSel) {
      layoutSel.value = wave.settings.layout;
      layoutSel.addEventListener('change', () => setWaveLayout(layoutSel.value));
    }
    const btnPause = $('btn-wave-pause');
    wave.ui.btnPause = btnPause;
    if (btnPause) btnPause.addEventListener('click', toggleWavePause);
    if (wave.liveBtn) wave.liveBtn.addEventListener('click', goLive);
    const btnClear = $('btn-wave-clear');
    if (btnClear) btnClear.addEventListener('click', () => clearWave(false));
    const btnSet = $('btn-wave-settings');
    if (btnSet) btnSet.addEventListener('click', () => toggleWaveSettings());
    const btnWide = $('btn-wave-wide');
    wave.ui.btnWide = btnWide;
    if (btnWide) btnWide.addEventListener('click', () => { wave.settings.wide = !wave.settings.wide; saveWaveSettings(); applyWaveWide(); });
    const btnWaveAnalyze = $('btn-wave-analyze');
    if (btnWaveAnalyze) btnWaveAnalyze.addEventListener('click', () => {
      if (!wave.store || wave.store.count < 4) {
        waveLog('system', '⚠️ Ch1 尚无足够波形数据可供分析');
        return;
      }
      if (window.RTTCapturePanel && typeof window.RTTCapturePanel.importCh1Snapshot === 'function') {
        window.RTTCapturePanel.importCh1Snapshot();
      }
    });
    const btnWaveCsv = $('btn-wave-csv');
    if (btnWaveCsv) btnWaveCsv.addEventListener('click', () => exportWaveCsv(true));

    bindWaveInteractions();
    applyWaveWide();
    updateWaveModeUi();
    applyWaveTheme();
    if (typeof window !== 'undefined' && window.RTTTheme && typeof window.RTTTheme.onChange === 'function') {
      window.RTTTheme.onChange(applyWaveTheme);
    }
    requestAnimationFrame(drawWave);
  }

  /** v3.1: 主题切换 → 通道配色 + 画布配色, 并强制重绘三层画布与概览条 */
  function applyWaveTheme() {
    const T = typeof window !== 'undefined' ? window.RTTTheme : null;
    if (!T || !WC) return;
    const pal = T.palette();
    for (let k = 0; k < WAVE_COLORS.length; k++) WAVE_COLORS[k] = pal[k % pal.length];
    WC.setTheme(T.canvas());
    if (wave.nch) rebuildWaveLegend();
    wave.gridSig = '';
    wave.ovLast = 0;
    markDirty();
    if (wave.settingsOpen) buildWaveSettingsPanel();
  }

  function measureStage() {
    if (!wave.stage) return;
    const r = wave.stage.getBoundingClientRect ? wave.stage.getBoundingClientRect() : null;
    const w = r && r.width ? r.width : (wave.stage.parentElement && wave.stage.parentElement.getBoundingClientRect
      ? wave.stage.parentElement.getBoundingClientRect().width - 24 : 600);
    wave.stageW = Math.max(200, Math.floor(w || 600));
  }

  function syncWindowSelect() {
    const sel = wave.ui.winSel;
    if (!sel) return;
    const s = wave.settings;
    const v = s.xMode === 'time' ? s.windowSec : 0;
    const known = WAVE_WINDOW_PRESETS.some(p => Math.abs(p - v) < 1e-9);
    // 自定义值 (滚轮缩放 / 设置面板输入) 以临时选项显示
    if (sel.querySelector) {
      let opt = sel.querySelector('option[data-custom]');
      if (!known) {
        if (!opt && document.createElement) {
          opt = document.createElement('option');
          opt.setAttribute && opt.setAttribute('data-custom', '1');
          if (sel.appendChild) sel.appendChild(opt);
        }
        if (opt) {
          opt.value = String(v || 0);
          opt.textContent = s.xMode === 'time' ? `${WC ? WC.fmtTime(v, v / 10).replace('s', ' s') : v + ' s'}` : `${s.points} 点`;
        }
      } else if (opt && opt.remove) {
        opt.remove();
      }
    }
    sel.value = String(known ? v : (v || 0));
  }

  function setWaveLayout(v) {
    if (!['overlay', 'split', 'custom'].includes(v)) return;
    wave.settings.layout = v;
    if (v === 'custom' && wave.settings.groups.length < wave.nch) {
      for (let c = wave.settings.groups.length; c < wave.nch; c++) wave.settings.groups[c] = 1;
    }
    saveWaveSettings();
    if (wave.ui.layoutSel) wave.ui.layoutSel.value = v;
    wave.yState = {};
    markDirty();
    if (wave.settingsOpen) buildWaveSettingsPanel();
  }

  function markDirty() { wave.dirty = true; wave.overlayDirty = true; }

  // ---------------------------------------------------------------- 图例
  function rebuildWaveLegend() {
    if (!els.waveLegend) return;
    els.waveLegend.textContent = '';
    wave.valEls = [];
    wave.nameEls = [];
    const saved = loadWaveNames();
    for (let i = 0; i < wave.nch; i++) {
      if (wave.names[i] === undefined) wave.names[i] = (typeof saved[i] === 'string' && saved[i]) ? saved[i] : `CH${i}`;
      if (wave.visible[i] === undefined) wave.visible[i] = true;
      const item = document.createElement('span');
      item.className = 'wave-legend-item' + (wave.visible[i] ? '' : ' wave-hidden');
      const dot = document.createElement('span');
      dot.className = 'wave-dot';
      dot.style.backgroundColor = WAVE_COLORS[i % WAVE_COLORS.length];
      dot.title = '显示/隐藏该通道';
      dot.addEventListener('click', () => setWaveVisible(i, !wave.visible[i]));
      const name = document.createElement('span');
      name.className = 'wave-name';
      name.textContent = wave.names[i];
      name.title = '点击重命名 (支持中文名，自动同步至右上角看板并保存在浏览器本地)';
      name.addEventListener('click', () => renameWaveChannel(i));
      const val = document.createElement('span');
      val.className = 'wave-val';
      val.textContent = '-';
      item.append(dot, name, val);
      els.waveLegend.appendChild(item);
      wave.valEls.push(val);
      wave.nameEls.push(name);
      wave.legendItems = wave.legendItems || [];
      wave.legendItems[i] = item;
    }
    syncCh1Keys();   // 通道数变化: 重算看板键名映射, 删除多余通道的旧磁贴
    rebuildWaveTip();
  }

  function setWaveVisible(i, on) {
    if (!(i >= 0 && i < wave.nch)) return;
    wave.visible[i] = !!on;
    const item = wave.legendItems && wave.legendItems[i];
    if (item && item.classList) item.classList.toggle('wave-hidden', !wave.visible[i]);
    rebuildWaveTip();
    markDirty();
    if (wave.settingsOpen) buildWaveSettingsPanel();
  }

  // ---------------------------------------------------------------- 数据接收
  function resetWaveChannels(nch) {
    wave.nch = nch;
    wave.displayRate = 0;
    wave.rateJumpCount = 0;
    wave.playhead = 0;
    wave.lastDrawTs = 0;
    wave.markers = [];
    wave.cursors = { a: null, b: null };
    wave.yState = {};
    wave.yView = {};
    wave.undo = [];
    wave.mode = 'live';
    wave.view = null;
    wave.lastView = null;
    if (WC) {
      wave.capInfo = WC.planCapacity(wave.settings ? wave.settings.historySec : 60, 0, nch, WAVE_MEM_LIMIT);
      wave.store = new WC.WaveStore(nch, wave.capInfo.cap);
      wave.axis = new WC.TimeAxis(0);
    }
    rebuildWaveLegend();
    updateWaveModeUi();
    markDirty();
    if (wave.settingsOpen) buildWaveSettingsPanel();
  }

  /** 旧版 JSON 'wave' 消息 (未订阅二进制时, 或旧网关) */
  function handleWave(msg) {
    const nch = Number(msg.nch) | 0;
    if (!Array.isArray(msg.frames) || nch <= 0 || nch > 32) return;
    const rows = msg.frames.filter(fr => Array.isArray(fr) && fr.length === nch);
    if (!rows.length) return;
    const flat = new Float32Array(rows.length * nch);
    for (let k = 0; k < rows.length; k++) {
      const fr = rows[k];
      for (let c = 0; c < nch; c++) { const v = fr[c]; flat[k * nch + c] = typeof v === 'number' ? v : NaN; }
    }
    waveIngest(flat, rows.length, nch, Number(msg.fps) || 0, Number(msg.decim) || 1, Number(msg.resync) || 0,
      msg.frames[msg.frames.length - 1]);
  }

  /** v3.1 二进制波形帧 (ArrayBuffer) */
  function handleWaveBinary(buf) {
    if (!WC) return;
    const m = WC.decodeWaveBinary(buf);
    if (!m || !m.nframes) return;
    const last = Array.from(m.data.subarray((m.nframes - 1) * m.nch, m.nframes * m.nch));
    waveIngest(m.data, m.nframes, m.nch, m.fps, m.decim, m.resync, last);
  }

  function waveIngest(data, nframes, nch, fps, decim, resync, lastRow) {
    if (!(nch >= 1 && nch <= 32) || !(nframes >= 1)) return;
    if (!wave.settings) wave.settings = loadWaveSettings();
    if (nch !== wave.nch || (WC && !wave.store)) resetWaveChannels(nch);
    wave.fps = fps > 0 ? fps : wave.fps;
    wave.decim = decim > 0 ? decim : 1;
    if (resync < wave.resyncBase) wave.resyncBase = 0;   // 网关重连后计数归零
    wave.resync = resync >= 0 ? resync : 0;
    wave.lastRx = waveNow();
    updateDisplayRate(wave.fps > 0 ? wave.fps / wave.decim : 0);
    if (wave.store) {
      wave.axis.setRate(wave.store.head, wave.displayRate);
      wave.store.pushInterleaved(data, nframes, nch);
      maybeResizeStore(false);
      if (wave.mode === 'live') wave.dirty = true;   // 浏览模式下新数据只写入缓存, 画面保持不动
    }
    wave.last = Array.isArray(lastRow) ? lastRow : null;
    pushCh1ToDashboard(lastRow);

    const now = waveNow();
    if (now - wave.lastLegendUpdate > 100) {
      wave.lastLegendUpdate = now;
      if (Array.isArray(lastRow)) {
        wave.valEls.forEach((el, i) => {
          const v = lastRow[i];
          el.textContent = (typeof v === 'number') ? Number(v.toPrecision(6)).toString() : 'NaN';
        });
      }
      updateWaveInfo();
    }
  }

  function updateWaveInfo() {
    if (!els.waveInfo) return;
    const dec = wave.decim > 1 ? ` · 抽取 1/${wave.decim}` : '';
    els.waveInfo.textContent = `${wave.fps.toFixed(0)} 帧/s · ${wave.nch} 通道${dec} · 重同步 ${wave.resync - wave.resyncBase}`;
    els.waveInfo.title = `帧率 / 通道数 / 抽取倍数 / 重同步次数` +
      (wave.sub ? `\n传输: ${wave.sub.mode === 'full' ? '二进制全速' : wave.sub.mode === 'decim' ? '二进制 + min/max 抽取' : 'JSON (旧版)'}${wave.sub.lan ? ' (局域网)' : ''}` : '\n传输: JSON');
  }

  /** 按 "历史时长 × 实测速率" 调整环形缓冲容量 (每秒最多检查一次; force 用于修改历史时长后立即生效) */
  function maybeResizeStore(force) {
    const st = wave.store;
    if (!st) return;
    const now = waveNow();
    if (!force && now - wave.lastCapCheck < 1000) return;
    wave.lastCapCheck = now;
    const plan = WC.planCapacity(wave.settings.historySec, wave.displayRate, wave.nch, WAVE_MEM_LIMIT);
    wave.capInfo = plan;
    if (force ? plan.cap !== st.cap : (plan.cap > st.cap * 1.05 || plan.cap < st.cap * 0.6)) {
      st.resize(plan.cap);
      markDirty();
    }
    wave.axis.prune(st.oldest);
    if (wave.markers.length && wave.markers[0].idx < st.oldest) wave.markers = wave.markers.filter(m => m.idx >= st.oldest);
    ['a', 'b'].forEach(k => { if (wave.cursors[k] !== null && wave.cursors[k] < st.oldest) wave.cursors[k] = null; });
  }

  // 横轴采样率平滑 (FIX-024 重写)。
  // 旧实现: 12% 死区, 偏差 <12% 时永不更新 -> 例如 wave_div 10->11 (约 -9%) 后时间窗永久偏差约 10%;
  //         偏差 >12% 时一步跳变, 单条抽取消息 (decim>1) 就能让整条波形横向突变一次。
  // 新实现: 小偏差用 EMA 缓慢跟踪 (n 每次只变化零点几个点, 肉眼不可见);
  //         大偏差 (>30%, 如修改 wave_div) 须连续 3 条消息成立才一次切换, 单条异常消息不触发。
  function updateDisplayRate(rawRate) {
    if (!(rawRate > 0)) return;
    if (wave.displayRate <= 0) {
      wave.displayRate = rawRate;
      return;
    }
    const dev = Math.abs(rawRate - wave.displayRate) / wave.displayRate;
    if (dev > 0.3) {
      if (++wave.rateJumpCount >= 3) {
        wave.displayRate = rawRate;
        wave.rateJumpCount = 0;
      }
    } else {
      wave.rateJumpCount = 0;
      wave.displayRate += 0.1 * (rawRate - wave.displayRate);
    }
  }

  // 平滑播放头 (绝对样本序号): 无线 OpenOCD 约每 30~120ms 成批送达一批样本,
  // 若每帧直接画到最新样本, 60Hz 下表现为"静止若干帧 -> 瞬移"。
  // 播放头按采样率匀速推进, 并按积压量做 ±比例修正, 使滞后稳定在 WAVE_PLAY_LAG_S 附近。
  function advancePlayhead(ts, head, rate, oldest) {
    if (typeof ts !== 'number' || wave.lastDrawTs <= 0 || !(wave.fps > 0)) {
      wave.playhead = head;
    } else {
      const dt = Math.min(0.1, Math.max(0, (ts - wave.lastDrawTs) / 1000));
      const lagS = (head - wave.playhead) / rate;
      if (lagS < 0 || lagS > WAVE_PLAY_RESET_S) {
        wave.playhead = Math.max((oldest || 0) + 2, head - rate * WAVE_PLAY_LAG_S);
      } else if (lagS > 0) {
        const speed = 1 + Math.max(-0.25, Math.min(0.5, (lagS - WAVE_PLAY_LAG_S) * 2.5));
        wave.playhead = Math.min(head, wave.playhead + rate * speed * dt);
      }
    }
    if (typeof ts === 'number') wave.lastDrawTs = ts;
  }

  // ---------------------------------------------------------------- 视图 (实时 / 浏览)
  function waveRate() {
    return (wave.axis && wave.axis.rate) || wave.displayRate || 50;
  }

  function computeLiveView(ts) {
    const st = wave.store;
    const head = st.head;
    const rate = waveRate();
    let right = head;
    if (wave.settings.smooth) {
      advancePlayhead(ts, head, rate, st.oldest);
      right = Math.min(head, Math.max(st.oldest + 1, wave.playhead));
    } else {
      wave.playhead = head;
      if (typeof ts === 'number') wave.lastDrawTs = ts;
    }
    let left = wave.settings.xMode === 'points'
      ? right - wave.settings.points
      : wave.axis.idxAt(wave.axis.timeOf(right) - wave.settings.windowSec);
    if (!(right - left >= 2)) left = right - 2;
    return { i0: left, i1: right };
  }

  function clampBrowseView(v) {
    const st = wave.store;
    if (!v || !st) return v;
    const oldest = st.oldest, head = st.head;
    const avail = Math.max(8, head - oldest);
    let span = Math.max(8, Math.min(v.i1 - v.i0, avail));
    let i0 = v.i0, i1 = v.i0 + span;
    if (i1 > head) { i1 = head; i0 = head - span; }
    if (i0 < oldest) { i0 = oldest; i1 = oldest + span; }
    return { i0, i1 };
  }

  function enterBrowse(view) {
    if (wave.mode !== 'browse') {
      wave.mode = 'browse';
      const v = view || wave.lastView;
      wave.view = v ? { i0: v.i0, i1: v.i1 } : null;
      updateWaveModeUi();
    }
  }

  function goLive() {
    wave.mode = 'live';
    wave.view = null;
    wave.undo = [];
    wave.lastDrawTs = 0;
    updateWaveModeUi();
    markDirty();
  }

  function toggleWavePause() {
    if (wave.mode === 'live') { enterBrowse(wave.lastView); markDirty(); } else goLive();
  }

  function pushWaveUndo(kind) {
    const now = waveNow();
    // 连续的同类细粒度操作 (滚轮 / 方向键) 400ms 内合并为一步; 不同手势 (拖拽/框选/概览条) 各自独立
    if ((kind === 'wheel' || kind === 'key') && kind === wave.lastUndoKind && now - wave.lastUndoTs < 400) {
      wave.lastUndoTs = now;
      return;
    }
    wave.lastUndoTs = now;
    wave.lastUndoKind = kind || '';
    const v = wave.mode === 'browse' && wave.view ? wave.view : wave.lastView;
    if (!v) return;
    wave.undo.push({ i0: v.i0, i1: v.i1, live: wave.mode === 'live' });
    if (wave.undo.length > 50) wave.undo.shift();
  }

  function undoWaveView() {
    const u = wave.undo.pop();
    if (!u) return false;
    if (u.live) { goLive(); return true; }
    wave.mode = 'browse';
    wave.view = { i0: u.i0, i1: u.i1 };
    updateWaveModeUi();
    markDirty();
    return true;
  }

  function updateWaveModeUi() {
    const live = wave.mode === 'live';
    const b = wave.ui.btnPause;
    if (b) {
      b.textContent = live ? '⏸ 暂停' : '▶ 实时';
      b.title = live ? '停止跟随 (后台继续接收), 进入历史浏览; 快捷键 空格' : '回到实时跟随; 快捷键 End / 空格';
      if (b.classList) b.classList.toggle('btn-highlight', !live);
    }
    if (wave.liveBtn && wave.liveBtn.classList) wave.liveBtn.classList.toggle('hidden', live);
    if (wave.stage && wave.stage.classList) wave.stage.classList.toggle('wave-browsing', !live);
  }

  // ---------------------------------------------------------------- 布局与纵轴
  function channelGroup(c) {
    const s = wave.settings;
    if (s.layout === 'overlay') return 1;
    if (s.layout === 'split') return c + 1;
    return s.groups[c] || 1;
  }

  function buildWaveGroups() {
    const map = new Map();
    for (let c = 0; c < wave.nch; c++) {
      if (!wave.visible[c]) continue;
      const g = channelGroup(c);
      if (!map.has(g)) map.set(g, []);
      map.get(g).push(c);
    }
    return [...map.keys()].sort((a, b) => a - b).map(id => ({ id, chans: map.get(id) }));
  }

  function yCfgOf(gid) {
    const c = wave.settings.yCfg[gid] || {};
    return {
      mode: ['per', 'auto', 'manual', 'sym'].includes(c.mode) ? c.mode : 'per',
      min: Number(c.min) || 0, max: Number(c.max) || 0, sym: Math.abs(Number(c.sym) || 0)
    };
  }

  function yViewOf(gid) {
    if (!wave.yView[gid]) wave.yView[gid] = { zoom: 1, pan: 0 };
    return wave.yView[gid];
  }

  function stableRange(key, lo, hi) {
    const r = WC.stabilizeRange(wave.yState[key], lo, hi);
    if (r) wave.yState[key] = r;
    return r;
  }

  function computeWaveRanges(plots, view) {
    const st = wave.store;
    const mm = [NaN, NaN];
    for (const p of plots) {
      const cfg = yCfgOf(p.id);
      const yv = yViewOf(p.id);
      p.ranges = {};
      p.axis = null;
      if (cfg.mode === 'manual' && cfg.max > cfg.min) {
        const r = WC.applyYView([cfg.min, cfg.max, WC.niceStep(cfg.max - cfg.min, 4)], yv.zoom, yv.pan);
        p.axis = r;
        p.chans.forEach(c => { p.ranges[c] = r; });
        continue;
      }
      let lo = Infinity, hi = -Infinity;
      const per = {};
      for (const c of p.chans) {
        st.rangeMinMax(c, view.i0, view.i1, mm);
        per[c] = [mm[0], mm[1]];
        if (mm[0] < lo) lo = mm[0];
        if (mm[1] > hi) hi = mm[1];
      }
      if (cfg.mode === 'sym') {
        let base;
        if (cfg.sym > 0) base = [-cfg.sym, cfg.sym, WC.niceStep(2 * cfg.sym, 4)];
        else {
          const m = Math.max(Math.abs(lo), Math.abs(hi));
          const r = stableRange(`${p.id}:sym`, -m, m);
          if (r) { const a = Math.max(Math.abs(r[0]), Math.abs(r[1])); base = [-a, a, r[2]]; }
        }
        if (!base) continue;
        const r = WC.applyYView(base, yv.zoom, yv.pan);
        p.axis = r;
        p.chans.forEach(c => { p.ranges[c] = r; });
      } else if (cfg.mode === 'auto' || p.chans.length === 1) {
        const base = stableRange(`${p.id}:*`, lo, hi);
        if (!base) continue;
        const r = WC.applyYView(base, yv.zoom, yv.pan);
        p.axis = r;
        p.chans.forEach(c => { p.ranges[c] = r; });
      } else {
        // 分通道铺满: 量纲差别大时 (如 ±1 的正弦与 1500 的转速) 小幅值通道不会被压成直线
        for (const c of p.chans) {
          const base = stableRange(`${p.id}:${c}`, per[c][0], per[c][1]);
          if (base) p.ranges[c] = WC.applyYView(base, yv.zoom, yv.pan);
        }
      }
    }
  }

  function desiredStageHeight(nGroups) {
    if (wave.settings.height > 0) return wave.settings.height;
    if (nGroups <= 1) return 240;
    return Math.min(760, Math.max(240, nGroups * 118 + 24));
  }

  function ensureCanvasSize(nGroups) {
    const L = wave.layers;
    const cssW = wave.stageW || 600;
    const cssH = desiredStageHeight(nGroups);
    const dpr = Math.max(1, Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
    if (cssW === wave.cssW && cssH === wave.cssH && dpr === wave.dpr) return false;
    wave.cssW = cssW; wave.cssH = cssH; wave.dpr = dpr;
    if (wave.stage && wave.stage.style) wave.stage.style.height = `${cssH}px`;
    const fit = (layer, h, fluid) => {
      if (!layer) return;
      layer.canvas.width = Math.round(cssW * dpr);
      layer.canvas.height = Math.round(h * dpr);
      // 概览条在文档流中: 宽度保持 CSS 100%, 不能写死像素, 否则会把栅格列撑大 (点 "全宽" 再 "还原" 后
      // 左栏被挤窄、页面出现横向滚动条), 窗口缩小时也无法回缩。三层画布为绝对定位, 不参与布局, 可用像素宽度。
      if (layer.canvas.style) { layer.canvas.style.width = fluid ? '100%' : `${cssW}px`; layer.canvas.style.height = `${h}px`; }
      if (layer.ctx.setTransform) layer.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    fit(L.grid, cssH); fit(L.trace, cssH); fit(L.overlay, cssH);
    fit(wave.overview, WAVE_OVERVIEW_H, true);
    wave.gridSig = '';
    wave.ovLast = 0;
    wave.dirty = true;
    return true;
  }

  // ---------------------------------------------------------------- 渲染循环
  function drawWave(ts) {
    requestAnimationFrame(drawWave);
    if (!wave.layers) return;
    if (typeof ts === 'number' && wave.lastFrameTs && ts - wave.lastFrameTs < 1000 / wave.settings.fpsCap - 2) return;
    if (typeof ts === 'number') wave.lastFrameTs = ts;
    renderWaveFrame(ts);
  }

  function renderWaveFrame(ts) {
    if (!wave.layers || !WC) return;
    const t0 = waveNow();
    const st = wave.store;
    const groups = st ? buildWaveGroups() : [];
    ensureCanvasSize(groups.length);
    const w = wave.cssW, h = wave.cssH;
    if (!st || st.count < 1) {
      if (wave.dirty) {
        WC.drawGrid(wave.layers.grid.ctx, { w, h, plots: WC.computeLayout(w, h, [{ id: 0, chans: [] }]), xTicks: [] });
        wave.layers.trace.ctx.clearRect(0, 0, w, h);
        wave.layers.overlay.ctx.clearRect(0, 0, w, h);
        if (wave.overview) wave.overview.ctx.clearRect(0, 0, w, WAVE_OVERVIEW_H);
        wave.gridSig = '';
        wave.dirty = false;
      }
      updateWaveReadout(t0, true);
      return;
    }
    const plots = WC.computeLayout(w, h, groups);
    let view;
    if (wave.mode === 'live') view = computeLiveView(ts);
    else {
      wave.view = clampBrowseView(wave.view || wave.lastView || computeLiveView(ts));
      view = wave.view;
    }
    const lv = wave.lastView;
    const vchg = !lv || Math.abs(view.i0 - lv.i0) > 1e-6 || Math.abs(view.i1 - lv.i1) > 1e-6;
    const layoutSig = `${w}x${h}|` + plots.map(p => `${p.id}:${p.chans.join('.')}`).join('|');
    const lchg = layoutSig !== wave.layoutSig;

    if (vchg || lchg || wave.dirty) {
      wave.lastView = { i0: view.i0, i1: view.i1 };
      wave.layoutSig = layoutSig;
      wave.dirty = false;
      wave.plots = plots;
      computeWaveRanges(plots, view);
      const x0 = plots.length ? plots[0].x0 : 0, x1 = plots.length ? plots[0].x1 : w;
      const tt = WC.timeTicks(wave.axis, view.i0, view.i1, x0, x1, wave.mode === 'live');
      wave.tickStep = tt.step;
      // 网格层: 只有布局、纵轴刻度或时间刻度变化时才重绘 (实时模式下窗口不变则刻度位置固定)
      const gsig = layoutSig + '|' + plots.map(p => (p.axis ? `${p.axis[0].toPrecision(6)},${p.axis[1].toPrecision(6)}` : 'per')).join('|')
        + '|' + tt.ticks.map(t => `${Math.round(t.x)}${t.text}`).join(',');
      if (gsig !== wave.gridSig) {
        WC.drawGrid(wave.layers.grid.ctx, { w, h, plots, xTicks: tt.ticks });
        wave.gridSig = gsig;
        wave.perf.gridDraws++;
      }
      const frame = {
        w, h, plots, store: st, view, colors: WAVE_COLORS, colBuf: wave.colBuf, lineWidth: 1.5,
        markers: wave.settings.markers ? wave.markers : null, cursors: wave.cursors
      };
      wave.perf.vertices = WC.drawTraces(wave.layers.trace.ctx, frame);
      wave.colBuf = frame.colBuf;
      wave.overlayDirty = true;
      wave.perf.frames++;
      if (wave.mode === 'browse') wave.ovLast = 0;   // 浏览时视窗框随交互立即更新
    }
    if (wave.overlayDirty) {
      wave.overlayDirty = false;
      drawWaveOverlay();
    }
    if (wave.overview && waveNow() - wave.ovLast > 250) {
      wave.ovLast = waveNow();
      const p0 = wave.plots[0];
      wave.ovInfo = WC.drawOverview(wave.overview.ctx, {
        w, h: WAVE_OVERVIEW_H, store: st, chans: wave.visible.map((v, c) => (v ? c : -1)).filter(c => c >= 0),
        colors: WAVE_COLORS, view: wave.lastView, x0: p0 ? p0.x0 : 0, x1: p0 ? p0.x1 : w, colBuf: wave.ovColBuf
      });
    }
    const ms = waveNow() - t0;
    const ph = wave.perf.hist;
    ph.push(ms);
    if (ph.length > 120) ph.shift();
    updateWaveReadout(t0, false);
  }

  function waveIdxAtX(x) {
    const p = wave.plots[0], v = wave.lastView;
    if (!p || !v) return NaN;
    return v.i0 + (x - p.x0) / (p.x1 - p.x0) * (v.i1 - v.i0);
  }

  function waveXAtIdx(i) {
    const p = wave.plots[0], v = wave.lastView;
    if (!p || !v) return NaN;
    return p.x0 + (i - v.i0) / (v.i1 - v.i0) * (p.x1 - p.x0);
  }

  /** 十字光标处每个可见通道的取值 (绝对序号就近取样) */
  function waveHoverSample() {
    const hv = wave.hover, st = wave.store;
    if (!hv || !st || !wave.plots.length) return null;
    const p0 = wave.plots[0];
    if (hv.x < p0.x0 || hv.x > p0.x1) return null;
    const idx = Math.round(waveIdxAtX(hv.x));
    if (!(idx >= st.oldest && idx < st.head)) return null;
    const points = [];
    const values = [];
    for (const p of wave.plots) {
      for (const c of p.chans) {
        const v = st.get(c, idx);
        values[c] = v;
        const r = p.ranges && p.ranges[c];
        const y = r && r[1] > r[0] ? p.y1 - (v - r[0]) / (r[1] - r[0]) * (p.y1 - p.y0) : NaN;
        points.push({ y: y >= p.y0 - 2 && y <= p.y1 + 2 ? y : NaN, color: WAVE_COLORS[c % WAVE_COLORS.length] });
      }
    }
    return { idx, sx: waveXAtIdx(idx), values, points, t: wave.axis.timeOf(idx) };
  }

  function drawWaveOverlay() {
    const L = wave.layers;
    const frame = { w: wave.cssW, h: wave.cssH, plots: wave.plots };
    const hs = wave.drag && wave.drag.moved && wave.drag.kind === 'pan' ? null : waveHoverSample();
    WC.drawOverlay(L.overlay.ctx, frame, hs ? { x: wave.hover.x, y: wave.hover.y, sx: hs.sx, points: hs.points } : null, wave.select);
    updateWaveTip(hs);
  }

  // ---------------------------------------------------------------- 十字光标读数框
  function rebuildWaveTip() {
    const tip = wave.tipEl;
    if (!tip || !document.createElement) return;
    tip.textContent = '';
    const head = document.createElement('div');
    head.className = 'wave-tip-time';
    tip.appendChild(head);
    wave.tipTime = head;
    wave.tipRows = [];
    for (let c = 0; c < wave.nch; c++) {
      const row = document.createElement('div');
      row.className = 'wave-tip-row' + (wave.visible[c] ? '' : ' hidden');
      const dot = document.createElement('span');
      dot.className = 'wave-dot';
      dot.style.backgroundColor = WAVE_COLORS[c % WAVE_COLORS.length];
      const name = document.createElement('span');
      name.className = 'wave-tip-name';
      name.textContent = wave.names[c] || `CH${c}`;
      const val = document.createElement('span');
      val.className = 'wave-tip-val';
      row.append(dot, name, val);
      tip.appendChild(row);
      wave.tipRows[c] = val;
    }
  }

  function updateWaveTip(hs) {
    const tip = wave.tipEl;
    if (!tip || !tip.style) return;
    if (!hs || !wave.hover) { tip.style.display = 'none'; return; }
    tip.style.display = 'block';
    if (wave.tipTime) wave.tipTime.textContent = `t = ${WC.fmtTime(hs.t, Math.max(1e-6, wave.tickStep / 100))}  #${hs.idx}`;
    for (let c = 0; c < wave.nch; c++) {
      const el = wave.tipRows && wave.tipRows[c];
      if (!el) continue;
      const v = hs.values[c];
      el.textContent = v === undefined ? '' : (Number.isFinite(v) ? Number(v.toPrecision(6)).toString() : 'NaN');
    }
    const tw = tip.offsetWidth || 140;
    const left = wave.hover.x + 14 + tw > wave.cssW ? wave.hover.x - 14 - tw : wave.hover.x + 14;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${Math.max(0, Math.min(wave.cssH - 40, wave.hover.y - 10))}px`;
  }

  // ---------------------------------------------------------------- 光标 / 标注 / 读数条
  function setWaveCursor(k, idx) {
    const st = wave.store;
    if (!st || !Number.isFinite(idx) || st.count < 1) return;
    wave.cursors[k] = Math.max(st.oldest, Math.min(st.head - 1, Math.round(idx)));
    wave.lastReadout = 0;
    markDirty();
  }

  function clearWaveCursors() {
    wave.cursors = { a: null, b: null };
    wave.lastReadout = 0;
    markDirty();
  }

  /** ACK 回调: 参数值变化时在时间轴上打标注 (首次出现只记录基准, 不打标注) */
  function waveOnAck(msg) {
    if (!msg || !msg.success || msg.param === undefined) return;
    const p = String(msg.param), v = String(msg.val);
    const prev = wave.ackVals[p];
    wave.ackVals[p] = v;
    if (prev === undefined || prev === v || !wave.store || wave.store.count < 1) return;
    wave.markers.push({ idx: wave.store.head - 1, text: `${p}: ${prev}→${v}` });
    if (wave.markers.length > WAVE_MAX_MARKERS) wave.markers.shift();
    markDirty();
  }

  function waveOnConnected() {
    if (wave.settings && wave.settings.clearOnConnect && wave.store && wave.store.count) clearWave(true);
  }

  function updateWaveReadout(t0, empty) {
    const el = wave.readoutEl;
    if (!el) return;
    const now = waveNow();
    if (now - wave.lastReadout < 150) return;
    wave.lastReadout = now;
    const ph = wave.perf.hist;
    if (ph.length) {
      const sorted = ph.slice().sort((a, b) => a - b);
      wave.perf.ms = ph[ph.length - 1];
      wave.perf.p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    }
    if (!wave.ui.roMode && document.createElement) {
      el.textContent = '';
      wave.ui.roMode = document.createElement('span'); wave.ui.roMode.className = 'wave-ro-mode';
      wave.ui.roCur = document.createElement('span'); wave.ui.roCur.className = 'wave-ro-cursor';
      wave.ui.roPerf = document.createElement('span'); wave.ui.roPerf.className = 'wave-ro-perf';
      el.append(wave.ui.roMode, wave.ui.roCur, wave.ui.roPerf);
    }
    const ui = wave.ui;
    if (!ui.roMode) return;
    const st = wave.store, v = wave.lastView;
    if (empty || !st || !v) {
      ui.roMode.textContent = '等待 Ch1 数据…  左键拖拽平移 · 滚轮缩放 · 单击/右键放置光标 A/B · Shift+滚轮缩放纵轴 · Ctrl+拖拽框选放大';
      ui.roCur.textContent = '';
      ui.roPerf.textContent = '';
      return;
    }
    const tStep = Math.max(1e-6, wave.tickStep / 10);
    const n = Math.round(v.i1 - v.i0);
    if (wave.mode === 'live') {
      const win = wave.settings.xMode === 'points' ? `${wave.settings.points} 点` : `${WC.fmtTime(wave.settings.windowSec, wave.settings.windowSec / 10)}`;
      ui.roMode.textContent = `● 实时 · 窗口 ${win} (${n} 点) · 历史 ${WC.fmtTime(wave.axis.timeOf(st.head) - wave.axis.timeOf(st.oldest), 0.1)}`;
    } else {
      const lag = wave.axis.timeOf(st.head) - wave.axis.timeOf(v.i1);
      ui.roMode.textContent = `⏸ 浏览 · ${WC.fmtTime(wave.axis.timeOf(v.i0), tStep)} – ${WC.fmtTime(wave.axis.timeOf(v.i1), tStep)} (${n} 点) · 距最新 ${WC.fmtTime(lag, 0.1)}`;
    }
    const { a, b } = wave.cursors;
    let cur = '';
    if (a !== null) cur += `A ${WC.fmtTime(wave.axis.timeOf(a), tStep)}`;
    if (b !== null) cur += `${cur ? ' · ' : ''}B ${WC.fmtTime(wave.axis.timeOf(b), tStep)}`;
    if (a !== null && b !== null) {
      const dt = Math.abs(wave.axis.timeOf(b) - wave.axis.timeOf(a));
      cur += ` · Δt ${dt < 1 ? (dt * 1000).toPrecision(4) + ' ms' : dt.toPrecision(5) + ' s'}`;
      if (dt > 0) cur += ` · 1/Δt ${(1 / dt).toPrecision(5)} Hz`;
      const ds = [];
      for (let c = 0; c < wave.nch; c++) {
        if (!wave.visible[c]) continue;
        const d = st.valueAt(c, b) - st.valueAt(c, a);
        ds.push(`Δ${wave.names[c] || 'CH' + c} ${Number.isFinite(d) ? Number(d.toPrecision(5)) : 'NaN'}`);
      }
      if (ds.length) cur += ' · ' + ds.join(' · ');
    }
    ui.roCur.textContent = cur;
    ui.roPerf.textContent = `渲染 ${wave.perf.ms.toFixed(1)} ms · p95 ${wave.perf.p95.toFixed(1)} ms`;
    if (wave.settingsOpen && now - wave.lastSettingsRefresh > 500) {
      wave.lastSettingsRefresh = now;
      refreshWaveSettingsLive();
    }
  }

  // ---------------------------------------------------------------- 清空
  function clearWave(silent) {
    const st = wave.store;
    if (st) {
      st.clear();
      wave.axis.reset(st.head);
      wave.axis.setRate(st.head, wave.displayRate);
      wave.playhead = st.head;
    }
    wave.markers = [];
    wave.cursors = { a: null, b: null };
    wave.yState = {};
    wave.lastDrawTs = 0;
    wave.resyncBase = wave.resync;
    wave.lastView = null;
    wave.gridSig = '';
    wave.ovLast = 0;
    goLive();
    updateWaveInfo();
    if (!silent) waveLog('system', '🗑 Ch1 波形缓存、光标与标注已清空');
  }

  function clearAllData() {
    clearWave(true);
    if (els.termOutput) els.termOutput.innerHTML = '';
    if (typeof resetTelemetryDashboard === 'function') resetTelemetryDashboard();
    if (window.RTTCapturePanel && typeof window.RTTCapturePanel.clearHistory === 'function') window.RTTCapturePanel.clearHistory();
    waveLog('system', '🗑 已清空: Ch1 波形 / 终端 / 遥测看板 / Ch2 采集记录');
  }

  // ---------------------------------------------------------------- 导出与送入分析
  /** kind='export': A-B 区间, 否则全部历史; kind='analysis': A-B 区间, 否则当前视图 */
  function waveRange(kind) {
    const st = wave.store;
    if (!st || st.count < 2) return null;
    const { a, b } = wave.cursors;
    if (a !== null && b !== null && Math.abs(b - a) >= 2) {
      return { i0: Math.max(st.oldest, Math.min(a, b)), i1: Math.min(st.head, Math.max(a, b) + 1), src: 'A–B 光标区间' };
    }
    if (kind === 'analysis' && wave.lastView) {
      return { i0: Math.max(st.oldest, Math.floor(wave.lastView.i0)), i1: Math.min(st.head, Math.ceil(wave.lastView.i1)), src: '当前视图' };
    }
    return { i0: st.oldest, i1: st.head, src: '全部历史' };
  }

  function exportWaveCsv(download) {
    const r = waveRange('export');
    if (!r || r.i1 - r.i0 < 1) {
      waveLog('system', '⚠️ Ch1 尚无波形数据可导出');
      return null;
    }
    const st = wave.store, nch = wave.nch;
    const cols = [];
    for (let c = 0; c < nch; c++) cols.push(st.slice(c, r.i0, r.i1));
    const n = cols[0].length;
    const names = wave.names.slice(0, nch).map(s => '"' + String(s).replace(/"/g, '""') + '"');
    const parts = [`index,t_s,${names.join(',')}\n`];
    const tBase = wave.axis.timeOf(r.i0);
    let chunk = [];
    for (let k = 0; k < n; k++) {
      let line = `${k},${(wave.axis.timeOf(r.i0 + k) - tBase).toPrecision(9)}`;
      for (let c = 0; c < nch; c++) { const v = cols[c][k]; line += ',' + (Number.isFinite(v) ? Number(v.toPrecision(7)) : ''); }
      chunk.push(line);
      if (chunk.length >= 20000) { parts.push(chunk.join('\n') + '\n'); chunk = []; }
    }
    if (chunk.length) parts.push(chunk.join('\n') + '\n');
    if (download && typeof Blob !== 'undefined' && document.createElement) {
      const blob = new Blob(parts, { type: 'text/csv;charset=utf-8' });
      const el = document.createElement('a');
      el.href = URL.createObjectURL(blob);
      el.download = `ch1_wave_${Date.now()}.csv`;
      el.click();
      setTimeout(() => URL.revokeObjectURL(el.href), 2000);
      waveLog('system', `📄 已导出 Ch1 波形 CSV: ${r.src}, ${n} 点 × ${nch} 通道`);
    }
    return { rows: n, src: r.src, csv: parts.join('') };
  }

  function getCh1Snapshot(kind) {
    const r = waveRange(kind || 'analysis');
    const st = wave.store;
    if (!r || !st) return { sample_hz: Math.max(1, Math.round(wave.displayRate || wave.fps || 100)), nch: wave.nch, names: wave.names.slice(0, wave.nch), channels: [] };
    let i0 = r.i0;
    if (r.i1 - i0 > WAVE_ANALYSIS_MAX) {
      i0 = r.i1 - WAVE_ANALYSIS_MAX;
      waveLog('system', `⚠️ ${r.src} 共 ${r.i1 - r.i0} 点, 超过分析上限, 仅取最新 ${WAVE_ANALYSIS_MAX} 点`);
    }
    const channels = [];
    for (let c = 0; c < wave.nch; c++) channels.push(Array.from(st.slice(c, i0, r.i1)));
    return {
      sample_hz: Math.max(1, Math.round(wave.axis.rateAt(r.i1 - 1) || wave.displayRate || wave.fps || 100)),
      nch: wave.nch, names: wave.names.slice(0, wave.nch), channels, range: r.src, i0, i1: r.i1
    };
  }

  // ---------------------------------------------------------------- 交互
  function bindWaveInteractions() {
    const ov = wave.layers.overlay.canvas;
    const posOf = e => {
      const r = ov.getBoundingClientRect ? ov.getBoundingClientRect() : { left: 0, top: 0 };
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    ov.addEventListener('pointerdown', e => {
      if (!wave.store || !wave.plots.length || e.button !== 0) return;
      const pos = posOf(e);
      if (ov.setPointerCapture && e.pointerId !== undefined) { try { ov.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      const pi = WC.plotAt(wave.plots, pos.y);
      const gid = pi >= 0 ? wave.plots[pi].id : 0;
      wave.drag = {
        x0: pos.x, y0: pos.y, moved: false, plot: pi,
        kind: (e.ctrlKey || e.metaKey) ? 'box' : (e.shiftKey ? 'ypan' : 'pan'),
        view0: wave.lastView ? { i0: wave.lastView.i0, i1: wave.lastView.i1 } : null,
        yv0: Object.assign({}, yViewOf(gid))
      };
    });
    ov.addEventListener('pointermove', e => {
      const pos = posOf(e);
      wave.hover = pos;
      wave.overlayDirty = true;
      const d = wave.drag;
      if (!d || !d.view0) return;
      if (!d.moved && Math.hypot(pos.x - d.x0, pos.y - d.y0) > 3) {
        d.moved = true;
        if (d.kind === 'pan') { pushWaveUndo('pan'); enterBrowse(d.view0); }
      }
      if (!d.moved) return;
      const p0 = wave.plots[0];
      if (d.kind === 'pan' && p0) {
        const shift = -(pos.x - d.x0) * (d.view0.i1 - d.view0.i0) / (p0.x1 - p0.x0);
        wave.view = { i0: d.view0.i0 + shift, i1: d.view0.i1 + shift };
        wave.dirty = true;
      } else if (d.kind === 'box') {
        wave.select = { x0: d.x0, x1: pos.x };
      } else if (d.kind === 'ypan' && d.plot >= 0) {
        const p = wave.plots[d.plot];
        const yv = yViewOf(p.id);
        yv.pan = d.yv0.pan + (pos.y - d.y0) / (p.y1 - p.y0) / (yv.zoom || 1);
        wave.dirty = true;
      }
    });
    const endDrag = e => {
      const d = wave.drag;
      wave.drag = null;
      if (!d) return;
      if (!d.moved) {
        setWaveCursor('a', waveIdxAtX(d.x0));
      } else if (d.kind === 'box' && wave.select) {
        const xa = Math.min(wave.select.x0, wave.select.x1), xb = Math.max(wave.select.x0, wave.select.x1);
        wave.select = null;
        if (xb - xa > 4) {
          pushWaveUndo('box');
          const ia = waveIdxAtX(xa), ib = waveIdxAtX(xb);
          enterBrowse(wave.lastView);
          wave.view = { i0: ia, i1: ib };
        }
      }
      markDirty();
    };
    ov.addEventListener('pointerup', endDrag);
    ov.addEventListener('pointercancel', () => { wave.drag = null; wave.select = null; markDirty(); });
    ov.addEventListener('pointerleave', () => { if (!wave.drag) { wave.hover = null; wave.overlayDirty = true; } });
    ov.addEventListener('contextmenu', e => {
      if (e.preventDefault) e.preventDefault();
      if (!wave.store || !wave.plots.length) return;
      setWaveCursor('b', waveIdxAtX(posOf(e).x));
    });
    ov.addEventListener('wheel', e => {
      if (!wave.store || !wave.plots.length) return;
      if (e.preventDefault) e.preventDefault();
      const pos = posOf(e);
      const dy = e.deltaY || e.deltaX || 0;
      if (!dy) return;
      const factor = dy > 0 ? 1.25 : 0.8;
      if (e.shiftKey) {
        const pi = WC.plotAt(wave.plots, pos.y);
        if (pi < 0) return;
        const yv = yViewOf(wave.plots[pi].id);
        yv.zoom = Math.max(0.05, Math.min(1e5, yv.zoom / factor));
        wave.dirty = true;
        return;
      }
      if (wave.mode === 'live') {
        const s = wave.settings;
        if (s.xMode === 'points') s.points = Math.round(Math.max(10, Math.min(wave.store.cap, s.points * factor)));
        else s.windowSec = Math.max(0.01, Math.min(s.historySec, Number((s.windowSec * factor).toPrecision(3))));
        saveWaveSettings();
        syncWindowSelect();
        wave.dirty = true;
        return;
      }
      pushWaveUndo('wheel');
      const c = waveIdxAtX(pos.x), v = wave.view || wave.lastView;
      wave.view = { i0: c - (c - v.i0) * factor, i1: c + (v.i1 - c) * factor };
      wave.dirty = true;
    }, { passive: false });
    ov.addEventListener('dblclick', e => {
      if (!wave.plots.length) return;
      const pi = WC.plotAt(wave.plots, posOf(e).y);
      if (pi < 0) return;
      const id = wave.plots[pi].id;
      wave.yView[id] = { zoom: 1, pan: 0 };
      Object.keys(wave.yState).forEach(k => { if (k.split(':')[0] === String(id)) delete wave.yState[k]; });
      markDirty();
    });
    if (wave.stage) {
      wave.stage.addEventListener('pointerenter', () => { wave.hoverStage = true; });
      wave.stage.addEventListener('pointerleave', () => { wave.hoverStage = false; });
    }
    if (document.addEventListener) document.addEventListener('keydown', waveKeyHandler);

    // 概览条: 拖动视窗框平移; 点击其他位置跳转到该处
    const oc = wave.overview && wave.overview.canvas;
    if (oc) {
      const opos = e => { const r = oc.getBoundingClientRect ? oc.getBoundingClientRect() : { left: 0 }; return e.clientX - r.left; };
      oc.addEventListener('pointerdown', e => {
        const info = wave.ovInfo;
        if (!info || !wave.lastView || e.button !== 0) return;
        if (oc.setPointerCapture && e.pointerId !== undefined) { try { oc.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
        const x = opos(e);
        const k = (info.b - info.a) / Math.max(1, info.x1 - info.x0);
        const span = wave.lastView.i1 - wave.lastView.i0;
        pushWaveUndo('overview');
        enterBrowse(wave.lastView);
        if (!(x >= info.xa && x <= info.xb)) {
          const idx = info.a + (x - info.x0) * k;
          wave.view = { i0: idx - span / 2, i1: idx + span / 2 };
        }
        // 先夹紧再记录拖动起点: 否则从越界的跳转位置开始拖动时, 前一段位移会被夹紧吃掉
        wave.view = clampBrowseView(wave.view);
        wave.ovDrag = { x0: x, view0: Object.assign({}, wave.view), k };
        markDirty();
      });
      oc.addEventListener('pointermove', e => {
        const d = wave.ovDrag;
        if (!d) return;
        const shift = (opos(e) - d.x0) * d.k;
        wave.view = { i0: d.view0.i0 + shift, i1: d.view0.i1 + shift };
        wave.dirty = true;
      });
      const end = () => { wave.ovDrag = null; };
      oc.addEventListener('pointerup', end);
      oc.addEventListener('pointercancel', end);
    }
  }

  function waveKeyHandler(e) {
    if (!wave.hoverStage && !(wave.stage && document.activeElement === wave.stage)) return;
    const tag = (e.target && e.target.tagName) || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
    let handled = true;
    if (e.key === ' ' || e.code === 'Space') toggleWavePause();
    else if (e.key === 'End') goLive();
    else if (e.key === 'Escape') clearWaveCursors();
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) undoWaveView();
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && wave.lastView) {
      const v = wave.mode === 'browse' && wave.view ? wave.view : wave.lastView;
      const d = (v.i1 - v.i0) * 0.1 * (e.key === 'ArrowLeft' ? -1 : 1);
      pushWaveUndo('key');
      enterBrowse(v);
      wave.view = { i0: v.i0 + d, i1: v.i1 + d };
      wave.dirty = true;
    } else handled = false;
    if (handled && e.preventDefault) e.preventDefault();
  }

  // ---------------------------------------------------------------- 全宽显示
  function applyWaveWide() {
    const card = document.getElementById('wave-card');
    const cap = document.getElementById('capture-card');
    const on = !!(wave.settings && wave.settings.wide);
    if (card && cap && cap.parentNode && card.parentNode) {
      if (on && card.parentNode !== cap.parentNode) {
        wave.homeParent = card.parentNode;
        wave.homeNext = card.nextSibling;
        cap.parentNode.insertBefore(card, cap);
      } else if (!on && wave.homeParent && card.parentNode !== wave.homeParent) {
        wave.homeParent.insertBefore(card, wave.homeNext);
      }
      if (card.classList) card.classList.toggle('wave-wide', on);
    }
    if (wave.ui.btnWide) {
      wave.ui.btnWide.textContent = on ? '⇲ 还原' : '⛶ 全宽';
      wave.ui.btnWide.title = on ? '恢复到右侧栏' : '波形卡片横跨两列显示 (适合分图/长时间浏览)';
    }
    measureStage();
    wave.dirty = true;
  }

  // ---------------------------------------------------------------- 设置面板
  function toggleWaveSettings(force) {
    const el = wave.settingsEl;
    if (!el) return;
    wave.settingsOpen = force === undefined ? !wave.settingsOpen : !!force;
    if (el.classList) el.classList.toggle('hidden', !wave.settingsOpen);
    if (wave.settingsOpen) buildWaveSettingsPanel();
  }

  function waveSubscribe() {
    if (!WC) return;   // 无 wave_core.js 时保持旧版 JSON
    const t = wave.settings ? wave.settings.transport : 'auto';
    const msg = { type: 'wave_subscribe', format: 'bin' };
    if (t === 'full') msg.full = true;
    else if (t === 'decim') msg.full = false;
    waveSendJson(msg);
  }

  function buildWaveSettingsPanel() {
    const host = wave.settingsEl;
    if (!host || !document.createElement) return;
    const s = wave.settings;
    host.textContent = '';
    const mk = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const section = title => host.appendChild(mk('div', 'ws-section', title));
    const row = (label, ...controls) => {
      const r = mk('div', 'ws-row');
      r.appendChild(mk('span', 'ws-label', label));
      const box = mk('div', 'ws-ctrl');
      controls.forEach(c => { if (c) box.appendChild(c); });
      r.appendChild(box);
      host.appendChild(r);
      return r;
    };
    const sel = (opts, value, onChange, title) => {
      const e = mk('select', 'custom-select wave-select');
      opts.forEach(([v, t]) => { const o = mk('option', '', t); o.value = String(v); e.appendChild(o); });
      e.value = String(value);
      if (title) e.title = title;
      e.addEventListener('change', () => onChange(e.value));
      return e;
    };
    const num = (value, min, max, step, onChange, title) => {
      const e = mk('input', 'custom-input ws-num');
      e.type = 'number'; e.min = String(min); e.max = String(max); e.step = String(step); e.value = String(value);
      if (title) e.title = title;
      e.addEventListener('change', () => { const v = Number(e.value); if (Number.isFinite(v)) onChange(v); });
      return e;
    };
    const chk = (checked, text, onChange, title) => {
      const l = mk('label', 'checkbox-inline');
      const i = mk('input');
      i.type = 'checkbox';
      i.checked = !!checked;
      i.addEventListener('change', () => onChange(i.checked));
      l.append(i, mk('span', '', text));
      if (title) l.title = title;
      return l;
    };
    const btn = (text, onClick, cls, title) => {
      const b = mk('button', 'btn btn-xs ' + (cls || 'btn-secondary'), text);
      if (title) b.title = title;
      b.addEventListener('click', onClick);
      return b;
    };
    const hint = text => mk('span', 'ws-hint', text);
    const apply = (rebuild) => { saveWaveSettings(); markDirty(); if (rebuild) buildWaveSettingsPanel(); };

    const title = mk('div', 'ws-title');
    title.append(mk('span', '', '⚙ Ch1 波形设置'), btn('✕', () => toggleWaveSettings(false), 'btn-secondary ws-close', '关闭'));
    host.appendChild(title);

    section('显示与历史');
    row('显示范围',
      sel([['time', '按时间'], ['points', '按点数']], s.xMode, v => { s.xMode = v; syncWindowSelect(); apply(true); }),
      s.xMode === 'time'
        ? num(s.windowSec, 0.01, s.historySec, 'any', v => { s.windowSec = clampNum(v, 0.01, s.historySec, 2); syncWindowSelect(); if (wave.mode !== 'live') goLive(); apply(false); }, '屏幕上一次显示的时长 (秒), 实时模式下滚轮也可调整')
        : num(s.points, 10, 5e6, 1, v => { s.points = Math.round(clampNum(v, 10, 5e6, 2000)); syncWindowSelect(); if (wave.mode !== 'live') goLive(); apply(false); }, '屏幕上一次显示的样本点数 (VOFA+ 风格)'),
      hint(s.xMode === 'time' ? '秒' : '点'));
    const histSel = sel(WAVE_HISTORY_PRESETS.map(v => [v, `${v} s`]).concat(WAVE_HISTORY_PRESETS.includes(s.historySec) ? [] : [[s.historySec, `${s.historySec} s (自定义)`]]),
      s.historySec, v => setHistory(Number(v)), '浏览器保留多久的数据可供回看');
    const histNum = num(s.historySec, 1, 3600, 1, v => setHistory(v), '自定义历史时长 (1~3600 秒)');
    wave.ui.memHint = hint('');
    row('历史时长', histSel, histNum, hint('秒'), wave.ui.memHint);
    function setHistory(v) {
      s.historySec = clampNum(v, 1, 3600, 60);
      if (s.windowSec > s.historySec) s.windowSec = s.historySec;
      saveWaveSettings();
      maybeResizeStore(true);
      buildWaveSettingsPanel();
    }

    section('布局与纵轴');
    row('布局', sel([['overlay', '叠加 (单图)'], ['split', '分图 (每通道一图)'], ['custom', '自定义分组']], s.layout, v => setWaveLayout(v)),
      hint('所有子图共用横轴, 缩放/平移/光标联动'));
    if (wave.nch) {
      const tbl = mk('div', 'ws-table');
      for (let c = 0; c < wave.nch; c++) {
        const r = mk('div', 'ws-trow');
        const dot = mk('span', 'wave-dot');
        dot.style.backgroundColor = WAVE_COLORS[c % WAVE_COLORS.length];
        r.append(dot, mk('span', 'ws-chname', wave.names[c] || `CH${c}`),
          chk(wave.visible[c] !== false, '显示', on => setWaveVisible(c, on)));
        const g = sel([1, 2, 3, 4, 5, 6, 7, 8].map(k => [k, `图 ${k}`]), s.groups[c] || 1, v => {
          for (let k = s.groups.length; k < wave.nch; k++) s.groups[k] = 1;
          s.groups[c] = Number(v) || 1;
          wave.yState = {};
          apply(true);
        }, '自定义分组: 同组通道画在同一子图');
        if (s.layout !== 'custom') g.disabled = true;
        r.appendChild(g);
        tbl.appendChild(r);
      }
      host.appendChild(tbl);
      const groups = buildWaveGroups();
      groups.forEach((gp, k) => {
        const cfg = yCfgOf(gp.id);
        const names = gp.chans.map(c => wave.names[c] || `CH${c}`).join(', ');
        const setCfg = patch => {
          s.yCfg[gp.id] = Object.assign(yCfgOf(gp.id), patch);
          wave.yView[gp.id] = { zoom: 1, pan: 0 };
          Object.keys(wave.yState).forEach(key => { if (key.split(':')[0] === String(gp.id)) delete wave.yState[key]; });
          apply(true);
        };
        const ctrls = [sel([['per', '分通道铺满'], ['auto', '共用自动'], ['manual', '手动范围'], ['sym', '对称 ±N']], cfg.mode, v => {
          const patch = { mode: v };
          if (v === 'manual' && !(cfg.max > cfg.min)) {
            const r = (wave.plots[k] && wave.plots[k].axis) || [-1, 1];
            patch.min = Number(r[0].toPrecision(4)); patch.max = Number(r[1].toPrecision(4));
          }
          setCfg(patch);
        }, '分通道铺满: 每个通道按自身范围铺满 (量纲差异大时用); 共用自动: 同组通道共用一个自动纵轴')];
        if (cfg.mode === 'manual') {
          ctrls.push(num(cfg.min, -1e12, 1e12, 'any', v => setCfg({ min: v }), '下限'), hint('~'),
            num(cfg.max, -1e12, 1e12, 'any', v => setCfg({ max: v }), '上限'));
        } else if (cfg.mode === 'sym') {
          ctrls.push(hint('±'), num(cfg.sym, 0, 1e12, 'any', v => setCfg({ sym: Math.abs(v) }), '0 = 按数据自动对称'));
        }
        ctrls.push(btn('复位缩放', () => { wave.yView[gp.id] = { zoom: 1, pan: 0 }; markDirty(); }, 'btn-secondary', '清除 Shift+滚轮 / Shift+拖拽 造成的纵向缩放平移 (也可双击子图)'));
        row(`图 ${k + 1} 纵轴`, ...ctrls).title = names;
      });
    }
    row('波形高度', sel([[0, '自动'], [180, '180 px'], [240, '240 px'], [320, '320 px'], [420, '420 px'], [560, '560 px'], [720, '720 px']], s.height,
      v => { s.height = Number(v) || 0; apply(false); }));

    section('采样与传输');
    const meta = waveParamMeta('wave_div');
    const curDiv = wave.ackVals.wave_div !== undefined ? Number(wave.ackVals.wave_div) : (meta && meta.val !== undefined ? Number(meta.val) : NaN);
    const divInput = num(Number.isFinite(curDiv) ? curDiv : 2, meta && meta.min !== undefined ? meta.min : 1, meta && meta.max !== undefined ? meta.max : 1000, 1, () => {}, '固件参数 wave_div: 每 N 个控制周期发送一帧 JustFloat');
    const divBtn = btn('应用', () => {
      const n = Math.round(Number(divInput.value));
      if (!(n >= 1)) return;
      waveSendRtt(`$SET:wave_div=${n}`);
      waveLog('system', `〰️ 已下发 Ch1 采样分频 wave_div=${n}`);
    }, 'btn-highlight');
    wave.ui.rateHint = hint('');
    if (!meta && wave.ackVals.wave_div === undefined) {
      divInput.disabled = true; divBtn.disabled = true;
      wave.ui.rateHint.textContent = '固件未注册 wave_div 参数 (RTT_REGISTER_UINT("wave_div", …)), 连接后点击 "刷新参数" 可检测';
      row('采样分频', divInput, divBtn, wave.ui.rateHint);
    } else {
      row('采样分频', divInput, divBtn, wave.ui.rateHint);
    }
    row('传输方式', sel([['auto', '自动 (本机全速 / 局域网抽取)'], ['full', '全速 (不抽取)'], ['decim', 'min/max 抽取']], s.transport,
      v => { s.transport = v; saveWaveSettings(); waveSubscribe(); buildWaveSettingsPanel(); }),
      hint(wave.sub ? `当前: ${wave.sub.mode === 'full' ? '二进制全速' : wave.sub.mode === 'decim' ? '二进制抽取' : 'JSON'}${wave.sub.lan ? ' · 局域网' : ' · 本机'}` : '当前: JSON (网关未确认订阅)'));
    row('刷新率上限', sel([[60, '60 fps'], [30, '30 fps'], [15, '15 fps']], s.fpsCap, v => { s.fpsCap = Number(v) || 60; apply(false); }),
      hint('笔记本省电或远程桌面时可降低'));

    section('选项');
    row('显示', chk(s.markers, '参数修改标注', on => { s.markers = on; apply(false); }, '收到 $SET 的 ACK 且数值变化时, 在时间轴上画竖线并标出 旧值→新值'),
      chk(s.smooth, '平滑滚动', on => { s.smooth = on; apply(false); }, '开: 匀速滚动, 约滞后 0.15 s; 关: 右端对齐最新样本, 延迟最低'),
      chk(s.clearOnConnect, '重新连接时自动清空', on => { s.clearOnConnect = on; apply(false); }));
    wave.ui.perfHint = hint('');
    row('性能', wave.ui.perfHint);
    const acts = mk('div', 'ws-actions');
    acts.append(
      btn('🗑 全部清空', () => clearAllData(), 'btn-secondary', '清空 Ch1 波形、终端、遥测看板与 Ch2 采集记录'),
      btn('恢复默认设置', () => {
        wave.settings = Object.assign({}, WAVE_DEFAULTS, { groups: [], yCfg: {} });
        wave.yView = {}; wave.yState = {};
        saveWaveSettings();
        if (wave.ui.layoutSel) wave.ui.layoutSel.value = wave.settings.layout;
        syncWindowSelect();
        applyWaveWide();
        maybeResizeStore(true);
        markDirty();
        buildWaveSettingsPanel();
      }, 'btn-secondary'));
    host.appendChild(acts);
    host.appendChild(mk('div', 'ws-help',
      '操作: 左键拖拽平移 · 滚轮缩放时间 (实时模式下调整窗口) · Shift+滚轮缩放纵轴 · Shift+拖拽平移纵轴 · Ctrl+拖拽框选放大 · ' +
      '单击放置光标 A, 右键放置光标 B · 双击复位纵轴 · 空格 暂停/继续 · End 回到实时 · Ctrl+Z 撤销缩放 · Esc 清除光标 · ←/→ 平移'));
    refreshWaveSettingsLive();
  }

  function refreshWaveSettingsLive() {
    const ui = wave.ui;
    if (ui.memHint) {
      const st = wave.store, cap = wave.capInfo;
      if (st && cap) {
        const avail = wave.axis.timeOf(st.head) - wave.axis.timeOf(st.oldest);
        ui.memHint.textContent = `已缓存 ${avail.toFixed(1)} s / 可回看 ${cap.seconds.toFixed(0)} s · 内存 ${(st.bytes() / 1048576).toFixed(1)} MB / ${(WAVE_MEM_LIMIT / 1048576).toFixed(0)} MB${cap.limited ? ' (受内存上限限制)' : ''}`;
      } else ui.memHint.textContent = '等待数据…';
    }
    if (ui.rateHint && !(ui.rateHint.textContent || '').startsWith('固件未注册')) {
      const fps = wave.fps;
      const div = Number(wave.ackVals.wave_div);
      ui.rateHint.textContent = fps > 0
        ? `实测 ${fps.toFixed(0)} 帧/s · 周期 ${(1000 / fps).toFixed(2)} ms${div > 0 ? ` · 基础循环约 ${(fps * div).toFixed(0)} Hz` : ''}`
        : '尚未收到 Ch1 数据';
    }
    if (ui.perfHint) {
      ui.perfHint.textContent = `渲染 ${wave.perf.ms.toFixed(2)} ms (p95 ${wave.perf.p95.toFixed(2)} ms) · ${wave.perf.vertices} 顶点 · 网格重绘 ${wave.perf.gridDraws} 次 / ${wave.perf.frames} 帧`;
    }
  }

  // ================= 终端输出与交互 =================

  function setupTerminal() {
    els.btnTermSend.addEventListener('click', handleTermSubmit);
    els.termInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleTermSubmit();
    });
    els.btnClearTerm.addEventListener('click', () => {
      els.termOutput.innerHTML = '';
    });
  }

  function handleTermSubmit() {
    const cmd = els.termInput.value.trim();
    if (!cmd) return;
    sendRttCommand(cmd);
    els.termInput.value = '';
  }

  function logTerminal(type, text) {
    const line = document.createElement('div');
    line.className = `log-line ${type}`;

    const now = new Date();
    const timeStr = `[${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}.${String(now.getMilliseconds()).padStart(3, '0')}]`;

    line.textContent = `${timeStr} ${text}`;
    els.termOutput.appendChild(line);

    if (els.autoScrollCheck.checked) {
      els.termOutput.scrollTop = els.termOutput.scrollHeight;
    }

    // 限制终端最大保留 500 行，防止卡顿
    if (els.termOutput.childElementCount > 500) {
      els.termOutput.removeChild(els.termOutput.firstChild);
    }
  }

  // 暴露最小桥接接口供 capture_panel.js 与自动化测试调用
  window.RTTApp = {
    sendRtt: sendRttCommand,
    sendJson: sendJson,
    logTerminal: logTerminal,
    isConnected: () => isConnected,
    // kind: 'analysis' (默认: A-B 光标区间, 否则当前视图) | 'export' (A-B 区间, 否则全部历史)
    getCh1Snapshot: (kind) => getCh1Snapshot(kind),
    // v3.1 波形面板调试/自动化接口
    wave: {
      state: wave, clear: clearWave, clearAll: clearAllData, goLive, pause: toggleWavePause, undo: undoWaveView,
      setLayout: setWaveLayout, setCursor: setWaveCursor, exportCsv: exportWaveCsv, openSettings: toggleWaveSettings,
      render: renderWaveFrame
    }
  };

  // 页面加载完成后启动
  window.addEventListener('DOMContentLoaded', init);

})();
