# Changelog

## 0.2.2

**文档更新**（采集行为未变）

- README（中英）新增「为什么差这么多」：解释高 DPI 下按逻辑像素采集为何不可逆地丢信息，
  并说明 75×/28× 这两个倍率的来源与适用边界（极端高频靶 vs 普通正文）。
- README 新增实测延迟：全屏约 812 ms、区域 800×500 约 681 ms（各 20 次取中位数，Windows 11 / 3072×1920 / 200% 缩放），
  并明确「赢在保真，不在快」。
- 新增受控对比图 `assets/compare-native-vs-logical.webp`（物理像素 vs 逻辑像素）。

## 0.2.1

**文档与说明更新**（采集行为未变，无破坏性变更）

- 补记已知限制：`target:"window"` 对 **GPU 合成的窗口**（Chrome / Electron 等）可能返回空白图——合成层抓不到，结果是纯色而非窗口内容。
  该情形会带 `content_uniform` 警告；看到它就别把结果当成"截到了"，改用 `target:"display"` 或 `target:"region"`。
- 技能排错表新增同一情形的处理建议。
- README 首图换成与 0.2.0 能力一致的「高清截图台」横幅（显示器 / 窗口 / 区域 + 双通道，无录屏与网页截图）。

## 0.2.0

**破坏性重构**：从「安装一份截图/录屏脚本技能」改为「截图专用、Tool-first 的 DSH 插件」。录屏、网页截图与技能内脚本全部删除，旧参数不再兼容。

### 删除（不可兼容）

- 删除录屏能力：Windows 的 `rec.ps1`、macOS/Linux 的 `capture.sh rec`、ffmpeg / ddagrab 相关文档与断言。
- 删除网页截图能力：`page.mjs`、`--target-width` / `--scale` 的尺寸推导、网页端到端检查（`smoke/page_e2e.py`）。
- 删除技能内全部脚本：`.dsh/skills/capture-sharp/scripts/` 整个目录（`shot.ps1`、`rec.ps1`、`capture.sh`、`page.mjs`）。
- 删除 `references/troubleshooting.md` 中的录屏、网页与帧率章节，只保留平台、权限与截图排错。
- 删除 `package.json` 的 screen-recording 相关 keywords 与旧 description。

### 新增

- `capture_screenshot`：`display` / `window` / `region` 三类目标，缺省 `display`；PNG、原子写、每次调用唯一文件名、`maxWidth` 只缩小一次、永不放大。
- `capture_probe`：只诊断不截图，报告显示器、可用后端与缺失工具、权限、输出根、技能健康度与各目标支持等级。
- Host 拆分为 `lib/index.js`（生命周期）、`lib/service.js`（唯一采集路径）、`lib/tool.js`（schema 与结果渲染）、`lib/adapters/*`（平台后端）、`lib/native/windows-shot.ps1`、`lib/png.js`、`lib/paths.js`、`lib/provision-skill.js`。
- 失败统一结构化：`code` + `message` + `details` + `hint`，共 11 个失败码；`quality_unverified` 与 `skill_shadowed` 只作警告/状态，不阻断截图。

### 变更（语义与声明）

- 尺寸语义拆开：`width` / `height` 是磁盘 PNG 的 IHDR 尺寸，`image.width` / `image.height` 是附件库归一化后模型可见的尺寸；降采样给 `model_image_downscaled`，被重编码再给 `attachment_reencoded`。
- 支持等级如实声明：Windows 单屏 console 为 beta；macOS、Linux X11 与 Wayland 为 experimental（零真机）；`target:'all'` 为 unsupported；headless 返回 `no_display`。
- 卸载残留写进文档：进程被杀死、插件目录被手工删除或 profile 被还原时，全局引导技能目录会残留，需要手动删除；不再宣称「会自动清理」。
- 版本升到 0.2.0（`plugin/package.json` 与 `.dsh/skills/capture-sharp/manifest.yaml` 同步）。

### 验收期修正（同属 0.2.0，未另起版本）

- `warnings` 定为**封闭词表 7 个**（`active_display_unavailable`、`quality_unverified`、`model_image_downscaled`、`attachment_reencoded`、`out_renamed`、`skill_shadowed`、`content_uniform`），且**只去重保序、不再静默过滤**——后端报的告警必须到模型眼前。
- 新增 `content_uniform`：后端检测到整幅近似单色时给出（图仍交付），避免"黑图按成功交付且零线索"。
- 修正 `region` + `maxWidth`（小于区域宽）必然失败的问题：尺寸校验改成按 `native` / `scaled` 分层，并区分 `max_width_ignored`、`scaled_width_mismatch`、`scaled_height_mismatch` 三种原因。
- `capture_probe` 不再把"后端探测失败"谎报成 `headless`：改为 `headless:false` + `quality_unverified` + `backends[].missing` 说明原因。
- 桌面文档里的降采样示例按像素预算修正为 3072×1920 → 约 2590×1619（等比，而非固定尺寸），并注明"以 `image.width`/`image.height` 为准、真实数值待安装后 E2E"。

### 装机实测后修正（2026-10-27，同属 0.2.0）

- **修：重启后引导技能消失**。两个原因叠加：
  1. `replaceWithVerifiedCopy` 原来**先 `rmSync(dest)` 再 `rename(tmp, dest)`**；Windows 上刚写出的目录可能被杀毒/文件监听器短暂占用，`rename` 偶发 `EPERM`，于是旧副本已删、新副本没就位 → 技能"凭空消失"。现在改为**先把旧目录 rename 成 `*.bak-*`**，新目录就位成功后才删；替换失败会把旧目录 rename 回来；`rename` 带 8 次退避重试（40ms 递增）。
  2. cordis 的 dispose 在"应用正常退出/Electron 重启用新进程替换旧进程"时同样会执行，原实现在 dispose 里删技能，会与新进程 `apply` 的 provisioning 抢同一个全局目录。现改为**默认不删**，只有显式配置 `skillCleanupOnUnload: true` 才删；`removeProvisionedSkill()` 仍只删"带本插件 marker 且 hash 未变"的目录。
- **实测归一化格式是 WebP 而不是 JPEG**：3072×1920 全屏 → 模型可见 `2590×1619 image/webp`，`warnings` 为 `model_image_downscaled, attachment_reencoded`（WebP/JPEG 取决于有无 alpha）。文档与技能里的 "JPEG" 表述已改成 "JPEG 或 WebP（实测 WebP）"。
- 新增配置项 `skillCleanupOnUnload`（默认 `false`）。

## 0.1.4

- `page.mjs`：本地文件改用 node:url 的 `pathToFileURL` 转 URL（此前手拼 file: 前缀，在 Windows 上会拼错盘符路径）；
  Windows 浏览器候选只从 `ProgramFiles` / `ProgramFiles(x86)` / `LOCALAPPDATA` 探测，不再写死 `C:` 盘符路径。
- `references/troubleshooting.md`：网页排错按 `page.mjs` 真实参数重写——`--target-width` / `--scale`、`--timeout`、
  `--browser` 与 `CHROME_PATH`、本地路径语义、`expect=`/`output=` 尺寸核对与退出码 2/3/4；删掉早已不存在的 `page.ps1` 写法。
- 技能元数据：`manifest.yaml` 与技能 README 补版本号，与插件版本同源同步。
- 内部验收：smoke 新增 `page_e2e.py`，用技能自带 `page.mjs` 在临时目录实跑 1920×1080 光栅化并复核 PNG IHDR（开发侧断言，不代表发布状态）。

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
