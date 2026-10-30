## 中文

本次更新为截图插件加入 Windows 单屏录屏：新增 `capture_recording` 工具，`capture_probe` 增加录屏能力诊断，截图行为不回归。

**变更概览**：新增 3 项 · 优化 1 项 · 修复 1 项

**新增**

- `capture_recording`：`start` / `status` / `stop` / `cancel`，把 `display` 或物理像素 `region` 录成 MP4；`path` 只在 `completed` 出现，并带实测尺寸、帧率、时长、帧数与像素格式。
- `capture_probe.recording`：报告 `available` / `backend` / `grade` / `targets` / `missing` / `reason`；缺 FFmpeg 只影响录屏，截图照常可用。
- 新配置 `recordingMaxDurationSec`（默认 3600，整数 1–86400），到点由 Host 自动正常收尾。

**优化**

- Windows 单屏 console 的 display / region 录屏等级为 beta，附本机真机证据：3072×1920 @ 57.71fps、800×500 @ 56.56fps、长录制 126.4s，均 1 video / 0 audio 且 `-xerror` 完整解码通过。

**修复**

- 输出 Schema 补齐 `drawMouse`：此前录屏回执会因未声明字段被工具输出校验拒收（由真机工具链路自检发现）。

**重要说明**

- 录屏仅 Windows 单屏 console：无音频、无 window / 多屏 / HDR / RDP，macOS 与 Linux 不提供录制；MP4 为 `yuv420p` 有损，不与 PNG 逐像素一致。
- 升级方式：卸载旧版 → 安装 0.3.0 → 重启 DSH。

## English

This release adds single-display Windows recording to the screenshot plugin: a new `capture_recording` tool, recording diagnostics in `capture_probe`, and no regression for screenshots.

**Summary**: Added 3 · Improved 1 · Fixed 1

**Added**

- `capture_recording`: `start` / `status` / `stop` / `cancel`, recording a `display` or a physical-pixel `region` to MP4; `path` appears only on `completed`, together with measured size, frame rate, duration, frame count and pixel format.
- `capture_probe.recording`: reports `available` / `backend` / `grade` / `targets` / `missing` / `reason`; a missing FFmpeg only affects recording, screenshots keep working.
- New `recordingMaxDurationSec` option (default 3600, integer 1–86400) that finalizes normally at the limit.

**Improved**

- Display / region recording on a single-display Windows console is beta, backed by real-machine evidence: 3072x1920 at 57.71fps, 800x500 at 56.56fps and a 126.4s recording, all 1 video / 0 audio and passing a full `-xerror` decode.

**Fixed**

- The output schema now declares `drawMouse`; without it the host rejected the tool's own recording receipts (found by a real-tool self-check).

**Important notes**

- Recording is Windows single-display console only: no audio, no window / multi-display / HDR / RDP, and no recording on macOS or Linux; MP4 is lossy `yuv420p` and not pixel-identical to PNG.
- Upgrade: uninstall the old version, install 0.3.0, restart DSH.
