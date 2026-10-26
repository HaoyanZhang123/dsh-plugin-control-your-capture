# Changelog

## 0.1.3

- README 图片改用 raw.githubusercontent 绝对地址，npm 页面也能正常显示。
- 终端截图换成不含本机路径的输出实录；补充 repository/homepage/bugs 字段。

## 0.1.2

- 缩放不再写死：page.mjs 新增 --target-width，按 目标宽/CSS宽 推导 device scale factor；
  --scale 保留为显式覆盖，两者都不给时才用默认 2 并在输出里标注 default。
- rec.ps1 的 -To1080p 泛化为 -ScaleTo 1920x1080（任意 WxH），旧参数保留为别名。
- capture.sh rec 同步支持 --scale-to WxH（--to1080p 仍是别名）。
- 文档把「网页按 2x」改写成公式，避免把默认值当成规则。

## 0.1.1

- `probe` 增加 `VIDEO_BACKEND=ffmpeg|none`，直接暴露有没有 ffmpeg。
- 缺 ffmpeg 时 `rec.ps1` 给出可读错误与三平台安装命令，不再抛 PowerShell 原始异常。
- `capture.sh` 的尺寸校验在缺 ffprobe 时回退到 `file(1)`。
- 文档补依赖矩阵：没有 ffmpeg 只影响录屏，截图与网页 2x 不受影响。

## 0.1.0

首个版本。

- 插件挂载时把 `skill/capture-sharp` 安装到 `$DSH_HOME/skills`（带 marker，版本升级整目录替换）。
- 随包技能覆盖三类平台：
  - Windows：`shot.ps1`（probe / full / window / region / scale）、`rec.ps1`（ddagrab 优先，可 `-To1080p`）。
  - macOS / Linux：`capture.sh`（probe / shot / rec，缺工具时明确报错）。
  - 全平台：`page.mjs`（Chrome/Edge/Chromium 2x 光栅化）。
- 零运行时依赖，不注册第二个 skill provider。
- 验证状态：Windows 路径已实测（3072×1920 截图、ddagrab 58fps、网页 2x 1920×1080）；
  macOS / Linux 路径已实现但未在真机验证。
