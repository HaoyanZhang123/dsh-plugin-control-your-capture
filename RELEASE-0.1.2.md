本次发布把 capture-sharp 技能装进 DSH：截图与录屏按物理像素采集，网页截图按目标尺寸推导缩放。

## 变更概览

新增 6 项

## 新增

- **一键安装**：插件挂载时把配套技能安装到 `$DSH_HOME/skills/capture-sharp`，之后任何工作区、任何会话可用；版本升级整目录替换，不覆盖你自己放的同名技能。
- **截图**：Windows（.NET GDI+）、macOS（screencapture）、Linux（grim / gnome-screenshot / ImageMagick），支持全屏、窗口、客户区、区域与高质量缩放。
- **录屏**：Windows 优先 ddagrab（Desktop Duplication），失败回退 gdigrab 并如实报帧率；macOS 用 avfoundation，Linux 用 x11grab；`-ScaleTo` / `--scale-to` 按比例缩进目标框。
- **macOS 与 Linux 支持**：同一套命令语义，按平台自动选用系统工具。
- **网页截图按目标尺寸**：`--target-width` 由「目标宽 / CSS 宽」推导缩放，不再写死 2x。
- **自检与降级**：probe 输出屏幕物理尺寸、DPI、`VIDEO_BACKEND` 与 `DDAGRAB`；没有 ffmpeg 时只禁用录屏，截图与网页截图照常，并给出三平台安装命令。

## 重要说明

- macOS 与 Linux 采集路径已实现并做过语法与降级检查，**未在真机验证**；macOS 首次录屏需授予「屏幕录制」权限。
- 没有 ffmpeg 时录屏不可用，截图与网页截图不受影响。
- `-ScaleTo` 是按比例装进目标框、不拉伸：16:10 的屏缩到 1920×1080 会得到 1728×1080，要精确 16:9 需先裁切。
- 不含音频采集。
