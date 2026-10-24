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

  // 防抖计时器集合
  const debounceTimers = {};

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

    els.btnConnect.addEventListener('click', toggleConnect);
    els.btnPing.addEventListener('click', sendPing);
    els.btnRefreshAll.addEventListener('click', () => sendRttCommand('$GET:ALL'));
    els.autoSyncToggle.addEventListener('change', (e) => {
      autoSyncEnabled = e.target.checked;
    });
  }

  // ================= 芯片预设切换 =================

  function setupChipPresets() {
    if (!els.chipPreset) return;
    const presets = {
      h723: { targetChip: 'STM32H723VG', openocdTarget: 'stm32h7x', openocdRam: '0x24000000' },
      f407: { targetChip: 'STM32F407ZG', openocdTarget: 'stm32f4x', openocdRam: '0x20000000' },
      f103: { targetChip: 'STM32F103C8', openocdTarget: 'stm32f1x', openocdRam: '0x20000000' },
      g474: { targetChip: 'STM32G474RB', openocdTarget: 'stm32g4x', openocdRam: '0x20000000' },
      f334: { targetChip: 'STM32F334C8', openocdTarget: 'stm32f3x', openocdRam: '0x20000000' }
    };
    els.chipPreset.addEventListener('change', (e) => {
      const cfg = presets[e.target.value];
      if (cfg) {
        if (els.targetChip) els.targetChip.value = cfg.targetChip;
        if (els.openocdTarget) els.openocdTarget.value = cfg.openocdTarget;
        if (els.openocdRam) els.openocdRam.value = cfg.openocdRam;
        logTerminal('system', `已切换芯片预设: ${cfg.targetChip} (OpenOCD: ${cfg.openocdTarget}, RAM: ${cfg.openocdRam})`);
      }
    });
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

      ws.onopen = () => {
        logTerminal('system', '✅ WebSocket 网关已成功握手');
        sendJson({ type: 'get_status' });
      };

      ws.onmessage = (event) => {
        handleServerMessage(event.data);
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
          break;

        case 'connect_result':
          logTerminal(msg.success ? 'system' : 'ack-err', msg.message);
          if (msg.status) updateConnectionStatus(msg.status);
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

        case 'wave_status':
          logTerminal(msg.connected ? 'system' : 'ack-err', `[Ch1] ${msg.message}`);
          if (!msg.connected && els.waveInfo) els.waveInfo.textContent = 'Ch1 未连接';
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
        openocd_ram: ocdRam
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

  function updateAckBadge(paramName, className, text) {
    const badge = document.getElementById(`ack-${paramName}`);
    if (badge) {
      badge.className = `param-ack-badge ${className}`;
      badge.textContent = text;
      
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

      // 滑动条拖动同步
      slider.addEventListener('input', (e) => {
        input.value = e.target.value;
        if (autoSyncEnabled) {
          debounceSend(item.id, e.target.value);
        }
      });

      // 数字输入框修改
      input.addEventListener('change', (e) => {
        slider.value = e.target.value;
        sendParamUpdate(item.id, e.target.value);
      });

      // 发送按钮点击
      if (btnSend) {
        btnSend.addEventListener('click', () => {
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
          input.value = next;
          slider.value = next;
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

  function debounceSend(paramName, value) {
    clearTimeout(debounceTimers[paramName]);
    debounceTimers[paramName] = setTimeout(() => {
      sendParamUpdate(paramName, value);
    }, 40); // 40ms 防抖
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

  function renderDynamicParams() {
    const knownKeys = ['pid_kp', 'pid_ki', 'pid_kd', 'target_speed', 'max_current', 'work_mode', 'motor_en'];
    const unknowns = [];
    dynamicParams.forEach((meta, name) => {
      if (!knownKeys.includes(name)) {
        unknowns.push(meta);
      }
    });

    if (unknowns.length === 0) {
      els.dynamicContainer.innerHTML = '<div class="empty-hint">所有注册参数均已在上方专属控制面板中显示。</div>';
      return;
    }

    els.dynamicContainer.innerHTML = '';
    unknowns.forEach(meta => {
      const row = document.createElement('div');
      row.className = 'param-row';
      row.innerHTML = `
        <div class="param-info">
          <span class="param-name">${meta.name}</span>
          <span class="param-tag">Type ${meta.type_code} [${meta.min}..${meta.max}]</span>
          <span class="param-ack-badge" id="ack-${meta.name}">已同步: ${meta.val}</span>
        </div>
        <div class="param-control">
          <input type="range" class="range-slider" id="slider-${meta.name}" min="${meta.min}" max="${meta.max}" step="${meta.type_code === 0 ? '0.01' : '1'}" value="${meta.val}">
          <div class="num-box-group">
            <input type="number" class="num-input" id="input-${meta.name}" value="${meta.val}">
            <button class="btn btn-xs btn-send" id="btn-send-${meta.name}">发送</button>
          </div>
        </div>
      `;
      els.dynamicContainer.appendChild(row);

      const sl = row.querySelector(`#slider-${meta.name}`);
      const inp = row.querySelector(`#input-${meta.name}`);
      const btn = row.querySelector(`#btn-send-${meta.name}`);

      sl.addEventListener('input', (e) => {
        inp.value = e.target.value;
        if (autoSyncEnabled) debounceSend(meta.name, e.target.value);
      });
      inp.addEventListener('change', (e) => {
        sl.value = e.target.value;
        sendParamUpdate(meta.name, e.target.value);
      });
      btn.addEventListener('click', () => {
        sendParamUpdate(meta.name, inp.value);
      });
    });
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
      ctx.strokeStyle = '#1e2430';
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
      ctx.strokeStyle = '#58a6ff';
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
      ctx.strokeStyle = '#3fb950';
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

  // ================= Ch1 JustFloat 波形 (2026-10-23 新增) =================
  // 数据来源: 网关读取 OpenOCD 19022 (RTT Channel 1) 并解码 JustFloat; VOFA+ 同时直连 19022, 两边同源。
  // 网关每 25ms 推送一批帧, 帧多时等间隔抽取 (msg.decim), 因此网页用于观察趋势, 全速细节以 VOFA+ 为准。
  // x 轴按样本序号: 时间窗 = windowSec × displayRate 个样本 (displayRate 为平滑后的 fps / decim)。
  const WAVE_COLORS = ['#58a6ff', '#3fb950', '#d29922', '#f778ba', '#a371f7', '#39c5bb', '#f85149', '#e6edf3'];
  const WAVE_MAX_SAMPLES = 20000;
  const WAVE_NAMES_KEY = 'ch1WaveNames';
  // 平滑播放参数 (FIX-024 调整): 曲线右端比最新样本滞后约 WAVE_PLAY_LAG_S。
  // 无线 OpenOCD 轮询间隔实测 100~260ms, 滞后取 0.15s 时, 间隔不超过约 0.2s 就不会出现"停住等数据"。
  // 代价: 曲线比图例数值晚约 0.15s 显示。积压超过 WAVE_PLAY_RESET_S (如暂停后恢复) 直接跳到最新。
  const WAVE_PLAY_LAG_S = 0.15;
  const WAVE_PLAY_RESET_S = 0.6;
  const wave = {
    nch: 0, ch: [], names: [], visible: [], valEls: [], nameEls: [],
    paused: false, windowSec: 2, fps: 0, displayRate: 0, rateJumpCount: 0, decim: 1, resync: 0, scaleMode: 'per',
    playhead: 0, lastDrawTs: 0, lastRx: 0,
    lastLegendUpdate: 0, canvas: null, ctx: null
  };

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
    // 立即用最新一帧刷新看板, 不必等下一批数据
    if (wave.ch.length && wave.ch[0].length) {
      pushCh1ToDashboard(wave.ch.map(a => a[a.length - 1]), true);
      flushTelemetryRender();
    }
  }

  function setupWavePanel() {
    wave.canvas = document.getElementById('waveCanvas');
    if (!wave.canvas) return;
    wave.ctx = wave.canvas.getContext('2d');
    els.waveInfo = document.getElementById('wave-info');
    els.waveLegend = document.getElementById('wave-legend');
    const winSel = document.getElementById('wave-window');
    const btnPause = document.getElementById('btn-wave-pause');

    const resize = () => {
      const rect = wave.canvas.parentElement.getBoundingClientRect();
      wave.canvas.width = Math.max(200, rect.width - 24);
      wave.canvas.height = 220;
    };
    window.addEventListener('resize', resize);
    resize();

    if (winSel) winSel.addEventListener('change', () => { wave.windowSec = Number(winSel.value) || 2; });
    const scaleSel = document.getElementById('wave-scale');
    if (scaleSel) {
      wave.scaleMode = scaleSel.value === 'shared' ? 'shared' : 'per';
      scaleSel.addEventListener('change', () => { wave.scaleMode = scaleSel.value === 'shared' ? 'shared' : 'per'; });
    }
    if (btnPause) btnPause.addEventListener('click', () => {
      wave.paused = !wave.paused;
      btnPause.textContent = wave.paused ? '继续' : '暂停';
    });
    requestAnimationFrame(drawWave);
  }

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
      dot.addEventListener('click', () => {
        wave.visible[i] = !wave.visible[i];
        item.classList.toggle('wave-hidden', !wave.visible[i]);
      });
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
    }
    syncCh1Keys();   // 通道数变化: 重算看板键名映射, 删除多余通道的旧磁贴
  }

  function handleWave(msg) {
    const nch = Number(msg.nch) | 0;
    if (!Array.isArray(msg.frames) || nch <= 0 || nch > 32) return;
    if (nch !== wave.nch) {
      wave.nch = nch;
      wave.ch = Array.from({ length: nch }, () => []);
      wave.playhead = 0;
      wave.displayRate = 0;
      wave.rateJumpCount = 0;
      wave.lastDrawTs = 0;
      rebuildWaveLegend();
    }
    for (const fr of msg.frames) {
      if (!Array.isArray(fr) || fr.length !== nch) continue;
      for (let i = 0; i < nch; i++) {
        const v = fr[i];
        wave.ch[i].push(typeof v === 'number' ? v : NaN);
      }
    }
    if (wave.ch[0].length > WAVE_MAX_SAMPLES + 2000) {
      const drop = wave.ch[0].length - WAVE_MAX_SAMPLES;
      wave.ch.forEach(a => a.splice(0, drop));
      wave.playhead = Math.max(0, wave.playhead - drop);
    }
    wave.fps = Number(msg.fps) || wave.fps;
    wave.decim = Number(msg.decim) || 1;
    wave.resync = Number(msg.resync) || 0;
    wave.lastRx = performance.now();
    updateDisplayRate(wave.fps > 0 ? wave.fps / wave.decim : 0);
    pushCh1ToDashboard(msg.frames[msg.frames.length - 1]);

    const now = performance.now();
    if (now - wave.lastLegendUpdate > 100) {
      wave.lastLegendUpdate = now;
      const last = msg.frames[msg.frames.length - 1];
      if (Array.isArray(last)) {
        wave.valEls.forEach((el, i) => {
          const v = last[i];
          el.textContent = (typeof v === 'number') ? Number(v.toPrecision(6)).toString() : 'NaN';
        });
      }
      if (els.waveInfo) {
        const dec = wave.decim > 1 ? ` · 抽取 1/${wave.decim}` : '';
        els.waveInfo.textContent = `${wave.fps.toFixed(0)} 帧/s · ${nch} 通道${dec} · 重同步 ${wave.resync}`;
      }
    }
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

  // 平滑播放头: 无线 OpenOCD 约每 120ms 成批送达 ~30 个样本 (250 帧/s 时),
  // 若每帧直接画到最新样本, 60Hz 下表现为"静止约 7 帧 -> 瞬移 30 点"。
  // 播放头按采样率匀速推进, 并按积压量做 ±比例修正, 使滞后稳定在 WAVE_PLAY_LAG_S 附近。
  function advancePlayhead(ts, bufLen, rate) {
    if (typeof ts !== 'number' || wave.lastDrawTs <= 0 || !(wave.fps > 0)) {
      wave.playhead = bufLen;
    } else {
      const dt = Math.min(0.1, Math.max(0, (ts - wave.lastDrawTs) / 1000));
      const lagS = (bufLen - wave.playhead) / rate;
      if (lagS < 0 || lagS > WAVE_PLAY_RESET_S) {
        wave.playhead = Math.max(2, bufLen - rate * WAVE_PLAY_LAG_S);
      } else if (lagS > 0) {
        const speed = 1 + Math.max(-0.25, Math.min(0.5, (lagS - WAVE_PLAY_LAG_S) * 2.5));
        wave.playhead = Math.min(bufLen, wave.playhead + rate * speed * dt);
      }
    }
    if (typeof ts === 'number') wave.lastDrawTs = ts;
  }

  function drawWave(ts) {
    requestAnimationFrame(drawWave);
    if (wave.paused || !wave.ctx) return;
    const c = wave.ctx;
    const w = wave.canvas.width;
    const h = wave.canvas.height;
    c.clearRect(0, 0, w, h);
    c.strokeStyle = '#1e2430';
    c.lineWidth = 1;
    for (let y = 20; y < h; y += 40) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
    if (wave.nch === 0 || wave.ch[0].length < 2) return;

    const bufLen = wave.ch[0].length;
    const rate = wave.displayRate > 0 ? wave.displayRate : 50;
    advancePlayhead(ts, bufLen, rate);

    const total = Math.min(bufLen, Math.max(2, Math.round(wave.playhead)));
    const n = Math.max(2, Math.min(total, Math.round(wave.windowSec * rate)));
    const start = total - n;

    // 纵轴范围: 共用纵轴 = 所有可见通道合并求 min/max;
    // 分通道缩放 = 每个通道按自身 min/max 铺满高度 (量纲差别大时, 如 ±1 的 sin 与 1500 的转速, 小幅值通道不再被压成直线)
    const chRange = (i) => {
      let lo = Infinity, hi = -Infinity;
      const a = wave.ch[i];
      for (let k = start; k < total; k++) {
        const v = a[k];
        if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
      }
      return [lo, hi];
    };
    const padRange = (lo, hi) => {
      const pad = Math.max((hi - lo) * 0.08, Math.abs(hi) * 0.02, 1e-6);
      return [lo - pad, hi + pad];
    };
    const ranges = [];
    let gLo = Infinity, gHi = -Infinity;
    for (let i = 0; i < wave.nch; i++) {
      if (!wave.visible[i]) continue;
      const [lo, hi] = chRange(i);
      ranges[i] = [lo, hi];
      if (lo < gLo) gLo = lo;
      if (hi > gHi) gHi = hi;
    }
    if (!Number.isFinite(gLo)) return;
    const shared = wave.scaleMode === 'shared';
    const [sLo, sHi] = padRange(gLo, gHi);
    for (let i = 0; i < wave.nch; i++) {
      if (!ranges[i]) continue;
      ranges[i] = shared ? [sLo, sHi]
        : (Number.isFinite(ranges[i][0]) ? padRange(ranges[i][0], ranges[i][1]) : [sLo, sHi]);
    }
    const yIn = (v, r) => h - 8 - ((v - r[0]) / (r[1] - r[0])) * (h - 16);

    if (shared && sLo < 0 && sHi > 0) {   // 零线 (仅共用纵轴时有意义)
      c.strokeStyle = '#30363d';
      c.setLineDash([3, 3]);
      c.beginPath(); c.moveTo(0, yIn(0, [sLo, sHi])); c.lineTo(w, yIn(0, [sLo, sHi])); c.stroke();
      c.setLineDash([]);
    }

    const perPx = n / w;
    for (let i = 0; i < wave.nch; i++) {
      if (!wave.visible[i]) continue;
      const a = wave.ch[i];
      const r = ranges[i];
      const yOf = v => yIn(v, r);
      c.strokeStyle = WAVE_COLORS[i % WAVE_COLORS.length];
      c.lineWidth = 1.5;
      c.beginPath();
      let pen = false;
      if (perPx <= 1.5) {
        for (let k = 0; k < n; k++) {
          const v = a[start + k];
          if (!Number.isFinite(v)) { pen = false; continue; }
          const x = (k / (n - 1)) * w;
          if (pen) c.lineTo(x, yOf(v)); else { c.moveTo(x, yOf(v)); pen = true; }
        }
      } else {
        // 样本多于像素: 每列画 min-max 竖线, 保留尖峰 (简单抽点会漏掉)
        for (let px = 0; px < w; px++) {
          const k0 = start + Math.floor(px * perPx);
          const k1 = Math.min(total, start + Math.floor((px + 1) * perPx));
          let mn = Infinity, mx = -Infinity;
          for (let k = k0; k < k1; k++) {
            const v = a[k];
            if (Number.isFinite(v)) { if (v < mn) mn = v; if (v > mx) mx = v; }
          }
          if (!Number.isFinite(mn)) { pen = false; continue; }
          if (pen) c.lineTo(px, yOf(mn)); else { c.moveTo(px, yOf(mn)); pen = true; }
          c.lineTo(px, yOf(mx));
        }
      }
      c.stroke();
    }

    c.fillStyle = '#8b949e';
    c.font = '11px monospace';
    if (shared) {
      c.fillText(Number(sHi.toPrecision(5)).toString(), 4, 12);
      c.fillText(Number(sLo.toPrecision(5)).toString(), 4, h - 4);
    } else {
      c.fillText('分通道缩放 (数值见图例)', 4, 12);
    }
    c.fillText(`${wave.windowSec}s / ${n} 点`, w - 90, 12);
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

  // 页面加载完成后启动
  window.addEventListener('DOMContentLoaded', init);

})();
