# 症状 → 原因 → 修法（只覆盖截图）

先调 `capture_probe`（不截图、不写图片）：显示器物理边界与 id、可用后端与缺失工具、权限、输出根可写性、每个目标的支持等级都在里面。

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

## 不要这样做

- 手写 PowerShell、AppleScript 或任何采集命令绕过工具（那会成为第二套执行路径）。
- 在 `no_display` / `permission_required` 下反复重试，或把失败写成「已截图」。
- 把 `target:"all"` 当成可用目标。
- 对外宣称「全平台支持」——没有真机实测的平台只能 experimental。
