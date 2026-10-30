# capture-sharp

> 版本：0.3.0

极薄的采集引导技能：只负责告诉 agent「优先调用哪个工具、失败怎么处理」，**不含任何脚本**。
截图由插件 Host 里的 `capture_screenshot` 完成，录屏由 `capture_recording` 完成（Windows 单屏 console，beta），诊断由 `capture_probe` 完成。

## 资源地图

| 路径 | 用途 |
|---|---|
| `SKILL.md` | 工具优先的工作流、两种尺寸的语义、录屏生命周期、失败码处理、支持边界与反模式 |
| `references/troubleshooting.md` | 截图与录屏的症状、错误码速查、尺寸/清晰度/帧率的常见误判 |

## 契约句清单

- 截图只调用 capture_screenshot；录屏只调用 capture_recording；需要判断环境或排查失败时才调用 capture_probe，不要执行任何脚本。
- 全屏截图进入模型时会被附件库**按像素预算等比缩小**（本机 3072×1920 → 约 2590×1619，重编码为 JPEG 或 WebP——实测是 WebP），以返回的 `image.width` / `image.height` 为准；要看细字或 1px 线请用 target:"region" 裁出目标区域。
- width / height 是磁盘上 PNG 的尺寸，image.width / image.height 是模型实际看到的尺寸，二者常常不同。
- display id 必须用 capture_probe 返回的不透明 id，不能用数组下标。
- maxWidth 只缩小一次，永不放大。
- out 是相对调用方工作区根的路径，默认 output/capture/<uuid>.png，不得越界。
- 录屏：start 后立刻保存返回的 recordingId，之后所有 status/stop/cancel 都带上它；**state 不是 completed 就没有交付物**，不要读、不要播放、不要告诉用户路径已生成。
- 录屏的 `path` 只在 completed 出现；completed 才同时给出实测 `width/height/actualFps/durationSec/frameCount`。
- 同一工作区（含主 agent 与子智能体）可凭 recordingId 操作同一会话；**跨工作区会被拒绝为 `recording_workspace_mismatch`**；DSH/插件重启后旧 recordingId 一律失效（`recording_not_found`）。
- 录屏默认 60fps、原生分辨率、无音频；MP4 是 yuv420p 有损编码，**不与 PNG 逐像素一致**，也不承诺无损。

## 兼容性声明

- **解释器**：无。本技能不含脚本，也不需要任何解释器；采集发生在 DSH Host 内。
- **依赖**：Windows 截图用系统 GDI（经 Host 自带的原生辅助）；macOS 用系统 screencapture；Linux X11 用 maim / scrot / import 之一；Wayland 用 XDG Portal 或 grim。缺什么由 `capture_probe` 的 `backends[].missing` 报出。**录屏额外需要外部 FFmpeg + FFprobe，且 FFmpeg 必须带 ddagrab filter 与 libx264 encoder**；缺失时只看 `capture_probe.recording.missing`，且**只影响录屏，截图照常可用**。
- **降级**：不降级。工具缺失、无显示、权限不足一律结构化失败（`backend_unavailable` / `no_display` / `permission_required`），不换低清后端、不返回黑图、不把失败写成成功；录屏也**没有** gdigrab / 循环截图 / 低帧率回退。
- **未验证**：Windows 单屏 console 的截图与录屏（display/region）为 beta；多屏、混合 DPI、HDR、RDP、会话 0、window 录制都不支持或未验证；macOS、Linux X11 与 Wayland 只有截图 experimental，**没有录屏**；`target:"all"` 不支持。

## 支持等级

等级定义：stable = 有真机证据与读图结论；beta = 实现完整但只有部分分支实测；experimental = 实现存在但零真机；unsupported = 明确拒绝，不静默降级。

截图（`capture_screenshot`）：

| 平台 / 会话 | display | window | region |
|---|---|---|---|
| Windows 10/11 console（单屏） | beta | beta | beta |
| Windows 多屏 / 混合 DPI / HDR | experimental | experimental | experimental |
| Windows RDP / 会话 0 / 安全桌面 | experimental | unsupported | experimental |
| macOS（Retina 与非 Retina） | experimental | experimental | experimental |
| Linux X11 | experimental | experimental | experimental |
| Linux Wayland | experimental | unsupported | experimental |
| headless / CI | 一律 `no_display` | — | — |

录屏（`capture_recording`，与 `capture_probe.recording.targets` 一致）：

| 平台 / 会话 | display | region | window / all |
|---|---|---|---|
| Windows 10/11 console（单屏、SDR、非 RDP） | beta | beta | 不支持 |
| Windows 多屏 / HDR / RDP / 会话 0 / 安全桌面 | 不支持（未验证） | 不支持（未验证） | 不支持 |
| macOS / Linux / headless | 不支持（未实现） | 不支持（未实现） | 不支持 |

录屏 beta 的证据是 `evals/recording-0.3.0/windows-e2e.md`：只覆盖 Windows 单屏 console 的 display/region，**不包含**其它平台、多屏、HDR、RDP 或 window。

## 安装与卸载

本技能由插件在挂载时安装到全局技能目录（默认 `$DSH_HOME/skills/capture-sharp`），不需要单独安装。

插件被正常禁用或移除时，本插件安装且内容未被改动过的技能目录会被清理；进程被强制结束或插件目录被手工删除**没有可靠钩子**，该目录会残留，需要手动删除 `$DSH_HOME/skills/capture-sharp`。
用户自己放的同名目录不会被覆盖，此时 `capture_probe` 的 `skillStatus` 报 `shadowed`，工具照常可用。