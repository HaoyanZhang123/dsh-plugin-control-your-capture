<p align="center"><a href="./README.md">中文</a> | <a href="./README.en.md">English</a></p>

<h1 align="center">dsh-plugin-control-your-capture</h1>

<p align="center">把高清截屏与录屏装进 DSH：按物理像素采集，按目标尺寸缩放。</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node-%E2%89%A5%2018-339933?logo=nodedotjs&logoColor=white" alt="Node 18+"></a>
  <a href="https://learn.microsoft.com/powershell/"><img src="https://img.shields.io/badge/PowerShell-5.1%2B-5391FE?logo=powershell&logoColor=white" alt="PowerShell 5.1+"></a>
  <a href="https://ffmpeg.org/"><img src="https://img.shields.io/badge/ffmpeg-recording-007808?logo=ffmpeg&logoColor=white" alt="ffmpeg"></a>
  <a href="https://www.chromium.org/Home/"><img src="https://img.shields.io/badge/Chrome%20%7C%20Edge-page%20capture-4285F4?logo=googlechrome&logoColor=white" alt="Chrome 与 Edge"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-2ea44f" alt="许可证 MIT"></a>
</p>

## 简介

高 DPI 屏上截图发虚，通常不是编码问题，而是采样问题：屏幕的物理像素远多于逻辑像素。

在一台 3072×1920、系统缩放 200% 的 Windows 上实测：未声明 DPI 感知的进程只能采到 1536×960，
再放进 1080p 成片就必须放大，文字锐度实测相差 8 倍；同一块屏幕上 gdigrab 录屏只有约 19 fps，
而 Desktop Duplication 可以跑到约 58 fps。

本插件把这件事固定成脚本与技能：挂载时把 capture-sharp 安装到 DSH 全局技能目录，
之后任何工作区、任何会话都能直接用；agent 照着脚本调，不必每次重新发明采集方式。

## 核心特性

- **按物理像素截图**：Windows 走 .NET GDI+，macOS 走 screencapture，Linux 走 grim / gnome-screenshot / ImageMagick；支持全屏、窗口、客户区、区域与高质量缩放。
- **录屏保原生分辨率与高帧率**：Windows 优先 ddagrab（Desktop Duplication），失败回退 gdigrab 并如实报帧率；macOS 用 avfoundation，Linux 用 x11grab。
- **网页按目标尺寸光栅化**：用 --target-width 表达目标宽度，缩放由「目标宽 / CSS 宽」推导，不写死倍数。
- **一条命令自检**：probe 输出屏幕物理尺寸、DPI、VIDEO_BACKEND 与 DDAGRAB，先确认能力再拍。
- **缺 ffmpeg 时优雅降级**：截图与网页截图照常工作，只有录屏不可用，并给出三平台安装命令。
- **零运行时依赖**：只用 Node 内置模块，不注册第二个 skill provider，装完即用。

### 平台与依赖

| 能力 | Windows | macOS | Linux | 无 ffmpeg |
|---|---|---|---|---|
| 截图 | .NET GDI+ | screencapture | grim / gnome-screenshot / ImageMagick | 正常 |
| 网页截图 | Chrome/Edge + Node | 同左 | 同左 | 正常 |
| 录屏 | ffmpeg | ffmpeg | ffmpeg | 不可用 |
| 缩放 | 内置 | sips | ImageMagick 或 ffmpeg | Linux 需 ImageMagick |

采集能力在 Windows 10/11 上实测通过；macOS 与 Linux 路径已实现但未在真机验证，
脚本会先运行 probe 报告可用工具，缺什么直接说明。

## 安装

前提：已安装 DSH；网页截图需要 Node 18+ 与 Chrome/Edge；录屏需要 ffmpeg（可选）。

```bash
dsh plugin add dsh-plugin-control-your-capture
```

安装后重启一次 DSH。插件挂载时会把技能复制到 `$DSH_HOME/skills/capture-sharp`，
任何工作区、任何会话都能看到它。

## 使用方式

装好后可以直接用自然语言触发：「截个图」「录一段屏」「这个画面好糊」「给演示视频抓点素材」。

```powershell
# Windows：先自检，再截图
powershell -File "$DSH_HOME\skills\capture-sharp\scripts\shot.ps1" -Mode probe
powershell -File "$DSH_HOME\skills\capture-sharp\scripts\shot.ps1" -Out .\shot.png
```

```bash
# macOS / Linux
bash "$DSH_HOME/skills/capture-sharp/scripts/capture.sh" probe
bash "$DSH_HOME/skills/capture-sharp/scripts/capture.sh" shot --out ./shot.png

# 网页截图（全平台）
node "$DSH_HOME/skills/capture-sharp/scripts/page.mjs" --url https://example.com \
  --out ./page.png --width 960 --height 540 --target-width 1920
```

```powershell
# 录屏：原生分辨率；需要 1080p 时按比例缩进目标框
powershell -File rec.ps1 -Out .\rec.mp4 -Seconds 20
powershell -File rec.ps1 -Out .\rec1080.mp4 -Seconds 20 -ScaleTo 1920x1080
```

完整的命令表、验收方式与排错见技能内的 SKILL.md 与 references/troubleshooting.md。

## 配置

默认安装到 `$DSH_HOME/skills`。要换位置，二选一：

- 环境变量 `DSH_CAPTURE_SKILL_ROOT`
- cordis.patch.yml 里给本插件行加 `config: { skillRoot: '...' }`

升级时整目录替换，避免旧脚本残留；已存在但非本插件安装的同名技能不会被覆盖。

## 项目结构

```text
lib/index.js            插件入口：挂载时安装配套技能
cordis.patch.yml        插件行声明
skill/capture-sharp/    随包技能（SKILL.md、scripts、references）
```

## 更新与发布

版本记录见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT](LICENSE)。
