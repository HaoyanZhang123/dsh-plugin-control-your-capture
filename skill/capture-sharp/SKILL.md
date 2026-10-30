---
name: capture-sharp
description: "高清截图与录屏（Windows / macOS / Linux）：截图优先调用 capture_screenshot 抓显示器、窗口或区域，按物理像素采集、永不放大；录屏调用 capture_recording（Windows 单屏 console 的 display/region，beta）；只在需要判断环境或排查失败时调用 capture_probe。Use when 用户说截图、抓屏、截个图、把屏幕内容给模型看、画面发虚或模糊、DPI、要某个窗口或某一块区域、录屏、录制屏幕、把操作过程录下来，or when an agent must show the screen to the model or record it. Not for 视频成片与剪辑（走项目工作流）；不含任何脚本，也不替代其它截图/录屏工具。"
---

# capture-sharp

**截图只调用 capture_screenshot，录屏只调用 capture_recording；需要判断环境或排查失败时才调用 capture_probe，不要执行任何脚本。**
本技能是极薄的引导，不含任何脚本；不要手写 PowerShell / AppleScript / FFmpeg / gdigrab / 其它命令再实现一套采集，单一执行路径就在这里。

## 契约句（逐字，不得改写）

- 截图只调用 capture_screenshot；录屏只调用 capture_recording；需要判断环境或排查失败时才调用 capture_probe，不要执行任何脚本。
- 录屏：start 后立刻保存返回的 recordingId，之后所有 status/stop/cancel 都带上它；**state 不是 completed 就没有交付物**，不要读、不要播放、不要告诉用户路径已生成。
- 录屏的 `path` 只在 completed 出现；completed 才同时给出实测 `width/height/actualFps/durationSec/frameCount`。
- 同一工作区（含主 agent 与子智能体）可凭 recordingId 操作同一会话；**跨工作区会被拒绝为 `recording_workspace_mismatch`**；DSH/插件重启后旧 recordingId 一律失效（`recording_not_found`）。
- 录屏默认 60fps、原生分辨率、无音频；MP4 是 yuv420p 有损编码，**不与 PNG 逐像素一致**，也不承诺无损。

## 首选：capture_screenshot

| 想要的画面 | 参数 |
|---|---|
| 当前屏幕（默认） | 不传 `target`，等价 `target:"display"` |
| 指定某块显示器 | `target:"display"` + `display:"<capture_probe 返回的 id>"` |
| 某个窗口 | `target:"window"` + `window:"<后端可解析的 id>"`；不传 `window` 表示当前前台窗口 |
| 屏幕上一块区域 | `target:"region"` + `region:{x,y,width,height}` |

- `region` 用**物理像素**，相对所选显示器左上角；不允许跨显示器，多屏请分别截。
- display id 必须用 capture_probe 返回的不透明 id，不能用数组下标。
- out 是相对调用方工作区根的路径，默认 output/capture/<uuid>.png，不得越界。
- maxWidth 只缩小一次，永不放大。
- 无法确定活动窗口所在显示器时会回落主显示器，并在 `warnings` 里给 `active_display_unavailable`。

## 页面截图 ≠ 屏幕截图

- 本工具抓的是**桌面上真实显示的内容**（物理像素）。无头浏览器、离屏渲染、被最小化的窗口不在屏幕上，抓不到——不要用它，也不要据此断言"截图功能坏了"。
- 要截**网页内容本身**（页面没显示在屏幕上）：用页面渲染侧的能力（如 CDP），把 `deviceScaleFactor` 设成显示器缩放——`capture_probe` 返回的 `scaleFactor`（本机为 2），或用 `Page.captureScreenshot` 的 `clip.scale`；输出 PNG，截完不要再缩放或转 JPEG。1400×900 + DPR 1 在 2× 屏上只有一半分辨率，字必然发虚，而放大不可逆。
- 只有页面**确实显示在窗口里**时，才用 `capture_screenshot`（`target:"window"` 或 `"display"`）：物理像素、永不放大；要看清细字用 `region` 裁出 1:1 区域。

## 录屏：capture_recording（Windows 单屏 console，beta）

| 想要 | 参数 |
|---|---|
| 开始录当前屏幕（默认） | `{action:"start"}` |
| 开始录一块显示器 | `{action:"start", target:"display"}` + 可选 `display:"<probe 的 id>"` |
| 开始录屏幕上一块区域 | `{action:"start", target:"region", region:{x,y,width,height}}` |
| 查询进度 | `{action:"status", recordingId:"<start 返回的 id>"}` |
| 用户说结束 | `{action:"stop", recordingId:"..."}` |
| 用户说放弃 | `{action:"cancel", recordingId:"..."}` |

- **start 一返回就记住 `recordingId`**（state 通常是 `recording`）；之后所有 status/stop/cancel 都带同一个 id，不要另编 id、不要把文件名当 id。
- **只有 `state:"completed"` 才有 `path`**，那是唯一可交付的 MP4，并同时给 `width/height/actualFps/durationSec/frameCount`。`starting/recording/stopping` 不是交付物，failed/cancelled 更没有文件——不要读、不要播放、不要声称“视频已生成”。
- `stop` 要等封装 + FFprobe + 完整解码校验，比普通调用慢；失败会 `throw`（首行 `capture_recording failed [<code>]: …`），把原因如实告诉用户，别重试成“成功”。
- 默认 60fps、原生分辨率、无音频。`region` 是相对显示器左上角的**物理像素**，宽高必须是偶数；`fps` 只接受 30/60；`out` 只接受工作区内以 `.mp4` 结尾的相对路径。
- 同一插件实例同时只能有一个活动录制：已有录制时再 start 报 `recording_already_active`；对 completed 再 stop 返回同一结果，对 failed/cancelled 再 stop 报 `recording_state_conflict`。
- 同一工作区内（主 agent 与子智能体）可凭 recordingId 协作；**跨工作区会被拒绝**（`recording_workspace_mismatch`）。DSH/插件重启后旧 id 一律失效（`recording_not_found`），只能重新 start。
- 录屏不可用/失败先 `capture_probe` 看 `recording`：`available/backend/grade/targets/missing/reason`。常见 `missing`：`ffmpeg`、`ffprobe`、`ddagrab`、`libx264`；缺外部 FFmpeg **只影响录屏**，截图照常可用。
- MP4 是 `yuv420p` 有损编码：清晰、原生尺寸，但**不与 PNG 逐像素一致**，不要承诺无损。
- **绝不**自己写 FFmpeg / gdigrab / 循环截图命令补一套录屏；单一执行路径是 `capture_recording`（服务内部没有 gdigrab 或低帧率回退）。

## 最要紧的一件事：两种尺寸

- width / height 是磁盘上 PNG 的尺寸，image.width / image.height 是模型实际看到的尺寸，二者常常不同。
- 全屏截图进入模型时会被附件库**按像素预算等比缩小**（本机 3072×1920 → 约 2590×1619，重编码为 JPEG 或 WebP——实测是 WebP），以返回的 `image.width` / `image.height` 为准；要看细字或 1px 线请用 target:"region" 裁出目标区域。
- 降采样发生时 `warnings` 含 `model_image_downscaled`，被重编码为 JPEG/WebP 时还会含 `attachment_reencoded`。
- 看到 `warnings` 里的 `content_uniform` 就要怀疑：后端认为整幅画面近似单一颜色（纯黑/纯色，常见于受保护内容或空窗口）。**图仍然会交付**，但先告诉用户"这可能不是你想截的东西"，别直接当成截图成功。
- 不要拿 `width` / `height` 声称「模型已经看清细节」。

## 失败怎么处理

失败会 `throw`，文本首行是 `capture_screenshot failed [<code>]: …`，另有 `details:` 与 `hint:`。按 code 处理：

| code | 下一步 |
|---|---|
| `invalid_argument` | 按 hint 修参数；`out` 不能是绝对路径、`..` 或非 .png |
| `invalid_region` | 用 `capture_probe` 取该显示器的物理边界后重算，或改用 `target:"display"` |
| `workspace_unavailable` | 当前会话没有可写工作区；请用户在该工作区打开会话，不要自己猜目录 |
| `no_display` | 当前会话没有可用桌面（headless / 会话 0 / RDP 断开）；如实告知，不要重试成「成功」 |
| `permission_required` | macOS 去「系统设置 → 隐私与安全性」授予屏幕内容采集权限（Screen Recording）；Wayland 在授权对话框确认 |
| `backend_unavailable` | 缺系统工具或缺附件服务；跑 `capture_probe` 看 `backends[].missing` |
| `unsupported_target` | 该平台/会话不支持这个目标；按 hint 换支持的目标，不要硬试 |
| `window_not_found` | 窗口不存在、最小化或受保护；换成前台窗口或改用 `target:"display"`，不要假装截到了 |
| `capture_timeout` | 重试一次；仍超时就用 `target:"region"` 缩小范围 |
| `capture_failed` | 看 `details` 的 exitCode / stderrTail，再跑 `capture_probe` |
| `invalid_output` | 重试；连续失败按后端不可用处理并如实报告 |

`no_display`、`permission_required`、`backend_unavailable` 是环境事实，不要靠改参数硬凑成功。

## 诊断：capture_probe

只诊断，不截图、不写图片。它回答：有没有显示器、显示器物理边界与 id、有哪些后端与缺什么、权限状态、输出根是否可写、`skillStatus`，以及每个目标当前的支持等级（`targets`）。

- 不确定参数或显示器 id → 先 probe。
- 失败且 hint 指向环境 → 先 probe，再决定是否重试。
- `skillStatus` 为 `shadowed` 只说明引导技能被用户副本遮蔽，**工具照常可用**，不要因此停手。

## 支持边界

| 平台 / 会话 | display | window | region |
|---|---|---|---|
| Windows 10/11 console（单屏） | beta | beta | beta |
| Windows 多屏 / 混合 DPI / HDR | experimental | experimental | experimental |
| Windows RDP / 会话 0 / 安全桌面 | experimental | unsupported | experimental |
| macOS（Retina 与非 Retina） | experimental | experimental（需显式窗口 id） | experimental |
| Linux X11 | experimental | experimental（依后端） | experimental |
| Linux Wayland | experimental | unsupported | experimental（需 grim） |
| headless / CI | 一律 `no_display` | — | — |

- 0.2.0 起没有 `target:"all"`（录屏同样没有），传了会被拒绝；不支持的平台/目标必须如实报 `unsupported_target`，不得换低清后端假装成功。
- macOS、Linux X11 与 Wayland 都没有真机实测，只能标 experimental；不要对外声称「全平台支持」。
- 录屏只支持上表里 **Windows 10/11 单屏 console、SDR、非 RDP** 的 display/region，等级 beta；多屏、HDR、RDP、会话 0、window、macOS/Linux 录屏一律不支持或未验证，以 `capture_probe.recording.targets` 为准。
- 平台与权限的细节见 [references/troubleshooting.md](references/troubleshooting.md)。

## 反模式

- 用别的命令或脚本再实现一套截图/录屏（破坏单一执行路径）：尤其不要手写 FFmpeg、gdigrab 或循环截图拼视频。
- 把录屏 start/status 的中间态或临时文件当成交付物；只有 completed 的 `path` 才是成品。
- 抓全屏大图直接让模型读细字（应先 `target:"region"` 裁目标区域）。
- 用逻辑分辨率冒充物理像素，或先缩小再放大。
- 把 `skill_shadowed`、`quality_unverified` 当失败反复重试。
- 在 headless 或权限不足的环境里把失败包装成「已截图」「已录屏」。
