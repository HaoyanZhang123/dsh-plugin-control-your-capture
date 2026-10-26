# dsh-plugin-control-your-capture

> 高清截屏 / 录屏 —— 把 **capture-sharp** 技能装进 DSH。
> 修掉"高 DPI 屏上截图、录屏总是发虚"这个根因，而不是在主流程里做后期锐化。

## 它解决的问题

屏幕的**物理像素**远多于逻辑像素。以 3072×1920 / 200% 缩放的 Windows 为例：

| | 结果 |
|---|---|
| 声明了 DPI 感知的进程截图 | 3072×1920 |
| 未声明的进程（\`powershell.exe\` 默认） | **1536×960**，被系统缩了一半 |
| 后者放大进 1080p 成片 | 必然发虚（实测锐度差 8 倍） |

同类问题还有三处：录屏走 gdigrab 在 3K 上只有 ~19fps；网页按 1x 光栅化；后期先缩后放。
本插件把这四条一次性固定成脚本，agent 只要照着调，不需要每次重新发明。

## 换台机器 / 换块屏会怎样

技能里没有任何硬编码分辨率：脚本读的是系统上报的物理像素，所以换屏幕、换缩放比例都对。
不同配置下的实际差别：

| 屏幕 / 缩放 | 逻辑像素 | 本技能拿到 | 和手写脚本比 |
|---|---|---|---|
| 1920×1080 @100% | 1920×1080 | 1920×1080 | 一样（本来就不糊，收益在录屏帧率与网页 2x） |
| 2560×1440 @125% | 2048×1152 | 2560×1440 | 多 1.6 倍像素 |
| 3072×1920 @200%（本机） | 1536×960 | 3072×1920 | 多 4 倍像素 |
| 3840×2160 @150% | 2560×1440 | 3840×2160 | 多 2.25 倍像素 |
| MacBook Retina 1440×900 逻辑 | 1440×900 | 2880×1800 | 多 4 倍像素 |

两条注意：

1. **100% 缩放的机器上不会看到"变大"**——因为那边本来就没被缩过。这类机器上本技能的价值是：录屏帧率（gdigrab → ddagrab）和网页 2x。
2. **多屏不同缩放**（比如 4K 200% + 1080p 100%）：脚本按 per-monitor v2 感知抓整个虚拟桌面，输出是各屏物理像素拼接，窗口可能在同一张图里跨越不同缩放——这是 Windows 的合成结果，不是脚本问题。

## 安装

\`\`\`bash
# 方式一：从 npm 安装到当前 profile（推荐）
dsh plugin add dsh-plugin-control-your-capture

# 方式二：本地开发（link 到本仓库）
cd <本仓库> && npm link
dsh plugin add dsh-plugin-control-your-capture
\`\`\`

装好后**重启一次 DSH**（或重开 profile），插件挂载时会把 \`skill/capture-sharp\` 复制到
\`$DSH_HOME/skills/capture-sharp\`，随后任何工作区、任何会话都能看到这个技能。

## 用起来

技能一旦装上，直接说人话即可触发：**"截个图"／"录一段屏"／"这个画面好糊"／"给演示视频抓点素材"**。

也可以显式指定：

\`\`\`
用 capture-sharp 截图，录 Windows 上那个浏览器窗口
\`\`\`

脚本按平台自动选择：

| 平台 | 截屏 | 录屏 | 网页 |
|---|---|---|---|
| Windows | \`scripts/shot.ps1\`（probe / full / window / region / scale） | \`scripts/rec.ps1\`（ddagrab 优先） | \`scripts/page.mjs\` |
| macOS / Linux | \`scripts/capture.sh shot\` | \`scripts/capture.sh rec\` | \`scripts/page.mjs\` |

## 平台支持与验证状态

| 平台 | 状态 |
|---|---|
| Windows 10/11（PowerShell 5.1+，ffmpeg 可选） | **已实测**：截图 3072×1920、ddagrab 录屏 58fps、网页 2x 1920×1080 |
| macOS（screencapture / avfoundation） | 已实现，**未在真机验证**；首次录屏需给终端"屏幕录制"权限 |
| Linux（X11 x11grab / Wayland grim） | 已实现，**未在真机验证**；缺工具时会明确报出要装什么 |

在未验证平台上，脚本会先跑 \`probe\` 报告可用工具，缺什么直接告诉你，不会静默产出坏素材。

## 依赖

| 能力 | Windows | macOS | Linux | 没有 ffmpeg 时 |
|---|---|---|---|---|
| 截图 | .NET GDI+（系统自带） | screencapture（系统自带） | grim / gnome-screenshot / ImageMagick | 正常 |
| 网页截图 | Chrome/Edge + Node | 同左 | 同左 | 正常 |
| 录屏 | ffmpeg | ffmpeg | ffmpeg | **不可用**（脚本明确报错并给安装命令） |
| 缩放 | 内置 | sips（自带） | ImageMagick 或 ffmpeg | Linux 上需要 ImageMagick |

`probe` 会直接给结论：`VIDEO_BACKEND=ffmpeg` 或 `VIDEO_BACKEND=none`。
**没有 ffmpeg 只影响录屏**，截图和网页 2x 照常工作。

## 尺寸语义

`-ScaleTo` 是按比例装进目标框、不拉伸：16:10 的屏缩到 1920x1080 会得到 1728x1080。要精确 1920x1080，先用 `-Region` 裁成 16:9。

## 配置

默认装到 \`$DSH_HOME/skills\`。要换位置，二选一：

- 环境变量 \`DSH_CAPTURE_SKILL_ROOT\`
- \`cordis.patch.yml\` 里给本插件行加 \`config: { skillRoot: '...' }\`

## 卸载

\`\`\`bash
dsh plugin remove dsh-plugin-control-your-capture
rm -rf "$DSH_HOME/skills/capture-sharp"     # 插件不会自动删（避免误删你自己放的同名技能）
\`\`\`

## 设计要点

- **零运行时依赖**：只用 \`node:fs/path/os\`，装完即用，Windows/macOS/Linux 一致。
- **不抢 skill provider**：不注册第二个 \`skill-filesystem\`，只落目录，避免 providerName 冲突。
- **覆盖策略保守**：只覆盖带本插件 marker 的副本；你自己放的同名 skill 一律不动。
- **版本升级整目录替换**：避免旧脚本残留造成"以为更新了其实没更新"。
