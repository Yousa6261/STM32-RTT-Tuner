// Browser E2E (no hardware) for the v3.2 connection fixes, using a FAKE OpenOCD:
//   - default mode is "auto"; the user's manual choice (e.g. ST-Link) is persisted and really takes effect
//     (changing the dropdown while connected disconnects and reconnects with the new mode)
//   - VOFA+ forward badge shows live client count; bytes forwarded to a raw TCP "VOFA+" client are valid JustFloat
//   - overlay waveform default = ONE shared Y axis (true amplitude ratio), per-channel normalise only on request
//   node TESTs/hw/e2e_connect_ui.js
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 8798, CDP_PORT = 9334;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
let pass = 0, fail = 0;
const check = (n, c, i = '') => { if (c) { pass++; console.log('PASS ', n); } else { fail++; console.log('FAIL ', n, typeof i === 'string' ? i : JSON.stringify(i)); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const killTree = p => { if (!p || p.exitCode !== null) return; try { if (process.platform === 'win32') execSync(`taskkill /PID ${p.pid} /T /F`, { stdio: 'ignore' }); else p.kill('SIGKILL'); } catch (e) { /* gone */ } };

async function main() {
  if (!CHROME) { console.log('SKIP: Chrome/Edge not found'); return 0; }
  const gw = spawn(process.platform === 'win32' ? 'python' : 'python3', [path.join(__dirname, 'serve_connect_gateway.py'), '--port', String(PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let gwOut = '';
  gw.stdout.on('data', d => { gwOut += d; });
  gw.stderr.on('data', d => { gwOut += d; });
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'rtt-e2e-conn-'));
  let chrome = null, ws = null, vofa = null;
  try {
    for (let k = 0; k < 60 && !/ready/.test(gwOut); k++) await sleep(100);
    if (!/ready/.test(gwOut)) throw new Error('gateway failed: ' + gwOut);
    chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check', '--window-size=1600,1400', 'about:blank'], { stdio: 'ignore' });
    let target = null;
    for (let k = 0; k < 80 && !target; k++) {
      await sleep(150);
      try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch (e) { /* not up yet */ }
    }
    if (!target) throw new Error('chrome CDP not reachable');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let seq = 0;
    const pending = new Map(), events = [], errors = [];
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
      events.push(m);
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text);
    };
    const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
    const ev = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(`eval failed: ${expr}\n${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
      return r.result.value;
    };
    const waitFor = async (expr, ms = 8000) => { for (let t = 0; t < ms; t += 100) { if (await ev(expr)) return true; await sleep(100); } return false; };
    const load = async () => {
      events.length = 0;
      await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
      for (let k = 0; k < 100 && !events.some(e => e.method === 'Page.loadEventFired'); k++) await sleep(50);
      await sleep(700);
    };
    const statusText = () => ev(`document.getElementById('status-text').textContent`);

    await send('Page.enable'); await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1400, deviceScaleFactor: 1, mobile: false });
    await load();

    // ---------------------------------------------------------------- 1) default mode / labels
    const opts = await ev(`[...document.getElementById('conn-mode').options].map(o => ({ v: o.value, t: o.textContent }))`);
    check('default connection mode is "auto" (no longer hard-wired to DAP-Link)', await ev(`document.getElementById('conn-mode').value`) === 'auto', opts);
    check('auto option present and first; ST-Link / DAP-Link still selectable', opts[0].v === 'auto' && opts.some(o => o.v === 'stlink') && opts.some(o => o.v === 'daplink'), opts);
    const tel = opts.find(o => o.v === 'telnet');
    check('"Telnet 转发模式" renamed to a self-explanatory TCP direct mode', tel && /TCP 直连/.test(tel.t) && !/转发/.test(tel.t), tel);

    // ---------------------------------------------------------------- 2) connect with auto -> reuses the running (fake) OpenOCD
    await ev(`document.getElementById('btn-connect').click()`);
    check('auto: connects by reusing the already running OpenOCD', await waitFor(`window.RTTApp.isConnected()`, 8000), await statusText());
    check('status shows it reused the existing OpenOCD', /复用已有 OpenOCD/.test(await statusText()), await statusText());
    await sleep(1500);
    const fps1 = await ev(`window.RTTApp.wave.state.fps`);
    check('Ch1 streaming through the gateway (~100 fps from fake OpenOCD)', fps1 > 60 && fps1 < 160, fps1);

    // ---------------------------------------------------------------- 2b) silent firmware (fake OpenOCD never answers $GET:ALL) -> explicit warning, not a silent empty list
    check('no $GET:ALL answer -> parameter badge turns into a visible warning', await waitFor(`document.getElementById('dynamic-param-count').classList.contains('count-warn')`, 6000), await ev(`document.getElementById('dynamic-param-count').textContent`));
    check('warning text in the terminal explains RTT_Param_Poll / registering variables', /RTT_Param_Poll/.test(await ev(`document.getElementById('terminal-output').innerText`)));

    // ---------------------------------------------------------------- 3) overlay Y axis default = shared true amplitude
    await sleep(500);
    const ax = await ev(`(() => { const w = window.RTTApp.wave.state; const p = w.plots[0]; return { n: w.plots.length, axis: p && p.axis, same: p && [0,1,2].every(c => p.ranges[c] === p.axis), mode: w.settings.layout }; })()`);
    check('overlay default: ONE shared Y axis (1500 target + ±1 sine keep their true ratio)', ax.n === 1 && Array.isArray(ax.axis) && ax.same && ax.axis[1] >= 1500, ax);
    await ev(`(() => { const w = window.RTTApp.wave.state; w.settings.yCfg = { 1: { mode: 'per' } }; w.yState = {}; w.dirty = true; })()`);
    await sleep(300);
    check('per-channel normalise is still available on request (axis=null)', await ev(`window.RTTApp.wave.state.plots[0].axis === null`));
    await ev(`(() => { const w = window.RTTApp.wave.state; w.settings.yCfg = {}; w.yState = {}; w.dirty = true; })()`);

    // ---------------------------------------------------------------- 4) VOFA+ forwarding: badge + bytes
    check('VOFA+ badge initially shows plain port', /VOFA\+ :\d+$/.test(await ev(`document.getElementById('vofa-text').textContent`)), await ev(`document.getElementById('vofa-text').textContent`));
    const chunks = [];
    vofa = net.connect(PORT + 1, '127.0.0.1');
    vofa.on('data', d => chunks.push(d));
    check('VOFA+ badge shows 1 connected client + turns active', await waitFor(`/1 已连接/.test(document.getElementById('vofa-text').textContent) && document.getElementById('vofa-badge').classList.contains('vofa-active')`, 5000), await ev(`document.getElementById('vofa-text').textContent`));
    await sleep(800);
    const buf = Buffer.concat(chunks);
    let okFrames = 0, bad = 0;
    for (let off = 0; off + 16 <= buf.length; off += 16) {
      if (buf.readUInt32LE(off + 12) === 0x7F800000) okFrames++; else { bad++; break; }
    }
    check('forwarded bytes to VOFA+ are aligned JustFloat frames (3 ch + 00 00 80 7F)', okFrames > 20 && bad === 0, { okFrames, bad, len: buf.length });
    vofa.destroy(); vofa = null;
    check('badge returns to plain after VOFA+ disconnects', await waitFor(`!/已连接/.test(document.getElementById('vofa-text').textContent)`, 5000));

    // ---------------------------------------------------------------- 5) manual ST-Link choice really takes effect (+ persisted)
    await ev(`(() => { const s = document.getElementById('conn-mode'); s.value = 'stlink'; s.dispatchEvent(new Event('change')); })()`);
    check('changing the dropdown while connected reconnects with the new mode (status becomes ST-Link)',
      await waitFor(`window.RTTApp.isConnected() && /ST-Link/.test(document.getElementById('status-text').textContent)`, 10000), await statusText());
    check('choice persisted in localStorage', await ev(`localStorage.getItem('connMode')`) === 'stlink');
    await load();
    check('after page reload the dropdown still shows ST-Link (not reset to DAP-Link)', await ev(`document.getElementById('conn-mode').value`) === 'stlink');
    check('after reload the status still says ST-Link', await waitFor(`/ST-Link/.test(document.getElementById('status-text').textContent)`, 5000), await statusText());
    await ev(`(() => { const s = document.getElementById('conn-mode'); s.value = 'daplink'; s.dispatchEvent(new Event('change')); })()`);
    check('switching to DAP-Link also takes effect', await waitFor(`window.RTTApp.isConnected() && /DAP-Link/.test(document.getElementById('status-text').textContent)`, 10000), await statusText());

    check('no JS exceptions in page', errors.length === 0, errors.slice(0, 3));
  } catch (e) {
    fail++; console.log('FAIL  e2e aborted:', e.message);
  } finally {
    try { if (vofa) vofa.destroy(); } catch (e) { /* ignore */ }
    try { if (ws) ws.close(); } catch (e) { /* ignore */ }
    killTree(chrome); killTree(gw);
    try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  return fail ? 1 : 0;
}
main().then(c => process.exit(c));
