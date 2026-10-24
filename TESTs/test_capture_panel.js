'use strict';
/**
 * Node.js 单元测试: host/web/capture_panel.js 与 analysis.js 联动测试
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CP = require('../host/web/capture_panel.js');
const A = require('../host/web/analysis.js');

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${name} ${detail}`);
  }
}
function near(a, b, tol) { return Number.isFinite(a) && Math.abs(a - b) <= tol; }

// 1. parseCapAck 解析测试
{
  const info = CP.parseCapAck('$ACK:CAP:INFO:ver=1,max_ch=4,buf=65536,depth=4096,base_hz=20000,fmt=f32,names=ref|plant|sine|count');
  check('INFO ok', info.ok === true && info.kind === 'INFO');
  check('INFO depth', info.depth === 4096 && info.base_hz === 20000);
  check('INFO names', info.names.length === 4 && info.names[1] === 'plant');

  const stat = CP.parseCapAck('$ACK:CAP:STAT:state=ARMED,cap_id=3,arm_cnt=5,trig_cnt=4,tx_drop=0,isr_avg_cy=232,isr_max_cy=396');
  check('STAT ok', stat.ok === true && stat.kind === 'STAT');
  check('STAT cycles', stat.isr_avg_cy === 232 && stat.isr_max_cy === 396 && stat.tx_drop === 0);

  const err = CP.parseCapAck('$ACK:ERR:CAP:BUSY');
  check('ERR ok=false', err.ok === false && err.error === 'BUSY');
}

// 2. buildCfgCommand 边界与格式化
{
  const cmd = CP.buildCfgCommand({ ch: 0, edge: 'rise', level: 0.5, pre: 20, div: 1, mode: 'single', auto_ms: 200 });
  check('buildCfgCommand', cmd === '$CAP:CFG:ch=0,edge=rise,level=0.5,pre=20,div=1,run=single,auto=200', cmd);

  const clamped = CP.buildCfgCommand({ ch: -3, edge: 'invalid', level: 'bad', pre: 150, div: 0, mode: 'xyz', auto_ms: -5 });
  check('buildCfgCommand clamp', clamped === '$CAP:CFG:ch=0,edge=rise,level=0,pre=99,div=1,run=single,auto=1', clamped);
}

// 3. onCapture + 阶跃响应 / FFT / STFT 联动分析
{
  const fsHz = 20000;
  const n = 2048;
  const trigIdx = 400;
  const wn = 2 * Math.PI * 100;
  const zeta = 0.3;
  const wd = wn * Math.sqrt(1 - zeta * zeta);
  const phi = Math.acos(zeta);

  const ref = new Array(n);
  const plant = new Array(n);
  const sine = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / fsHz;
    if (i < trigIdx) {
      ref[i] = 0;
      plant[i] = 0;
    } else {
      const ts = (i - trigIdx) / fsHz;
      ref[i] = 1.0;
      plant[i] = 1.0 - (Math.exp(-zeta * wn * ts) / Math.sqrt(1 - zeta * zeta)) * Math.sin(wd * ts + phi);
    }
    sine[i] = 1.0 * Math.sin(2 * Math.PI * 1000 * t) + 0.1 * Math.sin(2 * Math.PI * 3000 * t);
  }

  const cap = CP.onCapture({
    cap_id: 42,
    sample_hz: fsHz,
    nch: 3,
    fmt_name: 'f32',
    trigger_index: trigIdx,
    trigger_ch: 0,
    total: n,
    names: ['ref', 'plant', 'sine'],
    channels: [ref, plant, sine]
  });

  check('onCapture valid', cap !== null && cap.cap_id === 42 && cap.total === n);
  check('history stored', CP.state.history.length === 1 && CP.state.current === cap);

  const sr = CP.runStepAnalysis();
  check('stepResponse ok', sr && sr.ok === true);
  check('stepResponse overshoot ~37.2%', near(sr.overshootPct, 37.23, 0.8), `got ${sr && sr.overshootPct}`);
  check('stepResponse zeta ~0.3', near(sr.zeta, 0.3, 0.02), `got ${sr && sr.zeta}`);

  // 切换到 sine 通道做 FFT (无 DOM 时默认 ch=0, 我们把 sine 放在 ch0 测一次无 DOM 分支)
  CP.onCapture({
    cap_id: 43,
    sample_hz: fsHz,
    nch: 1,
    fmt_name: 'f32',
    trigger_index: 0,
    total: n,
    names: ['sine'],
    channels: [sine]
  });
  const fftRes = CP.runFftAnalysis();
  check('fftAnalysis ok', fftRes !== null && fftRes.peaks.length >= 2);
  check('fft peak1 ~1000Hz', near(fftRes.peaks[0].f, 1000, 3) && near(fftRes.peaks[0].amp, 1.0, 0.02));
  check('fft thd ~10%', near(fftRes.thdRes.thdPct, 10.0, 0.5), `got ${fftRes.thdRes.thdPct}`);

  const stftRes = CP.runStftAnalysis();
  check('stftAnalysis ok', stftRes !== null && stftRes.times.length > 5 && stftRes.freqs.length === 129);

  const csv = CP.exportCurrentCsv();
  check('exportCurrentCsv', typeof csv === 'string' && csv.trim().split('\n').length === n + 1);

  const json = CP.exportCurrentJson();
  check('exportCurrentJson', typeof json === 'string' && JSON.parse(json).cap_id === 43);
}

// 4. 校验 app.js 与 index.html 中的消息转发桥接契约
{
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'host', 'web', 'app.js'), 'utf8');
  const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'host', 'web', 'index.html'), 'utf8');
  check('app.js forwards capture', appSrc.includes("case 'capture':") && appSrc.includes('RTTCapturePanel.onCapture'));
  check('app.js forwards capture_status', appSrc.includes("case 'capture_status':") && appSrc.includes('RTTCapturePanel.onStatus'));
  check('app.js forwards cap_ack', appSrc.includes("case 'cap_ack':") && appSrc.includes('RTTCapturePanel.onAck'));
  check('app.js exposes window.RTTApp', appSrc.includes('window.RTTApp ='));
  check('index.html loads analysis.js & capture_panel.js',
    htmlSrc.includes('<script src="analysis.js"></script>') && htmlSrc.includes('<script src="capture_panel.js"></script>'));
}

console.log(`capture_panel tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
