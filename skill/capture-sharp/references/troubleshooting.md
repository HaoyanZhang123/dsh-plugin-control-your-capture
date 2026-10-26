# 症状 → 原因 → 修法

先跑 `shot.ps1 -Mode probe`，多数问题在这一步就能判定。
本文件只管"抓得对不对"；成片编码、缩放、字幕参数属于项目工作流，不放这里。

## 截图

| 症状 | 原因 | 修法 |
|---|---|---|
| 截图只有 1536×960 之类的小图 | 进程没声明 DPI 感知 | 用 `scripts/shot.ps1`，别手写 `CopyFromScreen` |
| 尺寸对但文字仍软 | 抓完又缩了两次以上 | 只缩一次，`-Scale` / Lanczos |
| 全黑 | 锁屏 / UAC 安全桌面 / 远程会话断开 | 保持会话解锁；RDP 最小化时抓不到 |
| 窗口空白 | 用了 `PrintWindow`，Chromium/Electron 硬件加速下返回空 | 用 `-Mode window`（全屏抓取后裁窗口矩形） |
| 窗口缺一圈 | 窗口矩形 vs 客户区 | 要内容用 `-Client`，要含边框用默认 |
| 只抓到主屏 | 用了 `PrimaryScreen` | 脚本用 `VirtualScreen`，多屏（含负坐标）都覆盖 |
| 别人的机器没这个现象 | 那台机器缩放 100%，naive 截图本来就等于物理像素 | 正常；本技能只在缩放 >100% 时才"救回"像素，同时仍改善录屏帧率与网页 2x |
| 区域坐标对不上 | 把逻辑坐标当物理坐标 | `-Mode region` 全是物理像素；逻辑值 × (DPI/96) |

## 录屏

| 症状 | 原因 | 修法 |
|---|---|---|
| 帧率只有 ~20，拖动发顿 | 走了 gdigrab | 确认 probe 的 `DDAGRAB=True`；别加 `-Backend gdi` |
| 录成 1080p 但很软 | 用 `-video_size 1920x1080` 录 3K 屏 | 录原生分辨率；要 1080p 用 `-To1080p` |
| 全黑 | 驱动不支持 Desktop Duplication / 安全桌面 | `-Backend gdi` 兜底，并告知帧率下降 |
| 没有鼠标 | 默认不画鼠标 | 加 `-DrawMouse` |
| 文件巨大 | CRF 太低 + 60fps | 静态内容 `-Crf 16~18` 或 30fps |
| 录屏直接报错 / probe 显示 VIDEO_BACKEND=none | 没装 ffmpeg | 装完再录：`winget install Gyan.FFmpeg` / `brew install ffmpeg` / `apt install ffmpeg`；截图不受影响 |

## 网页

| 症状 | 原因 | 修法 |
|---|---|---|
| 页面文字比系统 UI 虚 | 1× 光栅化 | `page.ps1 -Scale 2` |
| 截掉一截 | headless 只截视口 | 加大 `-Height`，或 CDP `captureBeyondViewport` |
| 中文变方块 | 字体缺失 | 指定已安装字体 |
| 图没出来 | 异步未完成 | 加 `-VirtualTimeBudgetMs 4000` |
| 找不到浏览器 | 只有 Edge / 非标准安装 | 看 probe 的 `BROWSER=`，或 `-Browser <path>` |

## macOS / Linux 专有

| 症状 | 原因 | 修法 |
|---|---|---|
| `capture.sh: unsupported platform` | 在 Windows 上调用了 POSIX 脚本 | Windows 用 `shot.ps1` / `rec.ps1` |
| macOS 截图全黑 / 弹权限窗 | 终端没有「屏幕录制」权限 | 系统设置 → 隐私与安全性 → 屏幕录制，勾选终端或 DSH 后重启终端 |
| macOS 录屏录到摄像头 | `--index` 指错设备 | 先 `capture.sh probe` 看 `SCREEN_DEVICE=` 的编号 |
| Linux 截图报 no screenshot tool | 缺工具 | Wayland: `apt install grim`；X11: `apt install gnome-screenshot` 或 imagemagick/ffmpeg |
| Linux 录屏尺寸未知 | 无 `xrandr` 或纯 Wayland | 显式传 `--region x,y,w,h` |
| Wayland 下 x11grab 录不到 | x11grab 只适用 X11 | 用 grim / wf-recorder，或切 X11 会话 |

## 模型看不清

| 症状 | 原因 | 修法 |
|---|---|---|
| 模型读不准细节 | 整屏图被规范化到 ~4.2MP（3072×1920 → ~2590×1619） | 用 `-Mode window` / `-Mode region` 裁区域再发 |
| 同一张图说法不一 | 压缩/重采样差异 | 发 PNG、裁小、避免细字号 |

## 交付前

- [ ] probe 跑过，知道 `SCREEN_PHYSICAL` / `DDAGRAB`
- [ ] 全屏截图 `output=` == `SCREEN_PHYSICAL`
- [ ] 录屏 `width` == 物理宽，`avg_frame_rate` ≥ 50（或已如实说明）
- [ ] 网页 `expect=` == `output=`