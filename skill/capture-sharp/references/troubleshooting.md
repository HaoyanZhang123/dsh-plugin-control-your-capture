# 症状 → 原因 → 修法（截图 + 录屏）

先调 `capture_probe`（不截图、不写图片）：显示器物理边界与 id、可用后端与缺失工具、权限、输出根可写性、每个目标的支持等级都在里面；录屏能力看并列的 `recording` 对象（`available/backend/grade/targets/missing/reason`）。

## 错误码速查

| code | 多半因为 | 怎么办 |
|---|---|---|
| `invalid_argument` | `maxWidth<=0`、`window` 配了非 window、`region` 配了非 region、`out` 绝对路径/含 `..`/非 .png | 按 hint 改参数组合与取值 |
| `invalid_region` | 缺 `region`、非整数、负坐标、宽高 ≤ 0、越出该显示器、跨屏 | 用 probe 的 `displays[].width/height` 重算；多屏分别截 |
| `workspace_unavailable` | 没有调用方 agent、没有工作区服务、会话无绝对工作目录、目录不可写 | 让用户在有工作区的会话里调用；不要自己猜目录 |
| `no_display` | headless、无会话桌面、会话 0、RDP 断开、无 `DISPLAY`/`WAYLAND_DISPLAY` | 如实报告；换有桌面的会话再试 |
| `permission_required` | macOS 屏幕内容采集权限缺失、Wayland Portal 拒绝或需要交互 | 见下方「平台与权限」表；Wayland 完成授权对话框 |
| `backend_unavailable` | 缺系统工具、后端未实现、没有附件服务 | 看 probe 的 `backends[].missing`，装上或换平台 |
| `unsupported_target` | 该平台/会话不支持 `window`、`region` 或 `all` | 按 probe 的 `targets` 换目标；`all` 在 0.2.0 不存在 |
| `window_not_found` | 窗口 id 不存在、已关闭、最小化、受保护内容、macOS 未给窗口 id | 给可解析的窗口 id 或换前台窗口；不要退化成全屏 |
| `capture_timeout` | 后端超过 `timeoutMs`，已清理进程树 | 重试一次；仍超时用 `target:"region"` 缩小范围 |
| `capture_failed` | 后端非零退出或原生调用异常 | 看 `details.exitCode` / `stderrTail`，再跑 probe |
| `invalid_output` | 文件为空、不是 PNG、缺 IEND、尺寸不符、附件库拒收、父目录不可写 | 重试；连续失败按后端不可用处理 |

`quality_unverified` 与 `skill_shadowed` **不是**失败码：前者说明无法证明输出为原生质量（图仍然交付），后者说明引导技能被用户副本遮蔽（工具照常可用）。

## 录屏：错误与状态速查

录屏失败同样 `throw`，首行为 `capture_recording failed [<code>]: …`，具体原因在 `details.reason`。

| code / state | 多半因为 | 怎么办 |
|---|---|---|
| `backend_unavailable`，`missing` 含 `ffmpeg`/`ffprobe`/`ddagrab`/`libx264` | 缺外部 FFmpeg（或版本不带 ddagrab / libx264） | 装带 ddagrab filter 与 libx264 的 FFmpeg；**截图不受影响**，别把它当截图失败 |
| `invalid_argument` / `recording_not_found` | id 来自旧 Host、抄错或来自别处 | DSH/插件重启后旧 id 一律失效；重新 `start` |
| `invalid_argument` / `recording_workspace_mismatch` | 在另一个工作区操作别人的 recordingId | 用发起 `start` 的同一工作区；不要跨工作区猜路径 |
| `invalid_argument` / `recording_already_active` | 本插件实例已有活动录制 | 先 `stop` 或 `cancel` 那个会话，再 start |
| `invalid_argument` / `recording_state_conflict` | 对 failed/cancelled 再 stop，或 stop/cancel 互抢 | `status` 看终态；failed+cancel 可重试清理，其它不要再停 |
| `invalid_region` / `region_odd_dimensions` | region 宽或高是奇数 | 改成偶数物理像素；工具不会补边或缩放 |
| `invalid_region` / `region_out_of_bounds` | region 越出显示器 | 用 probe 的物理 bounds 重算，不能跨屏 |
| `capture_timeout` / `startup_timeout` | 启动 10s 内 FFmpeg 未就绪或立即失败 | 跑 probe 看 recording.missing；重试一次，仍失败如实报告 |
| `capture_timeout` / `stop_timeout` | q 后 15s 内 FFmpeg 仍未退出 | 该 MP4 未被封装/校验，**不是成品**；重新录 |
| `capture_failed` / `unexpected_exit` | 录制中 FFmpeg 自行退出（含 exit 0） | 看 `details.stderrTail`；会话已 failed，重新 start |
| `invalid_output` | 尺寸/帧数/帧率/完整解码/封装任一不合格 | 该文件不作为成品交付；重录或换更小 region |
| `starting` / `recording` / `stopping` | 还没结束，不是错误 | 用同一个 recordingId 轮询 `status`；**没有交付物** |

录屏症状：

| 现象 | 原因 | 修法 |
|---|---|---|
| 实测帧率明显偏低 | 机器负载、画面复杂度或驱动；工具不会自动降档或回退 gdigrab | 如实报告实测 fps；需要时可缩小 region 或降到 30fps 档，**不要**声称已 60fps |
| `stop` 很慢或超时 | stop 要等封装 + FFprobe + 完整解码 | 等它返回；超时按 `capture_timeout` 如实报告，不要把临时文件当成品 |
| MP4 不如同区域 PNG 锐 | yuv420p 有损编码，色度抽样可能改变彩色边缘 | 不承诺无损或与 PNG 逐像素一致；要逐像素对照就用截图 |
| 多屏 / HDR / RDP / 会话 0 / window 录不了 | 0.3.0 只支持 Windows 单屏 console 的 display/region（beta） | 看 `recording.targets`，明确告诉用户这些环境未验证 |
| 录屏进程被强杀后留下孤儿/临时文件 | 未实现 Job Object，硬崩溃清理不保证 | 手动结束残留 FFmpeg 并删除 `.tmp-*.mp4`；如实说明 |

## 平台与权限

| 现象 | 原因 | 修法 |
|---|---|---|
| Windows 截图全黑或直接 `no_display` | 锁屏、UAC 安全桌面、RDP 断开或会话 0 | 保持会话解锁并在交互桌面里调用；这些环境不承诺成功 |
| Windows 尺寸比预期小一半 | 用了不声明 DPI 感知的旧采集方式 | 只用 `capture_screenshot`；本工具的后端按物理像素采集 |
| Windows 多屏 / 混合 DPI / HDR 结果不确定 | 这些分支没有真机证据，只能是 experimental | 需要稳定结果时先只对单屏声明；如实说明等级 |
| macOS 截图全黑或 `permission_required` | 首次调用前没有屏幕录制权限 | 授权后重试；权限只在真正截图时才可判定 |
| macOS 窗口目标 `unsupported_target` | 无法非交互枚举窗口 id | 传显式窗口 id；拿不到就截显示器再裁区域 |
| Linux X11 报 `no_display` | 没有 `DISPLAY`（SSH、CI、纯 Wayland） | 在图形会话里调用；Wayland 请走 Portal/grim |
| Linux 报 `backend_unavailable` | 缺 maim / scrot / import（Wayland 还缺 Portal 或 grim） | 装上缺失工具；probe 会指出缺哪几个 |
| Wayland 弹授权或无响应 | Portal 需要用户确认，且没有 region API | 完成授权；region 需要 grim，没有就截显示器 |
| 抓浏览器 / Electron 窗口得到纯色图，`warnings` 带 `content_uniform` | 该窗口是 GPU 合成的，合成层抓不到（PrintWindow 返回空内容） | **别当成截到了**：改用 `target:"display"` 或 `target:"region"`；并把这一限制告诉用户 |

## 尺寸与清晰度

| 现象 | 原因 | 修法 |
|---|---|---|
| 模型读不准细节 | 全屏大图进入模型时被附件库**按像素预算等比缩小**（本机 3072×1920 → 约 2590×1619，重编码为 JPEG 或 WebP，实测是 WebP；以 `image.width` / `image.height` 为准） | 用 `target:"region"` 裁出目标区域；`warnings` 里有 `model_image_downscaled` 就说明发生了降采样 |
| 文件尺寸对但模型说看不清 | 把 `width`/`height`（文件）当成了 `image.width`/`image.height`（模型可见） | 分别读两对尺寸，按模型可见尺寸判断 |
| 想放大却得不到更大的图 | 工具永不放大，`maxWidth` 只缩小 | 提高显示器分辨率或裁更小的区域，不要要求放大 |
| 尺寸对但文字仍发虚 | 采集后被二次缩放 | 只用本工具，不要再手动缩放一次 |
| 图整幅发黑或纯色，但调用是成功的 | 后端检测到近似单一颜色（受保护内容、空窗口、最小化） | 看 `warnings` 里的 `content_uniform`；图仍交付，但要如实告诉用户"这很可能不是想截的内容"，再换目标或让窗口可见 |
| 截图糊、字发虚，但尺寸看着对 | 先分清是**页面截图**还是**屏幕截图**：无头/离屏/最小化页面不在屏幕上，本工具抓的只是当时屏幕内容；另一种是把页面按 `deviceScaleFactor:1` 渲染后当屏幕图用（2× 屏上只有一半分辨率） | 页面在屏幕上就用本工具（`window`/`display`，细字用 `region`）；页面不在屏幕上就用渲染侧截图并把 DPR 设成 `capture_probe` 的 `scaleFactor`（本机 2），输出 PNG 别再缩放 |

## 不要这样做

- 手写 PowerShell、AppleScript、FFmpeg、gdigrab 或任何采集命令绕过工具（那会成为第二套执行路径）。
- 把录屏 `starting/recording/stopping` 的返回或 `.tmp-*.mp4` 当成交付物；只有 completed 的 `path` 才是成品。
- 在 `no_display` / `permission_required` 下反复重试，或把失败写成「已截图」「已录屏」。
- 把 `target:"all"` 当成可用目标。
- 对外宣称「全平台支持」或「无损录屏」——没有真机实测的平台只能 experimental，MP4 是 yuv420p 有损。
