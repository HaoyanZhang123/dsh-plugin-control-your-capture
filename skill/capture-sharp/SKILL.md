---
name: capture-sharp
description: "高清截屏/录屏（Windows / macOS / Linux）：按物理像素抓全屏、窗口、区域，网页按 2x 光栅化，录屏保原生分辨率与高帧率，最后只做一次高质量缩放。Use when 用户说截图、录屏、屏幕录制、演示素材、画面发虚、模糊、不清晰、DPI、网页截图，or when producing screenshots/screen recordings for docs, demos or videos on high-DPI screens. Not for 成片剪辑/字幕/配音（在项目工作流里用 ffmpeg）。"
---

# capture-sharp

`一句话`：屏幕的物理像素 = 逻辑像素 × 系统缩放比（200% 就是 2 倍）。
**按逻辑像素抓屏等于只抓一半**，之后怎么编码都补不回来。
本机数字一律以 `probe` 输出为准，不要照抄任何示例值。

## 平台路由（先看这张表）

| 平台 | 截屏 | 录屏 | 网页 | 环境自检 |
|---|---|---|---|---|
| Windows | `scripts/shot.ps1` | `scripts/rec.ps1` | `scripts/page.mjs` | `shot.ps1 -Mode probe` |
| macOS / Linux | `capture.sh shot` | `capture.sh rec` | `scripts/page.mjs` | `capture.sh probe` |

Windows 脚本用 PowerShell 5.1 即可；POSIX 脚本用 bash。网页截图全平台共用 Node。

## 硬规则

1. **只用本技能的脚本**，不要手写 `CopyFromScreen` / `ffmpeg -f gdigrab` / `Page.startScreencast`。
2. **抓物理像素**：Windows 全屏截图的 `output=` 必须等于 probe 的 `SCREEN_PHYSICAL`（缩放在 100% 时两者本来就相等，属正常，不代表脚本没生效）；
   macOS/Linux 的 `output=` 必须等于屏幕物理分辨率（Retina 下是逻辑点数 ×2）。
3. **素材像素 ≥ 成片像素**，缩放只做一次（Lanczos），禁止先缩后放。
4. **录屏保原生分辨率**：Windows 走 ddagrab（gdigrab 在 3K 上只有 ~19fps）；macOS 走 avfoundation；Linux 走 x11grab。
5. **网页按 `deviceScaleFactor: 2`**，不要 1x 抓完再放大。
6. **Windows 的 .ps1 含中文必须存 UTF-8 BOM**，否则 PowerShell 5.1 按 GBK 解析直接语法错。

## 三步

**1) probe**

```powershell
# Windows
powershell -NoProfile -ExecutionPolicy Bypass -File <skill>\scripts\shot.ps1 -Mode probe
```

```bash
# macOS / Linux
bash <skill>/scripts/capture.sh probe
```

看 `SCREEN_PHYSICAL`（Windows）/ `PLATFORM`、`TOOL_*`（POSIX）、`DDAGRAB`（Windows）。
Windows 上 `DDAGRAB=False` 时别承诺 60fps，改 `rec.ps1 -Backend gdi` 并如实说明帧率会掉。

**2) capture**

Windows：

| 需求 | 命令 |
|---|---|
| 全屏 | `shot.ps1 -Out shots\full.png` |
| 指定窗口 | `shot.ps1 -Mode window -Title "Notepad" -Out shots\win.png` |
| 窗口客户区 | `shot.ps1 -Mode window -Title "..." -Client -Out shots\client.png` |
| 任意区域（物理像素） | `shot.ps1 -Mode region -X 600 -Y 200 -W 1600 -H 900 -Out shots\crop.png` |
| 要小图 | `shot.ps1 -Scale 0.5 -Out shots\half.png` |
| 录屏 | `rec.ps1 -Out rec\a.mp4 -Seconds 20` |
| 录屏出 1080p | `rec.ps1 -Out rec\a1080.mp4 -Seconds 20 -To1080p` |

macOS / Linux：

| 需求 | 命令 |
|---|---|
| 全屏 / 指定显示器 | `capture.sh shot --out f.png [--display 1]` |
| 区域 | `capture.sh shot --out f.png --region x,y,w,h` |
| 要小图 | `capture.sh shot --out f.png --scale 0.5` |
| 录屏 | `capture.sh rec --out f.mp4 --seconds 20 --fps 60` |
| 录屏出 1080p | `capture.sh rec --out f.mp4 --to1080p` |
| macOS 录屏设备号 | `capture.sh rec --index 2`（先 probe 看 `SCREEN_DEVICE`） |

全平台网页（2x）：

```bash
node <skill>/scripts/page.mjs --url "https://example.com" --out pages/home.png --width 960 --height 540 --scale 2
```

**3) verify**（必须做）

- 截图：回显 `output=` 必须等于屏幕物理分辨率。
- 录屏：`ffprobe -v error -select_streams v:0 -show_entries stream=width,height,avg_frame_rate -of default=nw=1 out.mp4`
  —— `width` 必须是物理宽；`avg_frame_rate` 接近 60，掉到 20 说明走错了后端。
- 网页：`expect=` 与 `output=` 必须一致（960×540 @2x → 1920×1080）。

## 输出契约

- `shot.ps1`：`dpiAware=True screen=<物理宽>x<物理高> mode=full output=<同左> path=...`（示例：3072x1920）
- `capture.sh shot`：`shot platform=macos output=WxH path=...`
- `rec.ps1` / `capture.sh rec`：一行 backend/device + 一行尺寸/帧率
- `page.mjs`：`page scale=2 css=960x540 expect=1920x1080 output=1920x1080 path=...`

## 出问题

见 [references/troubleshooting.md](references/troubleshooting.md)：黑屏、空窗口、掉帧、坐标错位、macOS 录屏授权、模型看不清。

## 反模式

- 手写 PowerShell / AppleScript 截图不声明 DPI（会拿到逻辑分辨率）
- Windows 上 `-video_size 1920x1080` 录 3K 屏
- `deviceScaleFactor:1` 抓网页再放大
- 静帧先缩 1080p 再 zoompan
- 把整屏大图直接丢给模型看细节（应裁区域）
