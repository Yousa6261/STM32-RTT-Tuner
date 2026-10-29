// Real-browser E2E for the v3.1 Ch1 wave panel: headless Chrome driven over CDP (Node >= 22 built-in WebSocket).
//   node TESTs/hw/e2e_browser_wave.js --mode mock    [--shots DIR]
//   node TESTs/hw/e2e_browser_wave.js --mode daplink --chip h723 [--speed 1000] [--shots DIR]
// Starts its own gateway on port 8799 (never touches a running 8765 instance), drives real pointer/wheel/key
// input, checks state through window.RTTApp.wave, and saves screenshots of the wave card.
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const MODE = opt('mode', 'mock');
const CHIP = opt('chip', 'h723');
const SPEED = Number(opt('speed', '1000'));
const PORT = Number(opt('port', '8799'));
const CDP_PORT = Number(opt('cdp', '9333'));
const SHOTS = opt('shots', path.join(__dirname, 'shots'));
const ROOT = path.join(__dirname, '..', '..');
// --mode lan: 网关监听 0.0.0.0 (--lan), 浏览器经本机局域网 IP 访问, 验证局域网客户端默认 min/max 抽取订阅
const LAN_IP = (() => {
  for (const l of Object.values(os.networkInterfaces())) for (const a of l || []) {
    if (a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address;
  }
  return null;
})();
const HOST = MODE === 'lan' ? LAN_IP : '127.0.0.1';
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium'
].find(p => fs.existsSync(p));

let pass = 0, fail = 0;
const check = (n, c, i = '') => { if (c) { pass++; console.log('PASS ', n); } else { fail++; console.log('FAIL ', n, typeof i === 'string' ? i : JSON.stringify(i)); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const killTree = p => { if (!p || p.exitCode !== null) return; try { if (process.platform === 'win32') execSync(`taskkill /PID ${p.pid} /T /F`, { stdio: 'ignore' }); else p.kill('SIGKILL'); } catch (e) { /* gone */ } };

async function main() {
  if (!CHROME) { console.log('SKIP: Chrome/Edge not found'); return 0; }
  if (MODE === 'lan' && !LAN_IP) { console.log('SKIP: no private LAN IPv4 address'); return 0; }
  fs.mkdirSync(SHOTS, { recursive: true });
  const gw = spawn(process.platform === 'win32' ? 'python' : 'python3', [path.join(__dirname, 'serve_gateway.py'), '--port', String(PORT)].concat(MODE === 'lan' ? ['--lan'] : []), { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let gwOut = '';
  gw.stdout.on('data', d => { gwOut += d; });
  gw.stderr.on('data', d => { gwOut += d; });
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'rtt-e2e-'));
  let chrome = null, ws = null;
  try {
    for (let k = 0; k < 50 && !/ready/.test(gwOut); k++) await sleep(100);
    if (!/ready/.test(gwOut)) throw new Error('gateway failed: ' + gwOut);
    chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${prof}`, '--no-first-run',
      '--no-default-browser-check', '--window-size=1600,1400', 'about:blank'], { stdio: 'ignore' });
    let target = null;
    for (let k = 0; k < 80 && !target; k++) {
      await sleep(150);
      try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find(t => t.type === 'page'); } catch (e) { /* not up yet */ }
    }
    if (!target) throw new Error('chrome CDP not reachable');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let seq = 0;
    const pending = new Map();
    const events = [];
    const errors = [];
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
      events.push(m);
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value || a.description).join(' '));
    };
    const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
    const ev = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(`eval failed: ${expr}\n${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
      return r.result.value;
    };
    const mouse = (type, x, y, o = {}) => send('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'none', buttons: 0, clickCount: 0, modifiers: 0 }, o));
    const drag = async (x0, y0, x1, y1, modifiers = 0) => {
      await mouse('mouseMoved', x0, y0, { modifiers });
      await mouse('mousePressed', x0, y0, { button: 'left', buttons: 1, clickCount: 1, modifiers });
      for (let k = 1; k <= 8; k++) { await mouse('mouseMoved', x0 + (x1 - x0) * k / 8, y0 + (y1 - y0) * k / 8, { button: 'left', buttons: 1, modifiers }); await sleep(16); }
      await mouse('mouseReleased', x1, y1, { button: 'left', buttons: 0, clickCount: 1, modifiers });
    };
    const click = async (x, y, button = 'left') => {
      await mouse('mouseMoved', x, y);
      await mouse('mousePressed', x, y, { button, buttons: button === 'left' ? 1 : 2, clickCount: 1 });
      await mouse('mouseReleased', x, y, { button, buttons: 0, clickCount: 1 });
    };
    const key = async (k, code) => {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: code || k, windowsVirtualKeyCode: { End: 35, Escape: 27, ' ': 32 }[k] || 0 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: code || k });
    };
    const shot = async name => {
      // 页面顶部连接栏是 sticky 的: 滚动时让卡片停在它下方, 避免截图被遮挡
      await ev(`(()=>{const c=document.getElementById('wave-card');
        const hdr=[...document.querySelectorAll('body *')].find(e=>getComputedStyle(e).position==='sticky');
        const off=hdr?hdr.getBoundingClientRect().height+8:0;
        window.scrollTo(0, c.getBoundingClientRect().top+scrollY-off);})()`);
      await sleep(250);
      const r = await ev(`(()=>{const b=document.getElementById('wave-card').getBoundingClientRect();return {x:b.left+scrollX,y:b.top+scrollY,w:b.width,h:b.height}})()`);
      const img = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 1 } });
      const f = path.join(SHOTS, `${MODE}_${name}.png`);
      fs.writeFileSync(f, Buffer.from(img.data, 'base64'));
      console.log(`   screenshot: ${f}`);
    };
    const stage = async () => ev(`(()=>{const b=document.getElementById('waveOverlay').getBoundingClientRect();return {x:b.left,y:b.top,w:b.width,h:b.height}})()`);
    const S = expr => ev(`(()=>{const w=window.RTTApp.wave.state;return (${expr});})()`);

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1400, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `http://${HOST}:${PORT}/` });
    for (let k = 0; k < 100 && !events.some(e => e.method === 'Page.loadEventFired'); k++) await sleep(50);
    await sleep(800);
    check('page loaded, wave core + controller present', await ev(`!!(window.RTTWaveCore && window.RTTApp && window.RTTApp.wave)`));
    if (MODE === 'lan') {
      check(`LAN client (${HOST}) defaults to binary + min/max decimation`, await S(`w.sub && w.sub.mode === 'decim' && w.sub.lan === true`), await S('w.sub'));
      await ev(`document.getElementById('conn-mode').value='mock'; document.getElementById('conn-mode').dispatchEvent(new Event('change')); document.getElementById('btn-connect').click();`);
      await sleep(2500);
      const ls = await S(`({count:w.store&&w.store.count, fps:w.fps, decim:w.decim})`);
      check('LAN: data flows (500 fps is below the 10 kfps threshold -> not decimated)', ls.count > 800 && ls.decim === 1, ls);
      const pickTransport = v => ev(`(()=>{const s=[...document.querySelectorAll('#wave-settings select')].find(e=>[...e.options].some(o=>o.value==='decim')); s.value='${v}'; s.dispatchEvent(new Event('change'));})()`);
      await ev(`window.RTTApp.wave.openSettings(true)`);
      await pickTransport('full');
      await sleep(400);
      check('LAN: user can switch to full rate in settings', await S(`w.sub && w.sub.mode === 'full' && w.sub.lan === true`), await S('w.sub'));
      await pickTransport('auto');
      await sleep(300);
      check('LAN: back to auto -> decimated again', await S(`w.sub && w.sub.mode === 'decim'`), await S('w.sub'));
      check('LAN: no JS errors', errors.length === 0, errors.slice(0, 3));
      await ev(`window.RTTApp.sendJson({type:'disconnect'})`);
      await sleep(300);
      return finish();
    }
    check('gateway confirmed binary subscription (local -> full rate)', await S(`w.sub && w.sub.mode === 'full' && w.sub.lan === false`), await S('w.sub'));

    // ---------------------------------------------------------- connect
    if (MODE === 'mock') {
      await ev(`document.getElementById('conn-mode').value='mock'; document.getElementById('conn-mode').dispatchEvent(new Event('change')); document.getElementById('btn-connect').click();`);
    } else {
      await ev(`(()=>{const m=document.getElementById('conn-mode'); m.value='${MODE}'; m.dispatchEvent(new Event('change'));
        const c=document.getElementById('chip-preset'); if (c && [...c.options].some(o=>o.value==='${CHIP}')) { c.value='${CHIP}'; c.dispatchEvent(new Event('change')); }
        const s=document.getElementById('openocd-speed'); if (s) { if (![...s.options].some(o=>o.value==='${SPEED}')) { const o=document.createElement('option'); o.value='${SPEED}'; o.textContent='${SPEED}'; s.appendChild(o);} s.value='${SPEED}'; }
        document.getElementById('btn-connect').click();})()`);
    }
    let connected = false;
    for (let k = 0; k < 150 && !connected; k++) { await sleep(100); connected = await ev(`window.RTTApp.isConnected()`); }
    check(`connected (${MODE})`, connected, await ev(`document.getElementById('terminal-output').innerText.slice(-600)`));
    if (!connected) throw new Error('connect failed');
    await sleep(MODE === 'mock' ? 3000 : 5000);

    const st = await S(`({count:w.store&&w.store.count, nch:w.nch, fps:w.fps, rate:w.displayRate, decim:w.decim, frames:w.perf.frames, grid:w.perf.gridDraws, p95:w.perf.p95, ms:w.perf.ms, cap:w.store&&w.store.cap, sub:w.sub&&w.sub.mode})`);
    console.log('   state:', JSON.stringify(st));
    if (MODE === 'mock') check('mock: ~500 fps x 3 ch received as binary, no decimation', st.nch === 3 && st.fps > 350 && st.fps < 650 && st.decim === 1 && st.count > 1000, st);
    else check('hardware: Ch1 JustFloat streaming (100-2000 fps), no decimation', st.nch >= 1 && st.fps > 100 && st.fps < 2000 && st.decim === 1 && st.count > 200, st);
    check('grid layer redrawn rarely (stable axis)', st.grid <= Math.max(6, st.frames * 0.2), st);
    check('render p95 < 8 ms (main thread is sufficient)', st.p95 < 8, st.p95);
    check('capacity planned for 60 s at measured rate', Math.abs(st.cap - Math.ceil(60 * st.rate * 1.15)) / st.cap < 0.25 || st.cap === 1024, st);
    await shot('1_live_overlay');

    // ---------------------------------------------------------- browse: drag / wheel / cursors / tooltip
    let r = await stage();
    const cy = r.y + r.h * 0.45;
    await drag(r.x + r.w * 0.5, cy, r.x + r.w * 0.5 + 160, cy);
    await sleep(150);
    check('drag on chart enters browse mode (history view)', await S(`w.mode === 'browse'`));
    const lagAfterDrag = await S(`w.store.head - w.lastView.i1`);
    check('drag moved the view back in time', lagAfterDrag > 10, lagAfterDrag);
    const span1 = await S(`w.lastView.i1 - w.lastView.i0`);
    await mouse('mouseMoved', r.x + r.w * 0.6, cy);
    await mouse('mouseWheel', r.x + r.w * 0.6, cy, { deltaX: 0, deltaY: -120 });
    await sleep(120);
    await mouse('mouseWheel', r.x + r.w * 0.6, cy, { deltaX: 0, deltaY: -120 });
    await sleep(150);
    const span2 = await S(`w.lastView.i1 - w.lastView.i0`);
    check('wheel zooms in around pointer', span2 < span1 * 0.9, [span1, span2]);
    await click(r.x + r.w * 0.35, cy);
    await click(r.x + r.w * 0.7, cy, 'right');
    await sleep(250);
    const cur = await S(`[w.cursors.a, w.cursors.b]`);
    check('click -> cursor A, right-click -> cursor B', cur[0] !== null && cur[1] !== null && cur[1] > cur[0], cur);
    await mouse('mouseMoved', r.x + r.w * 0.55, cy - 20);
    await sleep(250);
    const tip = await ev(`(()=>{const t=document.getElementById('wave-tip');return {d:getComputedStyle(t).display, txt:t.innerText}})()`);
    check('hover tooltip shows time + values', tip.d === 'block' && /t = /.test(tip.txt), tip);
    const ro = await ev(`document.getElementById('wave-readout').innerText`);
    check('readout shows Δt / 1/Δt', /Δt/.test(ro) && /1\/Δt/.test(ro), ro);
    check('"back to live" pill visible while browsing', await ev(`!document.getElementById('btn-wave-live').classList.contains('hidden')`));
    await shot('2_browse_cursors_tooltip');

    // send A-B range to analysis panel
    await ev(`document.getElementById('btn-wave-analyze').click()`);
    await sleep(400);
    const capInfo = await ev(`(()=>{const c=window.RTTCapturePanel.state.current;return c?{fmt:c.fmt_name,total:c.total,hz:c.sample_hz}:null})()`);
    check('A-B range sent to analysis panel', capInfo && capInfo.fmt === 'ch1_f32' && capInfo.total === cur[1] - cur[0] + 1, [capInfo, cur]);

    // ctrl+drag box zoom, then undo
    r = await stage();
    const spanB = await S(`w.lastView.i1 - w.lastView.i0`);
    await drag(r.x + r.w * 0.3, cy, r.x + r.w * 0.5, cy, 2 /* Ctrl */);
    await sleep(150);
    const spanC = await S(`w.lastView.i1 - w.lastView.i0`);
    check('Ctrl+drag box zoom', spanC < spanB * 0.5, [spanB, spanC]);
    await ev(`window.RTTApp.wave.undo()`);
    await sleep(100);
    check('undo restores', Math.abs(await S(`w.lastView.i1 - w.lastView.i0`) - spanB) < 1e-6 * spanB + 1e-6);

    // keyboard: End -> live (pointer is over the chart)
    await mouse('mouseMoved', r.x + r.w * 0.5, cy);
    await key('Escape');
    await key('End');
    await sleep(200);
    check('Esc clears cursors, End returns to live', await S(`w.mode === 'live' && w.cursors.a === null`));

    // ---------------------------------------------------------- layouts & settings
    await ev(`(()=>{const s=document.getElementById('wave-layout'); s.value='split'; s.dispatchEvent(new Event('change'));})()`);
    await sleep(600);
    const nPlots = await S(`w.plots.length`);
    check('split layout: one subplot per channel', nPlots === await S('w.nch'), nPlots);
    await shot('3_split');
    await ev(`(()=>{const s=document.getElementById('wave-layout'); s.value='overlay'; s.dispatchEvent(new Event('change'));})()`);
    await ev(`document.getElementById('btn-wave-settings').click()`);
    await sleep(400);
    const panel = await ev(`document.getElementById('wave-settings').innerText`);
    check('settings panel open with sections', /显示与历史/.test(panel) && /采样与传输/.test(panel) && /内存/.test(panel), panel.slice(0, 200));
    await shot('4_settings');

    if (MODE !== 'mock') {
      // wave_div round trip on real firmware: halve the frame rate, verify time axis, then restore
      const detected = !/固件未注册/.test(panel);
      check('firmware wave_div parameter detected', detected, panel.slice(0, 300));
      if (detected) {
        const div0 = Number(await ev(`(()=>{const i=[...document.querySelectorAll('#wave-settings input')].find(e=>e.title.includes('wave_div'));return i?i.value:'2'})()`)) || 2;
        const fps0 = await S('w.fps');
        await ev(`window.RTTApp.sendRtt('$SET:wave_div=${div0 * 2}')`);
        await sleep(5000);
        const fps1 = await S('w.fps');
        const seg = await S(`w.axis.segs.length`);
        check(`wave_div ${div0} -> ${div0 * 2}: frame rate halves and time axis adds a segment`, fps1 < fps0 * 0.65 && fps1 > fps0 * 0.35 && seg >= 2, [fps0, fps1, seg]);
        const win = await S(`w.axis.timeOf(w.lastView.i1) - w.axis.timeOf(w.lastView.i0)`);
        check('time window stays 2 s after rate change', Math.abs(win - 2) < 0.15, win);
        await ev(`window.RTTApp.sendRtt('$SET:wave_div=${div0}')`);
        await sleep(4000);
        const fps2 = await S('w.fps');
        check(`wave_div restored to ${div0}`, Math.abs(fps2 - fps0) / fps0 < 0.2, [fps0, fps2]);
      }
    }
    await ev(`document.getElementById('btn-wave-settings').click()`);

    // ---------------------------------------------------------- ACK markers
    await ev(`window.RTTApp.sendRtt('$SET:pid_kp=1.5')`);
    await sleep(500);
    await ev(`window.RTTApp.sendRtt('$SET:pid_kp=3.25')`);
    await sleep(800);
    const mk = await S(`w.markers.map(m=>m.text)`);
    check('parameter change marker drawn on time axis', mk.some(t => /pid_kp: .*→3\.25/.test(t)), mk);
    await shot('5_marker');
    await ev(`window.RTTApp.sendRtt('$SET:pid_kp=1.5')`);
    await sleep(300);

    // ---------------------------------------------------------- clear + full-width + perf summary
    await ev(`document.getElementById('btn-wave-clear').click()`);
    await sleep(50);
    const afterClear = await S(`w.store.count`);
    check('clear empties history (new data keeps flowing)', afterClear < 200, afterClear);
    await ev(`document.getElementById('btn-wave-wide').click()`);
    await sleep(1500);
    check('full-width mode spans both columns', await ev(`document.getElementById('wave-card').classList.contains('wave-wide') && document.getElementById('wave-card').getBoundingClientRect().width > 1200`));
    await shot('6_wide');
    await ev(`document.getElementById('btn-wave-wide').click()`);
    const perf = await S(`({p95:w.perf.p95, frames:w.perf.frames, grid:w.perf.gridDraws, verts:w.perf.vertices})`);
    console.log('   perf:', JSON.stringify(perf));
    check('no JS exceptions / console errors in page', errors.length === 0, errors.slice(0, 5));

    await ev(`window.RTTApp.sendJson({type:'disconnect'})`);
    await sleep(MODE === 'mock' ? 300 : 2500);
    return finish();
  } finally {
    try { if (ws) ws.close(); } catch (e) { /* ignore */ }
    killTree(chrome);
    killTree(gw);
    await sleep(500);
    try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) { /* chrome may still hold files briefly */ }
  }
}

function finish() {
  console.log(`\n${pass} passed, ${fail} failed`);
  return fail ? 1 : 0;
}

main().then(code => process.exit(code)).catch(e => { console.log('FAIL  e2e aborted:', e.message); process.exit(1); });
