# Changelog

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
