<p align="center"><a href="./README.md">中文</a> | <a href="./README.en.md">English</a></p>

<h1 align="center">dsh-plugin-control-your-capture</h1>

> 面板插件 v0.3.0 · skill v0.3.0

<p align="center">把截图与录屏工具装进 DSH：按物理像素抓显示器、窗口或区域；也可以在 Windows 单屏 console 把屏幕或区域录成 MP4。</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node-%E2%89%A5%2018-339933?logo=nodedotjs&logoColor=white" alt="Node 18+"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-2ea44f" alt="许可证 MIT"></a>
  <a href="https://github.com/HaoyanZhang123/dsh-plugin-control-your-capture"><img src="https://img.shields.io/badge/DSH-plugin-4B5563" alt="DSH 插件"></a>
</p>

## 简介

高 DPI 屏上截图发虚，通常不是编码问题，而是采样问题：屏幕的物理像素远多于逻辑像素。

在一台 3072×1920、系统缩放 200% 的 Windows 上实测：未声明 DPI 感知的进程只能采到 1536×960，之后无论怎么编码都补不回文字锐度。

![高清截图台：把 capture_screenshot 装进 DSH——按物理像素截显示器、窗口或区域，自带 probe 环境检测](https://raw.githubusercontent.com/HaoyanZhang123/dsh-plugin-control-your-capture/main/assets/banner.webp)

**用与不用的差别有多大**（本机实测，同一屏幕区域、同一时刻，只改采样分辨率、不做任何后期锐化）：

![同一块屏幕区域：左为本插件按物理像素采集（800×500 锐利），右为按逻辑像素采集 400×250 再放大 2×（发虚）](https://raw.githubusercontent.com/HaoyanZhang123/dsh-plugin-control-your-capture/main/assets/compare-native-vs-logical.webp)

受控锐度靶（8/9/10/16pt 中英细字 + 1px 线 + 4px/8px 棋盘格）上，文字带锐度（拉普拉斯方差）**小字 8/9/10pt 相差约 75×、16pt 大字约 28×**；
右图的 1px 竖线已经糊成灰带、棋盘格退化成莫尔纹，这正是「按逻辑像素抓屏」的直接后果。

### 为什么差这么多

高 DPI 屏上，面板的物理像素比逻辑分辨率多 N 倍（系统缩放 200% 时 N=2，像素数是 4 倍）。
按逻辑像素采集只能拿到 1/N 的真实信息：1 个源像素要铺满 N×N 个物理像素，1px 线在第一轮采样里就被平均掉，之后任何锐化都补不回来。

本插件先声明 per-monitor DPI 感知，再按物理像素采集：一次采样、1:1 交付、不放大、不重采样。

倍率能到 75×，是因为锐度指标对高频细节超线性敏感，而测试靶用的是 1px 线与 8pt 细字这类极端内容；
普通正文（16pt）约 28×——不代表任何界面都差 75 倍。

**代价是速度**：每次调用都要启动一个原生辅助进程。实测（Windows 11 / 3072×1920 / 200% 缩放，各 20 次取中位数）：
全屏约 **812 ms**（p90 846 ms），区域 800×500 约 **681 ms**（p90 700 ms）。所以我们赢在保真，不在快。

本插件把这件事做成**工具**而不是脚本清单：挂载时注册 `capture_screenshot` 与 `capture_probe`，
并把一份极薄的 `capture-sharp` 引导技能装到全局技能目录，任何工作区、任何会话都能直接用。

## 功能

| 能力 | 说明 |
|---|---|
| `capture_screenshot` | 抓 `display`、`window`、`region` 三类目标；默认 PNG、默认不缩放 |
| `capture_probe` | 只诊断不截图：显示器、可用后端、权限、输出根、技能健康度、各目标的支持等级，以及录屏能力（`recording`） |
| `capture_recording` | Windows 单屏 console 把 `display` 或物理像素 `region` 录成 MP4；`start` / `status` / `stop` / `cancel` 四动作，生命周期由 Host 托管 |
| 原生清晰 | 按后端报告的物理像素采集；`maxWidth` 只允许一次缩小，**永不放大** |
| 双通道交付 | 同一份字节既落盘为原生 PNG（`path`），又交给附件库（`image`）；模型可见尺寸可能被附件库归一化，以 `image.width` / `image.height` 为准 |
| 并发安全 | 每次调用唯一文件名、同目录临时文件加原子重命名；不覆盖、不留半成品 |
| 结构化失败 | 失败一律带 `code`、`message`、`details`、`hint`；缺工具、无显示、权限不足都明确报错 |
| 零运行时依赖 | 只用 Node 内置模块；不装第三方包，也不 import DSH 内部包 |
| 极薄技能 | 技能只教「优先调用工具与失败处理」，**不含任何脚本**，不存在第二套执行路径 |

## 平台支持矩阵

等级定义：`stable` 有真机证据与读图结论；`beta` 实现完整但只有部分分支实测；`experimental` 实现存在但零真机；`unsupported` 明确拒绝，不静默降级。

| 平台 / 会话 | display | window | region | 证据状态 |
|---|---|---|---|---|
| Windows 10/11 console（单屏） | beta | beta | beta | 本机真机已跑通采集与读图：自制测试卡（8pt 细字 / 1px 线 / 4px 与 8px 棋盘格 / 屏幕四边）经 `target:"region"` 取回后**逐像素相同**；仍未升 stable 的原因是 `no_display` 与「后端缺失」在本机结构上不可达、真实采集超时未触发（超时只做了机制级验证） |
| Windows 多屏 / 混合 DPI / HDR | experimental | experimental | experimental | 无真机证据 |
| Windows RDP / 会话 0 / 安全桌面 | experimental | unsupported | experimental | 不承诺成功 |
| macOS（Retina 与非 Retina） | experimental | experimental | experimental | 零真机；窗口目标需显式窗口 id |
| Linux X11 | experimental | experimental | experimental | 零真机；需 maim / scrot / import 其一 |
| Linux Wayland | experimental | unsupported | experimental | 零真机；需 XDG Portal 或 grim，可能弹授权 |
| headless / CI | — | — | — | 一律 `no_display` |
| 任意平台 + `target:"all"` | — | — | — | `unsupported_target`（0.3.0 不提供） |

- 本矩阵与 `capture_probe` 返回的 `targets` 一致；两者不一致即为缺陷。
- 只有实测通过的「平台 × 目标」才可能写 stable；**没有任何平台被声明为全平台支持**。
- 本插件不屏蔽其它截图工具，也不强制任何 preset 或模型必须调用它。

录制（`capture_recording`）：

| 平台 / 会话 | display | region | 证据状态 |
|---|---|---|---|
| Windows 10/11 console（单屏，SDR） | **beta** | **beta** | 本机真机实测：3072×1920 @ 57.48fps、800×500 @ 57.45fps，1 video / 0 audio、`-xerror` 全文件解码通过、faststart 生效；长录制 279.6s 验证不被 120s 超时截断 |
| Windows 多屏 / HDR / RDP / 会话 0 | unsupported | unsupported | 明确拒绝（`unsupported_target`），不静默降级 |
| macOS / Linux | unsupported | unsupported | 0.3.0 不提供录制 |
| `target:"window"` / `target:"all"` | — | — | `unsupported_target` |

录屏依赖外部 **FFmpeg（需 ddagrab filter 与 libx264）** 和 **FFprobe**：`capture_probe.recording.missing` 会逐项列出缺失；缺它们**只影响录屏，截图照常可用**。

## 安装

前提：已安装 DSH。包本身零运行时依赖；截图用系统自带能力（Windows 的 GDI、macOS 的 screencapture、Linux 的 maim / scrot / import 或 Portal / grim），**录屏额外需要外部 FFmpeg（带 ddagrab 与 libx264）与 FFprobe**。

```bash
dsh plugin add dsh-plugin-control-your-capture
```

- 新装 bundle 可经 HMR 生效；**替换已安装的包必须重启 DSH** 才会加载新的模块。
- DSH 官方限制：已安装插件不支持自动更新，升级请先卸载再装新版。
- 挂载时把 `capture-sharp` 装到全局技能目录（默认 `$DSH_HOME/skills`），并注册三个工具。

## 使用

自然语言就能触发：「截个图」「把当前窗口给我看」「这块区域看不清，截大一点」。也可以直接说清目标与尺寸。

| 参数 | 取值 | 说明 |
|---|---|---|
| `target` | `display` / `window` / `region` | 缺省为 `display`；没有 `all` |
| `display` | `capture_probe` 返回的不透明 id | 缺省为活动窗口所在显示器；回落到主屏时给 `active_display_unavailable` 警告 |
| `window` | 后端可解析的窗口 id | 仅 `target:"window"` 有意义；缺省为当前前台窗口，找不到就 `window_not_found`，不退化成全屏 |
| `region` | `{x, y, width, height}` | 仅 `target:"region"` 必填；**物理像素**，相对所选显示器左上角，不跨屏 |
| `out` | 工作区根内的相对路径 | 默认 `output/capture/<uuid>.png`；绝对路径与越界会被拒绝 |
| `maxWidth` | 正整数 | 小于原生宽度时缩小一次；大于等于原生宽度时返回原图 |

裁一块区域看细字的典型调用：

```json
{ "target": "region", "region": { "x": 600, "y": 200, "width": 1600, "height": 900 }, "maxWidth": 1600 }
```

返回字段：`path`（磁盘 PNG 的绝对路径）、`width` / `height`（该 PNG 的 IHDR 尺寸）、`nativeWidth` / `nativeHeight`（后端报告的采集尺寸，无法证明时省略）、`platform`、`backend`、`target`、`display`、`scaled`、`upscaled`（恒为 `false`）、`warnings`、`image`（附件库归一化副本：`attachmentId`、`mediaType`、`bytes`、`width`、`height`，降采样时还有 `originalDimensions`）。

**两种尺寸不要混为一谈**：`width` / `height` 是磁盘上的文件，`image.width` / `image.height` 是模型实际看到的图。
附件库默认会把超过 4,194,304 像素或 4 MiB 的图**按像素预算等比缩小**（不是固定裁成某个尺寸）并重编码，所以本机 3072×1920 的全屏截图进入模型时约为 **2590×1619**（`sqrt(4194304 / (3072*1920))` 等比缩放），格式为 **JPEG 或 WebP——本机实测是 `image/webp`**；实际数值以返回的 `image.width` / `image.height` 为准，那才是模型看到的尺寸（2026-10-27 装机实测：文件 `3072x1920` → 模型 `2590x1619 image/webp`，`warnings` 为 `model_image_downscaled, attachment_reencoded`）。
并在 `warnings` 里给出 `model_image_downscaled`（被重编码时再加 `attachment_reencoded`）。
**要看细字或 1px 线，请用 `target:"region"` 裁出目标区域，而不是要求放大。**

`warnings` 是**封闭词表**（7 个 id），工具只去重保序、不静默丢弃：

`active_display_unavailable`、`quality_unverified`、`model_image_downscaled`、`attachment_reencoded`、`out_renamed`、`skill_shadowed`、`content_uniform`。

其中 `content_uniform` 表示后端检测到整幅画面近似单一颜色（纯黑/纯色，常见于受保护内容或空窗口）——**图仍然交付**，但看到它就该怀疑"截到的不是用户想看的东西"。

### 录屏：capture_recording

| 参数 | 取值 | 说明 |
|---|---|---|
| `action` | `start` / `status` / `stop` / `cancel` | 必填 |
| `recordingId` | `start` 返回的不透明 id | `status`/`stop`/`cancel` 必填；`start` 不允许传 |
| `target` | `display` / `region` | 缺省 `display`；**不支持** `window` / `all` |
| `display` | `capture_probe` 返回的不透明 id | 缺省为当前唯一显示器 |
| `region` | `{x,y,width,height}` | **物理像素**、相对显示器左上角、宽高必须偶数、必须完整在屏内 |
| `fps` | `30` / `60` | 缺省 60 |
| `drawMouse` | boolean | 缺省 true |
| `out` | 工作区内的相对 `.mp4` | 缺省 `output/capture/<uuid>.mp4`；已存在时改用唯一名并给 `out_renamed`，不覆盖 |

- `start` 快速返回 `recordingId`；**`path` 只在 `completed` 出现**——`starting` / `recording` / `stopping` 都没有可交付文件，`failed` / `cancelled` 更不会交付。
- 同一插件实例同一时刻只允许一个活动录制；同一工作区内的其它 Agent（含子智能体）可凭 `recordingId` 协作，跨工作区一律 `recording_workspace_mismatch`；DSH/插件重启后旧 id 失效。
- 编码固定：`libx264` / `veryfast` / CRF 14 / `yuv420p` / `+faststart`、无音频；**没有 gdigrab 或低帧率回退**，`stop` 会做 FFprobe（`-count_frames`）+ 完整解码校验，不通过就不发布。

### 页面截图 vs 屏幕截图

`capture_screenshot` 抓的是**桌面上真实显示的内容**（物理像素，永不放大）。因此：

- **页面没显示在屏幕上**（无头浏览器、离屏渲染、最小化窗口）：本插件抓不到，这不是它的场景。请用页面渲染侧（如 CDP）截页面内容，并把 `deviceScaleFactor` 设成 `capture_probe` 返回的 `displays[].scaleFactor`（本机为 2），或用 `Page.captureScreenshot` 的 `clip.scale`；输出 PNG，事后别再缩放。
- **页面 / 窗口确实显示在屏幕上**：用本插件，`target:"window"` 或 `target:"display"`；要看清细字用 `target:"region"` 裁 1:1 区域。
- **模型看到的图偏小**：附件库会降采样（3072×1920 → 约 2590×1619，`model_image_downscaled`），磁盘文件仍然清晰。

## 配置

可选项写在本插件行的 `config:` 里，全部可省略：

| 键 | 默认 | 说明 |
|---|---|---|
| `skillRoot` | `$DSH_HOME/skills` | 引导技能的安装根目录，必须是绝对路径 |
| `skillInstall` | `true` | 设为 `false` 时不安装技能；工具照常可用 |
| `skillCleanupOnUnload` | `false` | 显式设为 `true` 才在插件卸载/退出时删除本插件装的技能。**默认不删**：进程退出/重启同样会触发 dispose，删了会和新进程的安装抢同一个目录（实测导致"重启后技能消失"） |
| `timeoutMs` | `20000` | 单次采集超时；超时会清理整个进程树并报 `capture_timeout` |
| `maxWidth` | 不缩放 | 服务级默认缩小宽度；单次调用传入的 `maxWidth` 优先 |

配置非法会让插件直接失败（fiber FAILED，可观测），不会静默用默认值掩盖。

## 卸载与残留

卸载插件时，若 DSH 正在运行且插件被正常禁用或移除，本插件安装的 `capture-sharp` skill 会被清理。
若进程被强制结束、插件目录被手工删除或 profile 被还原，**没有可靠钩子**：该 skill 目录会残留，需要手动删除 `$DSH_HOME/skills/capture-sharp`。
用户自己放的同名目录不会被覆盖，此时 `capture_probe` 的 `skillStatus` 为 `shadowed`，工具仍然可用。

## 已知限制

- **能力范围 = 截图 + Windows 单屏录屏**：截图覆盖 `display` / `window` / `region`；录屏只有 Windows 单屏 console 的 `display` / `region`。没有 UI 面板，也没有别的采集形态。
- **录屏的限制**：不做音频、不做 `window` / 多屏 / HDR / RDP / 会话 0，macOS 与 Linux 不提供录制；`yuv420p` 有损，**不与 PNG 逐像素一致**，也没有无损模式。
- **录屏依赖外部 FFmpeg / FFprobe**（需 ddagrab + libx264）：缺失时 `backend_unavailable` 并逐项列在 `missing`，不自动下载、不捆绑。
- **硬杀宿主**（崩溃 / 强杀）后的孤儿 FFmpeg 与 `.tmp-*.mp4` 不保证清理（0.3.0 未实现 Job Object）。
- **就绪语义**：`start` 的就绪条件是“进程存活 + 临时文件非空（头部）”；FFmpeg 的输出缓冲可能让视频数据直到 `stop` 才完全落盘，交付质量由 `stop` 的 FFprobe + 完整解码把关。
- Windows 只有单屏 console 实测到 beta；多屏、混合 DPI、HDR、RDP、会话 0、安全桌面都没有声称支持。
- macOS、Linux X11 与 Wayland **零真机**，只能 experimental；Wayland 可能弹授权，且不支持单窗口目标。
- `target:"all"` 不支持；跨显示器区域会被拒绝（请分别截图）。
- 全屏大图进入模型会被降采样，细字判读必须用 `target:"region"`。
- 不注册 UI 卡片（`presentCall` / `presentResult`），结果只体现在工具文本与图片里。
- 不修改 system prompt、不使用 `tools.restrict` / `tools.guard` 制造「优先」。
- **`target:"window"` 对 GPU 合成的窗口可能返回空白图**：部分浏览器 / Electron 窗口的合成层抓不到（`PrintWindow` 返回空内容，事件由 compositor 接管），结果是整幅纯色而非窗口内容。此时 `warnings` 会带 `content_uniform`——看到它就别把这次结果当成"截到了"，改用 `target:"display"` 或 `target:"region"`（本机 2026-10-27 实测：Chrome 窗口返回 2528×1936 的白色图，同窗口的 `display`/`region` 正常）。
- 超时后虽然会清理整个进程树，但**真实采集超时在本机没有触发过**（只有机制级验证）；这一条在升级到 stable 前不会改口径。

## 从 0.1.x 迁移（破坏性）

### 0.3.0：录屏回来了，但不是旧脚本

0.3.0 重新提供录屏，形态是 Host 内的 **`capture_recording` 工具**（DDA + libx264 + MP4 原子发布），**不是** 0.1.x 的 `rec.ps1` / `capture.sh rec`；技能里仍然**没有任何脚本**，不存在第二套执行路径。升级路径：卸载旧版 → 安装 0.3.0 → 重启 DSH。

### 0.2.0 的破坏性变更（历史）

0.2.0 删除了 0.1.x 的录屏与网页截图能力，也删除了技能内的全部脚本：采集只剩 `capture_screenshot` 这一条执行路径。

- 技能目录不再有 `scripts/`；照抄旧脚本路径的自动化会失效。
- 旧的录屏参数与网页目标尺寸推导不再被接受，网页链路的端到端检查也从门禁里移除。
- 升级路径：卸载旧版 → 安装 0.2.0 → 重启 DSH；全局技能目录里残留的旧脚本需要手动删除。
- 逐版本细节见 [CHANGELOG.md](CHANGELOG.md)。

## 项目结构

```text
lib/index.js                          Host 入口：生命周期、工具注册与清理
lib/service.js                        唯一截图服务：参数规范化、后端选择、落盘、附件与错误映射
lib/tool.js                           capture_screenshot / capture_probe 的 schema 与结果渲染
lib/adapters/{windows,macos,linux}.js 平台后端：只产出原始字节，不决定落点
lib/native/windows-shot.ps1           Windows DPI-aware 原生辅助
lib/png.js / lib/paths.js             PNG 校验、输出根、唯一命名与原子写
lib/provision-skill.js                引导技能的安装、hash 与清理
cordis.patch.yml                      插件行声明
locale/                               插件卡片文案（中 / 英）
skill/capture-sharp/                  随包引导技能（无脚本，由门禁从技能事实源生成）
```

## 许可证

[MIT](LICENSE)。
