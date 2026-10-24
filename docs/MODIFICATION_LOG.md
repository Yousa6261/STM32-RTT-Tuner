# 代码修改记录 (Modification Log)

> 本文件记录本项目的**每一次代码修改**。每条记录包含：编号、日期、严重级别、问题位置、
> 问题描述、修复方案与验证结果。新增修改请按批次追加在文件末尾。

**代码库位置：**

| 代码库 | 路径 |
| :--- | :--- |
| 单片机固件工程 (Keil MDK) | `F:\qwe\NEW_Project\DM_H7` |
| 上位机网关与工具链 (Python / Web) | `C:\Users\12165\.gemini\antigravity\scratch\stm32-rtt-param-tuner` |

**严重级别图例：** 🔴 高危（安全/稳定性） · 🟡 中危（功能/健壮性） · 🟢 低危（清理/优化）

**状态图例：** ✅ 已完成并验证 · 🔧 已修改待验证 · ⏳ 计划中

---

## 2026-09-12 · 第 1 批：紧急安全与稳定性修复

> 依据当日深度代码审查报告，优先修复全部 3 项高危问题 (H1 / H3 / H4)，共 9 个补丁，
> 由原子化补丁脚本一次性应用（每处修改均含精确匹配与回读校验）。

### FIX-001 ✅ 🔴 [H1] SEGGER_RTT_printf 栈越界读取

- **文件**：
  - `F:\qwe\NEW_Project\DM_H7\mcu_firmware_template\SEGGER_RTT\SEGGER_RTT_printf.c`
  - `C:\Users\12165\.gemini\antigravity\scratch\stm32-rtt-param-tuner\mcu_firmware_template\SEGGER_RTT\SEGGER_RTT_printf.c`（两份副本同步修改，修改后哈希一致）
- **问题**：`vsnprintf` 在输出被截断时返回**期望写入的完整长度**（C99 语义），可能大于 64 字节栈缓冲 `acBuffer` 的实际大小。原代码直接把该返回值传给 `SEGGER_RTT_Write` 作读取长度 → 越界读取栈内存，垃圾字节混入 RTT 协议流。
- **触发场景**：`$ACK:ERR:OUT_OF_RANGE:target_speed=-7000.00[-6000.00..6000.00]` 等长度 ≥ 64 字符的报文（边界参数调参时必然出现）。
- **修复**：写入长度钳位至 `sizeof(acBuffer) - 1`：

```c
if (r > 0) {
    if ((size_t)r > (sizeof(acBuffer) - 1u)) {
        r = (int)(sizeof(acBuffer) - 1u);
    }
    SEGGER_RTT_Write(BufferIndex, acBuffer, (unsigned)r);
}
```

- **验证**：Keil 重编译 `0 Error(s), 0 Warning(s)`（`MDK-ARM\fix_verify_build.log`，SEGGER_RTT_printf.c 重新编译并链接）。

---

### FIX-002 ✅ 🔴 [H3a] Web 静态服务路径穿越任意文件读取

- **文件**：`server/rtt_bridge.py` → `AppServer.serve_static_file()`
- **问题**：请求路径未做目录限制。`GET /../server/rtt_bridge.py` 可读取 web/ 目录之外任意文件（逐级 `../` 可达盘根），配合 `Access-Control-Allow-Origin: *` 构成完整漏洞链。
- **修复**：`Path.resolve()` 后校验必须仍位于 `WEB_DIR` 内，越界一律返回 404：

```python
try:
    target_path = target_path.resolve()
    if not target_path.is_relative_to(WEB_DIR.resolve()):
        target_path = None
except (OSError, ValueError):
    target_path = None
```

- **验证**：专项测试 3 种穿越变体（`/../server/rtt_bridge.py`、`/../../Windows/win.ini`、反斜杠变体）全部返回 404 且无源码泄露；`/` 与 `/style.css` 正常返回 200。

---

### FIX-003 ✅ 🔴 [H3b] 网关默认绑定 0.0.0.0 → 127.0.0.1

- **文件**：`server/rtt_bridge.py` → `main()`
- **问题**：Web 网关 (8765) 与 VOFA+ 中继 (1347) 均监听 `0.0.0.0`，局域网内任意主机可访问调参控制台、并可经 1347 直接向单片机**下发电机控制指令**（物理世界影响）。
- **修复**：默认改为仅监听 `127.0.0.1`，代码内注释说明如需手机/局域网调参如何显式改回。
- **验证**：self_test 通过（本机访问不受影响）。

---

### FIX-004 ✅ 🔴 [H4a] rtt_bridge 非阻塞 socket 误用 sendall 导致误判断线

- **文件**：`server/rtt_bridge.py` → `RTTManager.send_rtt()`
- **问题**：telnet/stlink/daplink 模式的 socket 已 `setblocking(False)`，发送缓冲区一满 `sendall` 即抛 `BlockingIOError`，被 except 捕获后**误判为断线并主动拆除整条 RTT 链路**（OpenOCD 短暂卡顿即可触发）。
- **修复**：改用事件循环的 `await loop.sock_sendall()` 异步等待可写。
- **验证**：专项测试 telnet 模式发送 `$PING` 成功送达对端。

---

### FIX-005 ✅ 🔴 [H4b] broadcast 迭代 WS 客户端集合未用快照

- **文件**：`server/rtt_bridge.py` → `AppServer.broadcast()`
- **问题**：`for ws in self.clients:` 迭代期间含 `await` 挂起点，此时新开浏览器标签页触发 `clients.add()` → `Set changed size during iteration` → 接收循环异常退出断连。VOFA 分支原本就用了 `list()` 快照，WS 分支遗漏。
- **修复**：改为 `for ws in list(self.clients):`。
- **验证**：self_test 全流程通过。

---

### FIX-006 ✅ 🔴 [H4c] rtt_vofa_bridge 非阻塞 socket 误用 sendall

- **文件**：`server/rtt_vofa_bridge.py` → `RttVofaBridge.send_to_rtt()`
- **问题**：同 FIX-004，VOFA+ 专用网关下发调参指令时同样会因 `BlockingIOError` 误报链路异常。
- **修复**：同 FIX-004，改用 `sock_sendall`。
- **验证**：语法检查通过；与 FIX-004 同代码路径逻辑。

---

### FIX-007 ✅ 🔴 [H3c/H3d] rtt_vofa_bridge VOFA 监听默认 0.0.0.0 → 127.0.0.1

- **文件**：`server/rtt_vofa_bridge.py` → `RttVofaBridge.__init__()` 默认值与 `parse_args()` CLI 默认值
- **问题**：同 FIX-003，1347 端口对局域网暴露电机指令下发能力。
- **修复**：默认 `127.0.0.1`，保留 `--vofa-host 0.0.0.0` 显式开启局域网访问的入口。

---

### 本批验证汇总

| 验证项 | 结果 |
| :--- | :--- |
| Python 语法检查 (ast.parse 两个网关文件) | ✅ 通过 |
| 既有自动化测试 `self_test.py` (HTTP + Mock ACK + PONG) | ✅ PASS |
| 专项: 路径穿越 3 变体拦截 + 正常文件 200 | ✅ PASS |
| 专项: telnet 模式 sock_sendall 发送送达 | ✅ PASS |
| 固件两份模板副本哈希一致性 | ✅ 一致 |
| Keil 重编译 (ARMCLANG V6.14.1) | ✅ 0 Error / 0 Warning |

---

## 2026-09-12 · 第 2 批：ST-Link 启动链路修复（真机：正点原子 F103 + ST-Link）

> **背景**：用户以 ST-Link 连接调试，排障确认实际接的是**正点原子 STM32F103 板**
> （DBGMCU_IDCODE 0xE0042000 = 0x10036414，DEV_ID 0x414，Cortex-M3），而非 H723。
> 原配置按 CMSIS-DAP + H723 编写导致多重失配；详见
> `TROUBLESHOOTING_AND_SOLUTION_GUIDE.md`。本批在文档方案基础上，实测发现并修复了
> **新 STLink 脚本的嵌套引号 Bug**（文档宣称已修复的转义问题在 bat 层复现）与
> **Python 网关 stlink 模式的两处缺陷**。

### FIX-008 ✅ 🔴 [B1] 一键启动 STLink 脚本嵌套转义引号导致 OpenOCD 退出

- **文件**（重写 4 份 + 新建 2 份）：
  - 新建 `run_openocd_stlink_h7.bat` / `run_openocd_stlink_f103.bat`（平铺式 OpenOCD 命令，真机验证后原样固化）
  - 重写 `一键启动_STLink_H7.bat` / `一键启动_STLink_F103.bat`（scratch 与固件目录各一份）
- **问题**：原脚本用 `start "title" cmd /c "openocd ... -c \"adapter speed 4000\" ..."` 嵌套转义引号。cmd.exe 不识别 `\"` 转义，`adapter speed 4000` 被拆散，OpenOCD 报 `Unexpected command line argument: speed` 直接退出（真机实测复现）。
- **修复**：改用已验证的 `start "title" cmd /c "call run_openocd_stlink_XXX.bat"` 模式（与既有 `一键启动全套.bat`→`run_openocd.bat` 调用链同构），OpenOCD 命令行放平铺 bat 内以普通引号书写。
- **验证**：平铺命令在真机（ST-Link + F103 + xpack-openocd 0.12.0）实测：`adapter speed: 4000 kHz` 正常接受、`stm32f1x.cpu Cortex-M3` 正确识别、64KB 扫描完成无 Bus Fault。

### FIX-009 ✅ 🔴 [B3] run_openocd.bat 写死 cmsis-dap → USB 自适应探测

- **文件**：`run_openocd.bat`（scratch，重写）
- **问题**：原脚本固定 `interface/cmsis-dap.cfg`，插 ST-Link 时报 `unable to find a matching CMSIS-DAP device` 退出（本次故障的入口）；排障文档宣称"一键启动全套.bat 自适应"但实际未实现。
- **修复**：bat 内嵌 PowerShell 探测 USB 设备——ST-Link（VID 0483）优先、CMSIS-DAP（VID 0D28）回退、均无则明确报错暂停；两种接口分别给出完整 OpenOCD 命令（均含 `transport select swd`）。
- **验证**：探测命令 exit code 实测（ST-Link 在位 → 0）；`一键启动全套.bat` → `run_openocd.bat` 调用链启动 OpenOCD 正常。
- **注意**：该脚本目标仍为 H7 主工程（stm32h7x + 0x24000000）；F103 板请用 `一键启动_STLink_F103.bat`。

### FIX-010 ✅ 🔴 [B2a] rtt_bridge.py stlink 模式缺 transport select swd

- **文件**：`server/rtt_bridge.py` → `RTTManager.connect()`
- **问题**：仅 daplink 模式追加 `transport select swd`；stlink 模式下 `stlink.cfg` 不显式选择传输时默认 **JTAG**，SWD 接线必然连接失败。
- **修复**：stlink 与 daplink 两种模式统一显式声明 `transport select swd`。

### FIX-011 ✅ 🔴 [B2b] RTT 扫描范围硬编码 0x40000 → 按芯片系列自适应

- **文件**：`server/rtt_bridge.py` → 新增 `RTTManager._rtt_scan_size()`
- **问题**：`rtt setup {ram} 0x40000` 扫描范围写死 256KB。F103 SRAM 仅 64KB，扫描越过 `0x20010000` 边界触发 Bus Fault（`Failed to read memory at 0x20010004`）。
- **修复**：按 `openocd_target` 映射安全扫描范围：`f1x→0x10000`（64KB）、`f4x/f2x→0x20000`（128KB）、`g4x→0x18000`（96KB）、其余（H7 AXI SRAM）→`0x40000`。与 Web UI 芯片预设下拉联动生效。
- **验证**：端到端真机测试（stlink 模式 + stm32f1x + 0x20000000）：OpenOCD 完整运行，无参数错误、无越界 Bus Fault，以预期 `No control block found` 收尾（板上为出厂固件，烧录 RTT 固件后即可调参）。

### FIX-012 ✅ 🔴 [B2 镜像] rtt_vofa_bridge.py 同步修复 transport + 扫描范围

- **文件**：`server/rtt_vofa_bridge.py` → 新增 `RttVofaBridge._rtt_scan_size()` + stlink 分支补 `transport select swd`
- **说明**：与 FIX-010/011 完全同构的镜像缺陷，一并修复保持两网关行为一致。

### 本批验证汇总

| 验证项 | 结果 |
| :--- | :--- |
| Python 语法检查 (两个网关) + self_test.py 回归 | ✅ PASS |
| 平铺 OpenOCD 命令真机实测 (F103: 参数解析/目标识别/无 Bus Fault) | ✅ PASS |
| 自适应探测 exit code (ST-Link VID_0483 在位 → 0) | ✅ PASS |
| rtt_bridge stlink 模式端到端 (干净退出无 Unexpected/无越界) | ✅ PASS |
| 4 份 bat 重写 + 2 份新建内容回读校验 (ASCII + CRLF) | ✅ PASS |

### 排障过程的关键技术事实（供后续参考）

- ST-Link V2J35S7 (API v2) + xpack-openocd 0.12.0：`stlink.cfg` 为新版 dapdirect 驱动，须显式 `transport select swd`；
- H723 与 F103 的 SWD DPIDR 分别为 `0x6ba02477` / `0x1ba01477`，可作为快速识别所连芯片的依据；
- RTT 控制块位于 RAM 起始附近（H7 为 `0x2400000c`），扫描上限过大仅在"无控制块"完整扫描时才会触发越界；
- OpenOCD 在无 RTT 控制块时以 `No control block found` 结束 rtt server 启动——这是"固件未含 RTT"的标志性现象（排障文档原因 1）。

---

## 2026-09-12 · 第 3 批：双 OpenOCD 实例抢占调试器根治（真机：DAP-Link + STM32H723）

> **现象**：一键启动后 OpenOCD 日志无限刷 `Error connecting DP: cannot read IDR` /
> `Polling failed, trying to reexamine`。
> **诊断**：单实例实测 32 秒完全稳定（控制块命中 0x2400000c、DPIDR 0x6ba02477、零错误），
> 排除硬件/线材/配置问题。日志时序（`Examination succeed` → `accepting 'rtt' connection
> on tcp/19021` → 随即 DP 失联）指向根因：**网页默认 DAP-Link 模式点【连接目标】时，
> `rtt_bridge.py` 又拉起第二个 OpenOCD 实例，与一键启动已拉起的实例争抢同一 DAP-Link
> 的 USB 句柄**，导致先启动实例的 SWD 总线被打断。即深度审查报告"工程化问题 2：启动
> 流程自相矛盾"的实际爆发。

### FIX-013 ✅ 🔴 [C1] rtt_bridge.py 防双开：检测到 19021 已监听则自动复用

- **文件**：`server/rtt_bridge.py` → `RTTManager.connect()` 的 stlink/daplink 分支
- **修复**：自启 OpenOCD 前先探测 `127.0.0.1:19021`：已监听 → 不再启动第二实例，直接以
  socket 复用现有服务（数据通路与 telnet 模式同构，`send_rtt`/`_telnet_rx_loop` 天然兼容，
  VOFA 1347 中继条件同样满足）；未监听 → 走正常自启流程。
- **效果**：无论用户先跑一键启动再连网页、还是直接网页连接，均不会出现双实例。
- **验证**：真机端到端（外部 OpenOCD #1 + `connect(mode="daplink")`）——返回复用消息、
  openocd 进程数恒为 1。

### FIX-014 ✅ 🔴 [C1 镜像] rtt_vofa_bridge.py 防双开

- **文件**：`server/rtt_vofa_bridge.py` → `start_rtt_connection()` 的 daplink/stlink 分支
- **修复**：同构逻辑——自启前探测 `rtt_host:rtt_port`，已监听则打印复用提示并直接
  `_connect_rtt_socket()` 复用。

### FIX-015 ✅ 🟡 [C2] OpenOCD 占用类失败的排查提示增强

- **文件**：`server/rtt_bridge.py` → OpenOCD 启动退出的错误消息
- **修复**：错误输出含 `unable to find` / `open failed` 时，追加可操作提示
  （关闭 Keil 调试会话/其他 OpenOCD 窗口、拔插调试器后重试），替代裸错误码。

### 本批验证汇总（真机：DAP-Link + STM32H723 + 板载 RTT 固件）

| 验证项 | 结果 |
| :--- | :--- |
| 单实例 OpenOCD 32 秒稳定性（控制块命中 0x2400000c） | ✅ PASS |
| Python 语法 + self_test.py 回归 | ✅ PASS |
| 端到端: 外部 OpenOCD + 网关 daplink 模式 → 复用不双开（进程数=1） | ✅ PASS |
| 端到端: `$GET:ALL` 真机参数同步（6 项: pid_kp/ki/kd, target_speed, sin, motor_en） | ✅ PASS |
| 端到端: `$SET:pid_kp=2.0` 双向 ACK（时延 78.4ms） | ✅ PASS |
| 全程无 `cannot read IDR` / `Polling failed` | ✅ PASS |

> **里程碑**：本批验证为项目首次在 STM32H723 真机上完整打通 Web 调参全链路
> （网页 → 网关 → 19021 → OpenOCD → DAP-Link → SWD → RTT Ch0 → rtt_param_parser）。

### 使用注意事项（新）

1. **Keil 与 OpenOCD 不能同时占用调试器**：UV4 处于调试会话/烧录时会独占 DAP-Link，
   此时一键启动的 OpenOCD 会报 `unable to find a matching CMSIS-DAP device` 或
   `open failed`。请退出 Keil 调试后再启动 RTT 工具链（FIX-015 已内置此提示）。
2. 一键启动脚本每次双击都会新开一个 OpenOCD 窗口——**请确保上一个 OpenOCD 窗口已
   关闭再重新双击**，否则端口/调试器冲突。
3. H723 当前固件中 `sin` 参数注册范围 0.0~6.28 与实际值域 -1..1 不符（待办 F4），
   网页滑条同步时显示会错位，不影响其他参数。

---

## 2026-09-13 · 第 4 批：通用实时遥测数据监视看板 (Live Telemetry Dashboard)

> 更正 (2026-10-07)：本批原标题为"第五批"，与前一批"第 3 批"不连续，已改为"第 4 批"。
> 原记录中"数据更新微脉冲视觉反馈"已在后续修改中移除；原"验证"一栏只覆盖 Python 侧，
> 前端从未在浏览器中验证，表述有夸大，已在 FIX-017 中更正。

### FIX-016 🔧 🟢 [Feature] Web 端自适应实时数据看板（初版，存在缺陷，见 FIX-017）
- **文件**：`web/index.html`、`web/style.css`、`web/app.js`、`server/rtt_bridge.py`
- **内容**：解析 RTT Ch0 的 `$DATA:k=v,...` 帧，按键名动态创建看板磁贴；按键名推断单位与配色；
  显示与上一次的差值；1 秒窗口统计接收帧率；提供"重置看板"。
- **验证（原始记录，已更正）**：仅完成 Mock 帧生成与 `self_test.py` 回归；前端未做任何运行验证。

### FIX-017 ✅ 🟡 [Review] 看板初版代码审查与修复 (2026-10-07)

| # | 级别 | 问题 (根因) | 修复 |
| :-- | :-- | :-- | :-- |
| R1 | 🔴 | 波形通道别名逐个赋值：同一帧同时含 `actual` 与 `v_out` 时，`actual` 被 `v_out` 覆盖 (Mock 帧正好如此，波形实际值显示约 12 而非转速) | 按别名优先级锁定首个出现的源键；重置看板时解锁 |
| R2 | 🔴 | Mock 单帧约 95 字节，超过固件 `SEGGER_RTT_PRINTF_BUFFER_SIZE`=64 的上限；真机发不出这样的帧 (会被截断且丢失行尾 `\n`) | Mock 拆为 100Hz 运动帧 + 10Hz 状态帧，最坏长度 60 字节；增加 `MAX_FRAME_LEN=63` 约束说明 |
| R3 | 🟡 | 设备上报的键/值经 `innerHTML` 拼接写入 DOM，存在 HTML 注入 | 全部改为 `textContent`；键名须符合 C 标识符规则，否则丢弃 |
| R4 | 🟡 | 单位推断误判：`i_c`(C 相电流)→℃、`v_a`→A、`t_ms`→℃、`pin_state`→W、`icon`→A；速度/位置默认标 RPM/°，与达妙电机反馈的 rad/s、rad 不符 | 改为词元匹配；去掉单字母后缀规则；速度/位置仅在显式后缀 (`_rpm`/`_rads`/`_deg`/`_rad`) 时标单位 |
| R5 | 🟡 | 波形纵轴固定默认量程 -100..2000，跨度 ≤10 时不自适应，12V 级信号显示为直线 | 按数据跨度比例留白 |
| R6 | 🟡 | `--accent-pink`、`--accent-blue-bright` 未定义 (后者原有 `.vofa-badge` 亦受影响)，颜色静默失效 | 在 `:root` 中补充定义 |
| R7 | 🟡 | `tile-active` 一旦添加永不移除，不传达任何信息；断线后旧值与实时值无法区分 | 改为 2s 未刷新即标记 `tile-stale` (半透明 + 虚线框) |
| R8 | 🟢 | 每帧直接写 DOM (Mock 100Hz)；差值按固定阈值和 3 位小数显示，产生虚假精度 | 看板渲染节流至 ≤10Hz (波形仍逐帧采样)；差值按上报的小数位数显示 |
| R9 | 🟢 | 断线期间帧率计数窗口不复位，重连后首个读数偏低；磁贴数量无上限 | 断线时复位窗口；磁贴上限 32 个 |
| R10 | 🟢 | `--accent-green` (#238636) 为按钮底色，用作文字对比度不足 | 看板文字改用 `--accent-green-bright` |

- **验证**：
  - `node --check web/app.js` 通过；
  - Node 行为测试 (直接抽取 app.js 中的看板代码 + 桩 DOM) 27 项全部通过：别名覆盖、源键锁定、18 个单位用例、注入拦截、差值精度、数量上限、重置；
  - Mock 帧在参数极值组合下最坏长度 60 字节 (≤63)；
  - `self_test.py` 回归通过。
  - **未验证**：浏览器实际渲染与样式效果；真机 `$DATA` 上报 (当前 H723 固件主循环中没有 `$DATA` 输出，看板在真机上会保持空白)。
- **备份**：修改前的 `web/app.js` 保存为 `web/app.js.bak_pre_review`。

### 固件端上报约束（审查中确认的事实）

1. 本工程 `SEGGER_RTT_printf` 是 `vsnprintf` 封装，Keil 未启用 MicroLIB (`useUlib=0`)，因此支持 `%f`。
   **官方 SEGGER 原版 `SEGGER_RTT_printf` 不支持 `%f`**（仅 `%c %d %u %x %s %p`），其他工程
   (如 `2026_0912_A_Broad` 使用的原版) 需改用 `snprintf` + `SEGGER_RTT_Write`。
2. ~~单行格式化上限 63 字节，超长会被截断且丢失 `\n`~~ → FIX-018 后：上限 95 字节 (`SEGGER_RTT_PRINTF_BUFFER_SIZE`=96)，
   超长**整条丢弃**返回 -1，不再发出半行。
3. Ch0 上行缓冲 1024 字节，模式 `NO_BLOCK_SKIP`：空间不足时整条消息被丢弃。**更正：此条仅在 FIX-018 之后成立**，
   原模板 `SEGGER_RTT_Write` 忽略模式，会写入前半段（见 FIX-018 T1）。
   受影响的是与遥测共用通道的 `$ACK` 应答。OpenOCD 按轮询周期读取 RTT（默认值请以 `rtt polling_interval`
   命令在本机版本上确认），因此每个轮询周期内 `$DATA` + `$ACK` 的总字节数必须小于 1024；`$GET:ALL` 会一次性
   产生约 7×55≈385 字节的突发应答。
4. `$DATA` 建议只在主循环中发送。FIX-018 后 RTT 已有 PRIMASK 锁，中断内调用不会再造成指针竞态；
   但 vsnprintf 格式化浮点耗时较长，且 C 库在中断中的可重入性未验证，故仍不建议放进中断。

---

## 2026-10-07 · 第 5 批：RTT 固件模板缺陷修复 + 网关健壮性 + G474/F334 适配

> 触发：审查 FIX-017 时复核固件模板源码，发现文档中"`NO_BLOCK_SKIP` 整条丢弃、不会撕裂"的说法
> **对原模板不成立**（见 T1）。本批同时完成待办 H2/F6，并为 STM32G474RB / STM32F334C8 准备移植条件。
> 修改前的固件模板备份：`F:\qwe\NEW_Project\DM_H7\_backup_2026-10-07_pre_FIX018\mcu_firmware_template\`。
> **DM_H7 工程直接引用该模板目录，需重新编译并烧录后修复才在真机生效。**

### FIX-018 ✅ 🔴 [T1/H2/F5/F6 + C4/C5] 固件模板与网关修复

**A. 固件模板 (`mcu_firmware_template/`)**

| # | 级别 | 问题 (根因) | 修复 |
| :-- | :-- | :-- | :-- |
| T1 | 🔴 | `SEGGER_RTT_Write` 忽略通道 Flags，空间不足时一律写入能放下的前半段（等同 TRIM）。宿主机复现：剩余 30 字节时写 40 字节消息，实际写入 30 字节，残帧无 `\n`，与下一行粘连 | 按模式处理：SKIP 全写或全不写；TRIM 部分写；BLOCK 在本实现中按 SKIP 处理（不在中断里死等） |
| H2 | 🔴 | `SEGGER_RTT_LOCK/UNLOCK` 为空宏，且原 `Write` 内部根本没有调用锁，单补宏也无效 | Conf.h 实现 PRIMASK 保存/关中断/恢复（AC5 / AC6+GCC / IAR 三套，未知编译器 `#error`）；Write/Read/Config* 内加锁，写指针更新前加 `DMB` |
| F6 | 🟡 | `.h` 声明了 `HasKey/GetKey/WaitKey/ConfigDownBuffer` 但无实现：用原模板跑宿主机测试直接链接失败 | 补齐 4 个函数 |
| F5 | 🟢 | `ConfigUpBuffer(0, …)` 静默无效却返回 0 | 允许索引 0、校验参数，失败返回负值；`SEGGER_RTT_Init` 为静态初始化后的空操作，无害，保持不变 |
| P1 | 🟡 | `SEGGER_RTT_printf` 格式化超长时发出截断前半段（丢 `\n`、数值错误） | 超长整条丢弃并返回 -1；缓冲 64→96 字节 |
| P2 | 🟢 | 尺寸宏写死，F334 (12KB SRAM) 无法在工程侧调小 | `BUFFER_SIZE_UP/DOWN`、`SEGGER_RTT_PRINTF_BUFFER_SIZE`、`RTT_WAVEFORM_DEFAULT_BUF_SIZE/CHANNEL` 均改为 `#ifndef`，可用全局宏覆盖 |
| N1 | 新增 | 用户需手写 `$DATA:` 前缀、自行控制长度 | 新增 `rtt_telemetry.h/.c`：`RTT_Telemetry_Printf("k=%.2f,...")` 自动加前缀与 `\n`；超长整行丢弃(-1)；缓冲满丢弃(0)并计数 `RTT_Telemetry_GetDropCount()`；`RTT_TELEMETRY_CHANNEL` 预留独立通道 |

**B. 网关 / 前端**

| # | 级别 | 问题 | 修复 |
| :-- | :-- | :-- | :-- |
| C4 | 🟡 | 每条 `$DATA` 同时广播 `rtt_rx` 与 `telemetry`，100Hz 下 WebSocket 流量翻倍 | `$DATA` 只广播 `telemetry`；前端 `telemetry` 分支在"过滤"未勾选时写终端；VOFA+ 转发改为监听 `telemetry` |
| C5 | 🟡 | 行内粘连（旧固件残帧 / 从流中间开始读）时，残帧被当作完整遥测解析，显示错误数值 | 行中出现 `$ACK:`/`$DATA:` 帧头即切分，前段标记为残帧（终端红色显示"残帧已丢弃"），不进入看板、不转发 VOFA+ |
| C6 | 🟡 | `$ACK:PARAM` 字段 `int()/float()` 解析异常冒泡至接收循环，单条坏帧即断开整个连接 | 捕获 `ValueError/IndexError`，广播错误提示后继续 |
| C7 | 🟡 | `_rtt_scan_size()` 无 F3 分支，F334 落入 0x40000（H7 默认值） | 新增 `f3 → 0x3000`（F334x8 SRAM 12KB）。两个网关脚本同步 |
| C8 | 🟢 | 芯片预设无 F334；G474 预设为 RE，与实际 RB 不符 | 新增 `f334` 预设；G474 改为 `STM32G474RB` |
| C9 | 新增 | 无 G4/F3 启动脚本 | 新增 `run_openocd_g474.bat` (0x18000)、`run_openocd_f334.bat` (0x3000)，自动识别 ST-Link/CMSIS-DAP，纯 ASCII + CRLF |

> 关于扫描范围的更正：此前文档称"扫描范围越界会触发 Bus Fault"。查 OpenOCD `src/target/rtt.c`
> (`target_rtt_find_control_block`)：按 1KB 分块读取，**找到即返回**。因此范围偏大只在"找不到控制块"
> （固件未运行、未集成 RTT）时才会读到 SRAM 之外并报读错误；范围偏小则会让控制块位于范围外的正常固件连不上。
> 据此本批只对型号确定的 F334x8 收紧，F1 等其余系列保持原值（用户同时有 F103C8/RC/ZE）。

- **验证**：
  - 宿主机 (mingw gcc) 单元测试 29/29 通过，含 20000 次随机写入"不出现半条消息"性质测试；
    同一测试套在**原模板**上：链接失败（F6），补桩后出现 `partial write 30/40`（T1 复现）。
  - 交叉编译 5 个源文件 × {GCC M4, GCC M7, AC6 M4, AC6 M7, AC5 M4}：0 错误 0 警告；
    反汇编确认 `mrs/msr PRIMASK`、`cpsid i`、`dmb` 存在。
  - DM_H7 工程在临时副本中 Keil 全量编译：0 Error 0 Warning（Code=27420, ZI=8524）。用户构建输出未改动。
  - 网关回归 23 项通过（扫描范围、切分、去重、残帧、坏帧不断线、VOFA+ 转发）；`self_test.py` 通过；
    `node --check web/app.js` 通过；看板 Node 测试全部通过；OpenOCD 0.12 离线解析 `stm32f3x.cfg`/`stm32g4x.cfg` 通过。
  - **未验证**：任何真机运行（H723 重新烧录后、G474、F334）；浏览器实际显示。

### FIX-017 中错误表述的更正

- FIX-017 及"固件端上报约束"第 3 条称"空间不足时整条消息被丢弃（不会撕裂）"——**对原模板错误**，
  原 `SEGGER_RTT_Write` 不区分模式，实际行为是写入前半段。FIX-018 之后该表述才成立。
- 第 4 条"RTT 锁为空实现"在 FIX-018 后已不成立；但 `$DATA` 仍建议只在主循环发送（原因改为 vsnprintf 浮点格式化耗时）。

---

## 2026-10-23 · 第 6 批：无线 DAPLink (WCH CMSIS-DAP) 适配

### FIX-019 ✅ 🟡 [W1-W3] 无线 DAPLink 识别与 SWD 时钟

**被测设备**：USB 描述 `WCH-Link` / `WCH CMSIS-DAP`，VID:PID = `1A86:8012`，接口 0 驱动 WinUSB（CMSIS-DAP v2，固件 2.0.0），
接口 1 为 CDC 串口 (COM15)。目标：DM_H7 板 (SWD DPIDR 0x6BA02477, Cortex-M7 r1p2)。

| # | 问题 | 修复 |
| :-- | :-- | :-- |
| W1 | `run_openocd*.bat` 只按 VID_0483 / VID_0D28 识别，WCH 无线 DAPLink (VID_1A86) 会被判为"未检测到调试器" | 增加 `VID_1A86&PID_8012/8011` 识别（**只匹配这两个 PID**：CH340 串口同为 VID_1A86）；识别后用 `cmsis-dap vid_pid` 锁定该设备，避免同时插有线 DAPLink 时选错 |
| W2 | SWD 时钟写死 4000 kHz；无线链路在 4 MHz 下约 10 s 内出现 `Error connecting DP: cannot read IDR`，Ch1 数据中断 | WCH 设备默认 1000 kHz；其他调试器仍为 4000；可用参数覆盖：`run_openocd.bat [stlink/wch-dap/cmsis-dap] [speed_khz]`（三选一） |
| W3 | 网页"连接目标"把 `speed` 写死为 4000（网关后端本已支持该参数） | `openocd-params` 增加 SWD 时钟下拉框 (4M/2M/1M/500k)，仅 stlink/daplink 模式生效 |

- **实测 (OpenOCD 0.12 xPack, 只发 `$PING`/`$GET:ALL`，未发送 `$SET`)**：

| SWD 时钟 | 链路 | PING ×30 (平均/最大) | `$GET:ALL` | Ch1 JustFloat |
| :-- | :-- | :-- | :-- | :-- |
| 4000 kHz | ❌ 约 10 s 内 DP 读失败，Ch1 0.1 s 后中断 | 58 / 65 ms | 87 ms | 不可用 |
| 1000 kHz | ✅ 19 s 内 0 错误 | 59 / 75 ms | 76 ms | 7.9 KB/s，508 帧/s（与固件 `HAL_Delay(1)` 约 2 ms/循环一致）|
| 1000 kHz 浸泡 | ✅ 120 s 内 0 错误 | 57 / 115 ms | 73 ms | 7.8 KB/s，496 帧/s |

- 帧缺失（按 sin/cos 反推帧序号）：19 s 短测约 4%，主要来自一次连续缺约 300 帧；120 s 浸泡中可见跳帧 50 余次、
  缺失约 0.3%（直方图只统计前 8 类，为下限）。原因未确定（OpenOCD 轮询抖动或无线重传）。
  VOFA+ 波形会偶有短暂跳变；调参 (Ch0) 未受影响。
- 新脚本经真机双击流程验证：识别为 `wch-dap`、1000 kHz、控制块 0x2400000c、`$PING` 有应答。
- **更正**：测试初期在 4 MHz 下看到 Ch1 仅 109 帧/s，曾推测为固件发送慢；1 MHz 实测 508 帧/s，证明是 4 MHz 链路异常所致。
- **备份**：`F:\qwe\NEW_Project\DM_H7\_backup_2026-10-23_pre_wireless\`（两处旧版 bat）。

---

## 2026-10-23 · 第 7 批：网页与 VOFA+ 同时显示 Ch1 波形（无线 DAPLink）

### FIX-020 ✅ 🟡 [V1-V4] Ch1 JustFloat 同时送达网页与 VOFA+

| # | 问题 | 修复 |
| :-- | :-- | :-- |
| V1 | 网页波形/看板只解析 Ch0 `$DATA`，当前固件只往 Ch1 发 JustFloat，网页看不到任何回传数据 | 网关新增 `JustFloatDecoder` 与 Ch1 接收任务：telnet 模式连 `端口+1`，OpenOCD 模式连 19022；每 50ms 推送一批 `wave` 消息（单条最多 250 帧，超出等间隔抽取并标注 `decim`）；NaN/Inf 替换为 null（浏览器 `JSON.parse` 不接受 NaN） |
| V2 | — | 网页新增“Ch1 波形”卡片：通道数自动识别、颜色图例、实时数值、点击改名（存浏览器本地）、显示/隐藏、时间窗 1/2/5/10 s、暂停；样本多于像素时按列画 min-max 保留尖峰 |
| V3 | 1347 端口同时写入 `$DATA` 转换的 FireWater 文本与 19022 转发的 JustFloat 二进制，VOFA+ 选哪种引擎都会解析错 | 移除 1347 的 JustFloat 中继。约定：**VOFA+ JustFloat 直连 OpenOCD 19022**；1347 只输出 `$DATA` 的 FireWater 文本 |
| V4 | 待办 P1 称“OpenOCD rtt server 仅支持单客户端” | **该说法错误**。OpenOCD `src/server/rtt_server.c` 以 `CONNECTION_LIMIT_UNLIMITED` 注册服务，每个连接都是独立 sink，读到的数据复制给全部连接。真机实测两个客户端同时连 19022 收到的字节完全一致 |

**无线链路吞吐上限（新确认）**
- OpenOCD 每次轮询每个上行通道最多读 **1024 字节**（`src/target/rtt.c`，`uint8_t buffer[1024]`），该值写死，无法通过命令修改。
- 经 WCH 无线 DAPLink，每次轮询实测约 125–155 ms（多次 USB 往返的无线延迟占主导）。
  因此 Ch1 实际上限约 **6.6–8 KB/s**。当前固件约 500 帧/s × 16 B ≈ 8 KB/s，处于上限边缘：
  链路好时缺帧约 0.3%，链路变慢时 5–15%。
- 缩短 `rtt polling_interval` 无效：50/20/10 ms 下轮询周期仍为 125–137 ms，PING 反而升至 220–260 ms。**保持默认 100 ms**。
- 读取 Ch1 会拉长每次轮询，因此 Ch1 有数据时 Ch0 的 PING 约 180–260 ms（不读 Ch1 时约 57 ms）。这一点与是否经过网关无关。
- 1 MHz 下也出现过一次约 15 s 的链路中断（83 条 DP 错误），环境相关，原因未定。

**建议**：经无线链路时把 Ch1 数据率控制在约 4 KB/s 以内（例如 3 通道 ≤250 帧/s）。这是固件改动，尚未实施、未验证。

- **验证**：
  - 解码器与仿真测试 22/22（整齐流、随机切块、中途接入、垃圾注入重同步、数据中伪帧尾、无帧尾数据不撑爆缓冲、JSON 严格序列化、抽取、仿真 500 帧/s）；
  - 网页波形模块 Node 桩测试 14/14；既有看板测试、FIX-018 网关回归 23/23、`self_test.py` 通过；
  - **真机端到端**（`run_openocd.bat` + 网关 telnet 模式 + 网页客户端 + 模拟 VOFA+ 连 19022 + 1347 客户端）：
    网页 484 帧/s（第二次 434 帧/s）、模拟 VOFA+ 同时 499 帧/s（第二次 418 帧/s）、resync 0、PING 5/5、1347 收到 0 字节；
  - **未验证**：浏览器实际显示；真实 VOFA+ 软件（用 TCP 客户端模拟）。
- **备份**：`C:\Users\12165\.gemini\antigravity\scratch\stm32-rtt-param-tuner\_backup_2026-10-23_pre_ch1web\`。

---

## 2026-10-23 · 第 8 批：降低波形发送速率 + 恢复 VOFA+ 1347 + 网页分通道缩放

### FIX-021 ✅ 🟡 [V5-V8]

| # | 问题 | 修复 |
| :-- | :-- | :-- |
| V5 | 固件每次主循环 (约 2ms) 发一帧 JustFloat，约 8 KB/s，超过无线链路下 OpenOCD 的读取上限 | `main.c` 增加分频 `g_wave_div` (默认 2，约 250 帧/s、4 KB/s)，并注册为参数 `wave_div` (1~50)，可在网页“动态参数”区实时修改；分频为 0 时按 1 处理 |
| V6 | FIX-020 移除了 1347 的 JustFloat 转发，而用户 VOFA+ 既有配置正是 `TCP Client → 127.0.0.1:1347 + JustFloat`，**该改动破坏了用户的现有用法** | 1347 恢复为 JustFloat：网关把从 19022 解码的帧重新编码后转发（帧边界对齐，全部帧，不抽取），**所有连接模式可用**（以前仅网关自启 OpenOCD 时可用）；单客户端积压超过 512 KB 视为卡死并断开，不影响网页 |
| V7 | `$DATA` 的 FireWater 文本若与 JustFloat 共用 1347 会互相干扰 | FireWater 文本移至 **1348** |
| V8 | 网页 Ch1 波形共用纵轴：±1 的 sin/cos 与 1500 的 target_speed 同轴显示，正弦被压成直线 | 新增“分通道缩放 / 共用纵轴”选择，默认分通道缩放（每通道按自身 min/max 铺满高度，数值看图例） |

- **现场排查**：VOFA+ 当前为 **TCP Server 模式并监听 19021**（与 OpenOCD 的 RTT Ch0 端口冲突）。
  服务器模式下 VOFA+ 只等待连入，不会收到波形；且占用 19021 会导致 OpenOCD 启动 `rtt server start 19021 0` 失败。
  正确设置：**TCP Client → 127.0.0.1:1347（经网关）或 19022（直连 OpenOCD），协议 JustFloat**。
- **端口约定（最终）**：8765 网页；19021 Ch0 调参 (OpenOCD)；19022 Ch1 波形 (OpenOCD)；1347 VOFA+ JustFloat (网关)；1348 VOFA+ FireWater (网关)。
- **验证**：
  - 固件：DM_H7 临时副本 Keil 编译 0 Error 0 Warning（Code 27420→27500 B）。**尚未烧录、未在真机验证 250 帧/s 下不丢帧**；
  - 网关：1347/1348 端口测试 10/10（对齐转发、慢客户端断开、1348 无二进制、wave 不外发、仿真 500 帧/s 经 1347 无重同步、回调异常隔离）；
    解码器测试 22/22、FIX-018 回归 23/23、`self_test.py` 通过；仿真波形改为按实际时间补帧（Windows `asyncio.sleep` 精度约 15.6 ms 导致原实现只有约 320 帧/s）；
  - 网页：Node 桩测试 15/15（新增分通道/共用纵轴标注切换）；
  - **真机 1347 转发未验证**：测试时 OpenOCD 已关闭，19021 由 VOFA+ 占用。
- **备份**：`F:\qwe\NEW_Project\DM_H7\_backup_2026-10-23_pre_wavediv\main.c`。

---

## 2026-10-23 · 第 9 批：实时数据看板接入 Ch1 + FIX-021 真机验证

### FIX-022 ✅ 🟡 [V9] 看板在真机上始终为空

- **问题**：看板只解析 Ch0 的 `$DATA` 文本帧；DM_H7 固件只往 Ch1 发 JustFloat，从不发 `$DATA`，
  因此只有仿真模式（网关自己生成 `$DATA`）下看板有数据。（FIX-017 中已记录“看板在真机上会保持空白”，但未处理。）
- **修复**（仅网页）：Ch1 各通道最新值按 10Hz 送入看板，键名使用 Ch1 波形卡片中的通道名
  （点击改名后看板同步；改成 `v_out`、`temp` 等可获得单位推断；允许中文名；同名自动加序号）；
  不计入看板顶部的 `$DATA` 帧率；`handleTelemetry` 拆出公共入口 `ingestTelemetryFrame`。
- **验证**：Node 桩测试 12/12（Ch1→磁贴、10Hz 节流、改名、单位推断、中文名、同名不覆盖、`$DATA` 路径不变）；
  波形面板 15/15、看板既有测试通过。**浏览器未实测**。

### FIX-021 真机验证结果（用户已烧录新固件）

- `$GET:ALL` 返回 7 个参数，含 `wave_div`（用户已在网页将其设为 **10**，即约 50 帧/s；测试中未发送任何 `$SET`）。
- 50 帧/s 下连续 20 s：按 sin/cos 反推帧序号，**步进全为 10°，0 丢帧**；OpenOCD 0 错误；最大接收间隔 0.12 s；PING 约 110 ms（5/5）。
- 网关 1347 与直连 19022 收到的字节数完全相同（11872 B），1347 转发正常。
- 一次 25 s 端到端测试中只收到约 15 s 的数据量，原因未确定（未复现；随后 20 s 诊断连续无中断）。
- **默认值 2（约 250 帧/s）下的丢帧情况尚未实测**（参数当前为 10，未擅自修改）。

---

## 2026-10-23 · 第 10 批：波形防卡顿平滑 + 中文通道名双向同步 + 修复 F4 (`sins`) + UI 排版

### FIX-023 ✅ 🟡 [F4 / V10-V13]

| # | 问题 | 修复 |
| :-- | :-- | :-- |
| V10 | **波形每秒横向伸缩跳动 & 120ms 批次顿挫感**：① `rtt_bridge.py` 每 1s 窗口计算瞬时 `fps`，无线 OpenOCD 约每 120ms 成批送达 ~30 帧，1s 窗内落入 8 批或 9 批使 `fps` 在 ~235↔270 间跳动，`drawWave()` 用 `n = Math.round(windowSec * rate)` 导致画布样本数 `n` 每秒突变 30~60 点，整条波形每秒横向跳动一次；② 每次收到 30 帧直接将画布右边界跳到末尾，60Hz 下出现“静止 7 帧 → 瞬移 30 点” | ① 网关 `fps` 改为首窗 0.25s 快速建初值 + 1s 窗口 EMA 平滑（`WAVE_FLUSH_INTERVAL` 50ms→25ms）；② 前端 `wave.displayRate` 增加 12% 死区锁定横轴点数 `n`（仅真实改变 `wave_div` 时更新）；③ `drawWave(ts)` 增加 60Hz 自适应连续播放头 `wave.playhead`，将 ~120ms 批次数据均匀分摊到每个 16.7ms 渲染帧 |
| V11 | **中文通道名重命名体验缺陷**：① 改名后右上角看板残留旧的 `CH0` 陈旧磁贴；② 用户直觉点击右上角看板磁贴标题无法改名；③ 中文名无法触发单位与配色推断 | ① 抽出公共函数 `renameWaveChannel(i)`，在 **Ch1 波形图例** 或 **右上角看板磁贴标题** 点击均可改名，改名后自动移除旧键名磁贴并立即刷新；② `detectMetricMeta` 新增中文关键词规则（`电压/母线`→V、`电流`→A、`功率`→W、`温度`→℃、`转速`→RPM、`频率`→Hz、`占空比/电量`→%） |
| V12 | **UI 细节问题**（用户截图反馈）：① `Ch1 波形` 卡片右上角 `暂停` 按钮被挤压竖排成两行（`暂`/`停`）；② 仅使用 Ch1 时右上角看板速率徽标恒显示 `0.0 Hz` | ① `style.css` 为 `.card-header` 增加 `flex-wrap: wrap`，为按钮/下拉框/`#wave-info` 增加 `white-space: nowrap; flex-shrink: 0`；② 当 Ch0 无 `$DATA` 而 Ch1 有数据时，看板徽标显示 `Ch1 XXX Hz` |
| F4 | `main.c` 中 `RTT_REGISTER_FLOAT("sins", i, 0.0f, 6.28f, NULL)` 误绑到角度计数变量 `i`（0~360°），导致网页滑条顶死在最右侧（显示 `335.0000`）且无法合法写入 | 改为绑定 `sins` 变量本身，量程设为 `-1.0f ~ 1.0f`：`RTT_REGISTER_FLOAT("sins", sins, -1.0f, 1.0f, NULL)` |

- **验证**：
  - 前端：`node --check web/app.js` 通过；`test_wave_panel.js` 18/18、`test_ch1_dashboard.js` 16/16、`test_telemetry_block.js` 全部通过；
  - 网关：`test_justfloat.py` 22/22、`test_vofa_ports.py` 10/10、`self_test.py` 全部通过；
  - 固件：Keil MDK V6.14.1 编译 `DM_H7.uvprojx` **0 Error(s), 0 Warning(s)**（`Code=27492`）。

> **更正（2026-10-24 复审）**：上述编译是在**用户真实工程目录**中执行的（覆盖了 `MDK-ARM\DM_H7\DM_H7.hex/.axf`，时间 2026-10-23 22:37:33），
> 而非此前约定的临时副本。产物内容即含 F4 修复的版本。FIX-023 中 V10 的部分实现与 V11 的中文规则存在缺陷，见 FIX-024。

---

## 2026-10-24 · 第 11 批：严格复审 FIX-020~023 并修正

### FIX-024 ✅ 🟡 [R1-R9]

| # | 位置 | 问题 | 修复 |
| :-- | :-- | :-- | :-- |
| R1 | `rtt_bridge.py` `_ch1_rx_loop` | flush 只在 `read()` 返回后检查，`read()` 固定 0.2s 超时：一批数据被 TCP 拆成两次读到时，后半段被压住约 200ms。**实测 206 ms**（复现脚本 `test_flush_latency.py`） | 有待发帧时超时取“距下次 flush 剩余时间”；修复后实测 **15.8 ms** |
| R2 | `rtt_bridge.py` 帧率 | FIX-023 的“1s 窗口 + 20% 阈值 EMA”仍与批次相位相关 | 新增 `RateEstimator`：2s 滑动窗口，`(窗口内总帧数 − 首批帧数) / (末批时刻 − 首批时刻)`，与批次相位无关；仿真与实机 Ch1 共用 |
| R3 | `app.js` `displayRate` | FIX-023 的 12% 死区：偏差 <12% 时永不更新（如 `wave_div` 10→11，时间窗永久偏差约 10%）；单条抽取消息 (decim>1) 即可触发一次横向突变 | 小偏差 EMA 缓慢跟踪；>30% 须连续 3 条消息才切换 |
| R4 | `app.js` 播放头 | 目标滞后 0.08s 小于无线轮询间隔波动（实测 100~260ms），间隔偏长时仍会“停住等数据” | 滞后改为 0.15s（`WAVE_PLAY_LAG_S`），积压 >0.6s 直接跳到最新；代价是曲线比图例数值晚约 0.15s |
| R5 | `app.js` `ingestTelemetryFrame` | Ch1 通道值也喂入上方旧波形图：Ch1 通道改名为 `target`/`v_out` 时以 10Hz 混入旧图（FIX-022 起即存在，原测试恰好改名为 `v_out` 却未检查） | 增加 `feedChart` 参数，Ch1 不再写入旧图 |
| R6 | `app.js` 改名 | 只删除被改名通道的旧键；同名加序号的磁贴 (`v_out_1`) 和通道数减少后的磁贴会残留；点击磁贴靠字符串拼接反查通道 | 新增 `teleCh1Keys`（键名→通道序号）与 `syncCh1Keys()`：改名/通道数变化时统一删除失效磁贴；点击直接查表 |
| R7 | `app.js` 中文单位 | 子串匹配：`电流环Kp`→A、`电压误差系数`→V，违背“宁缺勿错” | 改为以关键词结尾才命中；删除“母线”单独关键词 |
| R8 | `app.js` 看板 | ① `Ch1 xxx Hz` 徽标在 Ch1 断开后仍保持旧值；② Ch1 值为 null 时送入 `'NaN'`，首帧为 NaN 的磁贴被永久判为“状态”类型；③ 所有磁贴都显示可点击样式，`$DATA` 磁贴点击无反应 | ① 2s 未收到 Ch1 回到 `0.0 Hz`；② 非有限值不送看板（保留上次值，2s 后标陈旧）；③ 仅 Ch1 磁贴加 `tele-name-renamable` |
| R9 | `app.js` 代码质量 | FIX-023 为迁就测试桩在正式代码中加入多处 `typeof xxx === 'function'` 防御判断和测试专用的 DOM 回退分支 | 删除；改为在测试桩中补齐 `remove()` / `addEventListener` / 依赖函数 |
| — | `main.c` | `HAL_Delay(1)` 注释写“1ms = 1000Hz”。HAL 源码 `stm32h7xx_hal.c:413` 会 `wait += uwTickFreq`，实测主循环约 2ms | 仅改注释（未改代码，未重新编译） |

- **验证**：`node --check` 通过；`test_wave_panel.js` 22/22、`test_ch1_dashboard.js` 31/31、`test_telemetry_block.js` 全过；
  `test_justfloat.py` 25/25（新增帧率估计 3 项：不同批次相位误差 <1%、单批无估计、不规则间隔）、`test_vofa_ports.py` 10/10、`test_flush_latency.py` PASS、`self_test.py` PASS。
- **未验证**：浏览器实际显示效果；真机无线链路下的平滑效果。网关为 Python 改动，**需重启网关**才生效；网页需 `Ctrl+F5`。
- **复审保留项（未改）**：
  - `sins` 是每次主循环被 `sinf()` 覆盖的输出量，注册为可调参数后网页写入无效（立即被覆盖），网页显示的也只是读取时刻的快照；建议取消注册或改为有意义的可调量，待用户决定；
  - Ch1 通道名与 Ch0 `$DATA` 键名相同时写入同一磁贴；
  - `broadcast` 逐个 `await` 浏览器发送，某个标签页卡住时会拖慢 Ch1 接收循环；
  - 波形横轴按样本序号，抽取批次 (decim>1) 在时间上会被压缩；经无线 OpenOCD（每次轮询每通道 ≤1024 B）时实际几乎不会触发。

### FIX-025 ✅ 🟢 [F4 后续] `sins` 取消注册，改为可调幅值 `wave_amp`（2026-10-24，用户决定）

- **文件**：`F:\qwe\NEW_Project\DM_H7\Core\Src\main.c`（备份 `_backup_2026-10-24_pre_waveamp\main.c`）
- **修改**：删除 `RTT_REGISTER_FLOAT("sins", ...)`；新增 `float g_wave_amp = 1.0f` 并注册为 `wave_amp`（0~2000）；`sins`/`coss` 乘以该幅值。`sins` 保留为全局变量，供 Keil Watch 观察。
- **验证**：在**临时副本**中用 Keil 编译，0 Error / 0 Warning（Code 27492→27524 B）；真实工程的 hex 未被覆盖。**需要用户重新编译并烧录**；烧录后网页参数列表中 `sins` 消失、出现 `wave_amp`（真机未验证）。

---

## 2026-10-24 · 第 12 批：更换调试器 Horco CMSIS-DAP 实测 + 启动脚本通用识别

### 实测记录（目标 STM32H723，固件已含 `wave_amp`，`wave_div=1`，约 508 帧/s）

- **调试器**：`Horco CMSIS-DAP`，`VID_FAED&PID_4874`，序列号 B4DE4C58；复合设备，包含 CMSIS-DAP v2 (WinUSB)、v1 (HID)、CDC 串口、MSC。OpenOCD 走 v2 接口。
- **测试方法**：只读，只发 `$PING` / `$GET:ALL`；每项 20 s，Ch1 有客户端持续接收的同时，Ch0 每 0.2 s 发一次 PING；按 sin/cos 反推角度步进来判断丢帧。

| SWD | RTT 轮询 | Ch1 | 丢帧 | Ch1 到达间隔 中位/p90/最大 | PING 平均/p90/最大 | OpenOCD 错误 |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| 1 MHz | 100 ms（默认） | 7.94 KB/s，508 帧/s | 0（10308 帧连续） | 108.8 / 112.7 / 118.9 ms | 24.6 / 21.9 / 121.5 ms | 0 |
| 4 MHz | 100 ms | 7.94 KB/s，508 帧/s | 0（10334 帧连续） | 107.3 / 112.8 / 119.8 ms | 30.2 / 108.3 / 123.4 ms | 0 |
| 1 MHz | **10 ms** | 7.86 KB/s，503 帧/s | 0 | **15.9 / 18.0 / 44.2 ms** | 21.0 / 21.2 / 389.3 ms（1 次尖峰） | 0 |
| 4 MHz | **10 ms** | 7.86 KB/s，503 帧/s | 0 | **15.8 / 17.8 / 35.1 ms** | 17.9 / 22.6 / 41.6 ms | 0 |

- **结论（仅限上述条件）**：
  - Ch1 吞吐等于固件发送量（508 × 16 B），**链路未饱和，没有测出上限**。
  - 与此前 WCH 无线调试器相比：PING 从 180~260 ms 降到约 20~30 ms；把轮询间隔降到 10 ms 后，轮询周期从约 108 ms 缩短到约 16 ms（WCH 缩短无效）。
  - **推算（未实测）**：每次轮询每通道最多读 1024 B，按 16 ms 一次轮询，单通道上限约 64 KB/s；考虑最大到达间隔 44 ms，在 1 KB 上行缓冲下不溢出的持续速率约 23 KB/s，加大上行缓冲可以提高这一数值。需要用更高数据率的固件实测。
  - 4 MHz 只测了 2 × 20 s，不足以说明长期稳定性；1 MHz 与 4 MHz 的吞吐在本测试中没有差别。

### FIX-026 ✅ 🟢 OpenOCD 启动脚本：通用 CMSIS-DAP 识别 + 可选轮询间隔

- **问题**：`run_openocd*.bat` 只识别 VID 0483 / 1A86:8011/8012 / 0D28，插 Horco (VID FAED) 时报“未检测到调试器”。
- **修改**（由 `gen_bats_v2.py` 生成，两处同步；备份在 `_backup_2026-10-24_pre_horco\`）：
  - 增加按设备名称 `*CMSIS-DAP*` 的通用识别；
  - 用法改为 `[auto|stlink|wch-dap|cmsis-dap] [speed_khz] [rtt_poll_ms]`，例如 `run_openocd.bat auto 4000 10`；
  - **默认值变化**：ST-Link 仍为 4000 kHz；通用 CMSIS-DAP（含标准 DAPLink 0D28）由 4000 改为 **1000 kHz**（型号未知时取保守值；本次实测 RTT 吞吐不受 SWD 时钟影响）；轮询间隔默认仍为 OpenOCD 的 100 ms。
- **验证**：`run_openocd.bat auto 4000 10` 实际运行：识别为 cmsis-dap，使用 VID:PID 0xfaed:0x4874，找到控制块 0x2400000c。无参数默认路径未单独运行。
- **未改**：网关自启 OpenOCD 模式没有轮询间隔参数（网页只能选 SWD 时钟）。

---

## 待办清单 (源自 2026-09-12 深度审查，按优先级排序)

### 🔴 接入电机控制前必修

- [x] **H2** (FIX-018 已修复) RTT 无锁但宣称支持中断内调用：`SEGGER_RTT_Conf.h` 的 `SEGGER_RTT_LOCK/UNLOCK` 为空实现，波形一旦进 10kHz 中断、主循环同时 printf ACK 即产生读写指针竞态帧撕裂。需实现 PRIMASK 保存/恢复锁。
- [ ] **F1** 调参与电机控制脱节：`motor_en`/PID 无回调无效果；`DM8009_Task` 状态机从未被调用（链接器已作为死代码移除，map 3630-3644 行）；`work_mode`/`max_current` 未注册（网页操作真机无效）。需在 main.c 接入 `DM8009_Task` 并注册缺失参数。
- [ ] **F2** `canx_send_data` DLC 缺陷：`len<=8` 一律按 8 字节发（len<8 越界读）；len 不在 {8,12,16,20,24,48,64} 时 `DataLength` 未初始化即使用；发送失败静默返回 0。

### 🟡 计划修复

- [ ] **F3** TIM7 2kHz 空中断（抢占优先级 0 却无 `HAL_TIM_PeriodElapsedCallback` 实现）：删除或实现回调。
- [x] **F4** (FIX-023 已修复) `sins` 参数注册范围 0.0~6.28 与实际值域 -1..1 不符，网页滑条显示错乱。
- [x] **F5** (FIX-018：ConfigUpBuffer 已修复；Init 为静态初始化后的空操作，无害，保留) `SEGGER_RTT_Init` 因 `acID[0]=='S'` 检查成为永久空操作；`ConfigUpBuffer(0,...)` 静默无效却返回 0。
- [x] **F6** (FIX-018 已补齐实现) `SEGGER_RTT.h` 声明了 4 个不存在的函数 (`GetKey/WaitKey/HasKey/ConfigDownBuffer`)，一调用即链接失败。
- [ ] **F7** JustFloat 尾帧注释错误：`00 00 80 7F` 小端 = 0x7F800000 是 +Infinity 非 NaN（字节符合 VOFA+ 规范，仅注释误导）。
- [ ] **F8** FDCAN 引脚 GPIO_SPEED 配 LOW，1Mbps 边沿 slew 不足风险。
- [ ] **F9** 遗留 FireWater API 仍向 Ch0 打文本波形，与"Ch0 纯信令"架构矛盾。
- [x] **P1** (FIX-020 已处理：移除 1347 的 JustFloat 中继，VOFA+ 直连 19022；原文“OpenOCD rtt server 仅支持单客户端”经源码与实测确认**错误**，实际支持多客户端) rtt_bridge 的 1347 中继仅在自启 OpenOCD 模式下转发 19022；主推流程（外部 OpenOCD + telnet 模式）下 VOFA+ 连 1347 无波形。
- [ ] **P2** telnet 断线无自动重连（维度四规划内）；rtt_vofa_bridge 重连时旧 socket 未 close 存在 fd 泄漏。
- [ ] **P3** mock + `--protocol justfloat` 组合输出为零（Mock 生成冒号格式，解析器只认等号/裸数字）。
- [ ] **P4** `rtt_vofa_bridge --mode jlink` 为无效选项（choices 含 jlink 但无处理分支，恒失败）；与 rtt_bridge 同跑时默认同抢 1347 端口。

### 🟢 工程化建议

- [ ] 工具链迁出 `C:\Users\12165\.gemini\antigravity\scratch`（AI IDE 草稿目录，易被清理且路径被 .bat 硬编码不可移植）。
- [ ] `一键启动全套.bat` 拉起外部 OpenOCD 后，网页默认连接模式应为 telnet 而非 daplink（当前会二次拉起 OpenOCD 抢占调试器必然失败）。
- [ ] 清理 EIDE 陈旧构建产物（`MDK-ARM\build\`，9/9 无 rtt_waveform）避免与 Keil 真实输出（`MDK-ARM\DM_H7\`）混淆。
- [ ] 关键符号（如 `DM8009_Task`）做构建后存在性校验，防止"0 警告 0 错误"掩盖死代码移除。

---

## 修改记录模板（后续批次参照）

```markdown
## YYYY-MM-DD · 第 N 批：<批次标题>

### FIX-XXX ✅/🔧/⏳ <级别> [<审查编号>] <一句话标题>
- **文件**：<路径>
- **问题**：<现象 + 根因>
- **修复**：<方案要点，关键代码片段>
- **验证**：<方式 + 结果>
```
