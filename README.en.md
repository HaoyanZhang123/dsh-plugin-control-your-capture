<p align="center"><a href="./README.md">中文</a> | <a href="./README.en.md">English</a></p>

<h1 align="center">dsh-plugin-control-your-capture</h1>

> panel plugin v0.3.0 · skill v0.3.0

<p align="center">Screenshot and screen-recording tools for DSH: capture a display, a window or a region at physical pixels, and record a display or region to MP4 on a single-display Windows console session.</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node-%E2%89%A5%2018-339933?logo=nodedotjs&logoColor=white" alt="Node 18+"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-2ea44f" alt="License MIT"></a>
  <a href="https://github.com/HaoyanZhang123/dsh-plugin-control-your-capture"><img src="https://img.shields.io/badge/DSH-plugin-4B5563" alt="DSH plugin"></a>
</p>

## Overview

Blurry captures on high-DPI screens are usually a sampling problem, not an encoding one: the panel has far more physical pixels than the logical desktop exposes.

Measured on a 3072x1920 Windows display at 200% scaling: a process without DPI awareness captures only 1536x960, and no amount of encoding brings the text sharpness back.

![Screenshot deck: capture_screenshot inside DSH — display, window or region captured at physical pixels, with probe diagnostics](https://raw.githubusercontent.com/HaoyanZhang123/dsh-plugin-control-your-capture/main/assets/banner.webp)

**How large is the difference?** Measured on this machine — same screen region, same moment, only the sampling resolution differs, with no post-sharpening applied:

![Same screen region: left is this plugin at physical pixels (800x500, sharp); right is a 400x250 logical-resolution capture upscaled 2x (blurry)](https://raw.githubusercontent.com/HaoyanZhang123/dsh-plugin-control-your-capture/main/assets/compare-native-vs-logical.webp)

On a controlled sharpness target (8/9/10/16 pt Chinese and Latin text, 1 px lines, 4 px and 8 px checkerboards) the text-band sharpness (Laplacian variance) differs by **about 75x for 8/9/10 pt text and about 28x for 16 pt text**.
On the right the 1 px vertical lines have smeared into a grey band and the checkerboards have collapsed into moire — that is what a logical-resolution capture does.

### Why is the gap this large?

On a high-DPI display the panel has N× the logical resolution (N=2 at 200% scaling — four times the pixels).
Capturing at logical resolution yields only 1/N of the real information: each source pixel is stretched over N×N physical pixels,
so 1 px lines are averaged away in the very first sample and no later sharpening can bring them back.

This plugin declares per-monitor DPI awareness and captures at physical pixels: one sample, 1:1 delivery, no upscale, no resampling.

The ratio reaches 75× because the sharpness metric is superlinearly sensitive to high-frequency detail and the target is an extreme case
(1 px lines, 8 pt text); ordinary body text (16 pt) measures about 28× — not every UI differs by 75×.

**The trade-off is latency**: each call spawns a native helper process. Measured on Windows 11 at 3072x1920 / 200% scaling,
median of 20 runs: about **812 ms** for a full display (p90 846 ms) and about **681 ms** for an 800x500 region (p90 700 ms).
We win on fidelity, not on speed.

This plugin ships the fix as a **tool**, not as a pile of scripts. On mount it registers `capture_screenshot` and `capture_probe` and installs a thin `capture-sharp` guidance skill into the global skill directory, so every workspace and session can use it.

## Features

| Capability | What it does |
|---|---|
| `capture_screenshot` | Captures `display`, `window` or `region` targets; PNG by default, no scaling by default |
| `capture_probe` | Diagnostics only, never captures: displays, available backends, permissions, output root, skill health, per-target support level, and recording capability (`recording`) |
| `capture_recording` | Records `display` or a physical-pixel `region` to MP4 on a single-display Windows console session; `start` / `status` / `stop` / `cancel`, with the lifecycle owned by the host |
| Native sharpness | Captures at the physical pixels the backend reports; `maxWidth` may downscale exactly once and the tool **never upscales** |
| Two delivery channels | The same bytes are written to disk as a native PNG (`path`) and handed to the attachment store (`image`); the model-visible size may be normalized, so read `image.width` / `image.height` |
| Concurrency-safe | Unique file name per call, same-directory temp file plus atomic rename; no overwrite, no half-written file |
| Structured failures | Every failure carries `code`, `message`, `details` and `hint`; missing tools, no display and missing permissions fail loudly |
| Zero runtime dependencies | Node built-ins only; no third-party package, no import of DSH internals |
| Thin skill | The skill only teaches tool-first usage and failure handling, and **contains no scripts**: there is no second execution path |

## Support matrix

Levels: `stable` means real-machine evidence including an actual image review; `beta` means complete implementation with only part of the branches measured; `experimental` means implemented but never run on real hardware; `unsupported` means an explicit refusal, never a silent downgrade.

| Platform / session | display | window | region | Evidence |
|---|---|---|---|---|
| Windows 10/11 console (single display) | beta | beta | beta | Captured and visually reviewed on this machine; a generated test card (8pt text, 1px lines, 4px and 8px checkerboards, all four screen edges) came back from `target:"region"` **pixel-identical**. Not promoted to stable because `no_display` and backend-missing are structurally unreachable here and a real capture timeout was never triggered (timeouts were verified at mechanism level only) |
| Windows multi-display / mixed DPI / HDR | experimental | experimental | experimental | No real-machine evidence |
| Windows RDP / session 0 / secure desktop | experimental | unsupported | experimental | Success is not promised |
| macOS (Retina and non-Retina) | experimental | experimental | experimental | No real hardware; window capture needs an explicit window id |
| Linux X11 | experimental | experimental | experimental | No real hardware; needs maim, scrot or import |
| Linux Wayland | experimental | unsupported | experimental | No real hardware; needs XDG Portal or grim, and may prompt for permission |
| headless / CI | — | — | — | Always `no_display` |
| Any platform + `target:"all"` | — | — | — | `unsupported_target` (not offered in 0.3.0) |

- This matrix matches what `capture_probe` returns in `targets`; any mismatch is a defect.
- Only a measured platform x target pair may ever be called stable, and **no platform is claimed to work everywhere**.
- The plugin does not hide other screenshot tools and does not force any preset or model to call it.

Recording (`capture_recording`):

| Platform / session | display | region | Evidence |
|---|---|---|---|
| Windows 10/11 console (single display, SDR) | **beta** | **beta** | Measured on this machine: 3072x1920 at 57.48fps and 800x500 at 57.45fps, 1 video / 0 audio, `-xerror` full decode passes, faststart effective; a 279.6s recording proves the old 120s timeout no longer applies |
| Windows multi-display / HDR / RDP / session 0 | unsupported | unsupported | Explicitly rejected (`unsupported_target`), never a silent downgrade |
| macOS / Linux | unsupported | unsupported | 0.3.0 offers no recording |
| `target:"window"` / `target:"all"` | — | — | `unsupported_target` |

Recording needs an external **FFmpeg (with the ddagrab filter and libx264)** and **FFprobe**: `capture_probe.recording.missing` lists what is missing, and missing them **only affects recording — screenshots keep working**.

## Installation

Requirement: DSH installed. The package has no runtime dependency; screenshots use what the OS already provides (GDI on Windows, screencapture on macOS, maim / scrot / import or Portal / grim on Linux), while **recording additionally needs an external FFmpeg (with ddagrab and libx264) and FFprobe**.

```bash
dsh plugin add dsh-plugin-control-your-capture
```

- A fresh bundle can activate through HMR; **replacing an installed package requires a DSH restart** to load the new module generation.
- DSH does not auto-update installed plugins: uninstall and install the new version.
- On mount the plugin installs `capture-sharp` into the global skill directory (by default `$DSH_HOME/skills`) and registers both tools.

## Usage

Plain language works: "take a screenshot", "show me the current window", "this region is too blurry, capture it bigger". You can also be explicit about the target and size.

| Parameter | Value | Notes |
|---|---|---|
| `target` | `display` / `window` / `region` | Defaults to `display`; there is no `all` |
| `display` | opaque id from `capture_probe` | Defaults to the display holding the active window; falling back to the primary display adds an `active_display_unavailable` warning |
| `window` | backend-resolvable window id | Only meaningful for `target:"window"`; defaults to the foreground window, and a missing window fails with `window_not_found` instead of degrading to full screen |
| `region` | `{x, y, width, height}` | Required for `target:"region"`; **physical pixels** relative to the chosen display's top-left corner, never across displays |
| `out` | relative path inside the workspace root | Defaults to `output/capture/<uuid>.png`; absolute paths and escapes are rejected |
| `maxWidth` | positive integer | Downscales once when smaller than the native width; returns the native image when equal or larger |

A typical call that crops a region to read small text:

```json
{ "target": "region", "region": { "x": 600, "y": 200, "width": 1600, "height": 900 }, "maxWidth": 1600 }
```

Returned fields: `path` (absolute path of the PNG on disk), `width` / `height` (that PNG's IHDR size), `nativeWidth` / `nativeHeight` (capture size the backend reported; omitted when it cannot be proven), `platform`, `backend`, `target`, `display`, `scaled`, `upscaled` (always `false`), `warnings`, and `image` (the normalized copy in the attachment store: `attachmentId`, `mediaType`, `bytes`, `width`, `height`, plus `originalDimensions` when it was downscaled).

**Do not confuse the two sizes.** `width` / `height` describe the file on disk; `image.width` / `image.height` describe the image the model actually receives. The attachment store downscales anything above 4,194,304 pixels or 4 MiB **by that pixel budget, preserving the aspect ratio** (not to a fixed size) and re-encodes it, so a 3072x1920 full-screen capture reaches the model at roughly **2590x1619** JPEG **or WebP — measured on this machine as `image/webp`**; `model_image_downscaled` appears in `warnings` (plus `attachment_reencoded` when it was re-encoded). The returned `image.width` / `image.height` are authoritative (measured 2026-10-27 after install: file `3072x1920` -> model `2590x1619 image/webp`). **To read small text or 1px lines, capture the target area with `target:"region"` instead of asking for an upscale.**

`warnings` is a **closed vocabulary** (7 ids); the tool only de-duplicates and preserves order, it never silently drops an entry:

`active_display_unavailable`, `quality_unverified`, `model_image_downscaled`, `attachment_reencoded`, `out_renamed`, `skill_shadowed`, `content_uniform`.

`content_uniform` means the backend saw an almost single-color frame (all black / flat color, typical for protected content or an empty window). The image is **still delivered**, but treat it as "this may not be what the user wanted to capture".

### Recording: capture_recording

| Parameter | Values | Notes |
|---|---|---|
| `action` | `start` / `status` / `stop` / `cancel` | Required |
| `recordingId` | opaque id returned by `start` | Required for `status`/`stop`/`cancel`; not allowed on `start` |
| `target` | `display` / `region` | Defaults to `display`; **`window` / `all` are unsupported** |
| `display` | opaque id from `capture_probe` | Defaults to the single current display |
| `region` | `{x,y,width,height}` | **Physical pixels** relative to the display origin; width and height must be even and fully on screen |
| `fps` | `30` / `60` | Defaults to 60 |
| `drawMouse` | boolean | Defaults to true |
| `out` | workspace-relative `.mp4` | Defaults to `output/capture/<uuid>.mp4`; an existing name is never overwritten (a unique name plus `out_renamed` is used) |

- `start` returns quickly with a `recordingId`; **`path` appears only on `completed`** — `starting` / `recording` / `stopping` have nothing deliverable, and `failed` / `cancelled` never deliver.
- One active recording per plugin instance; other agents in the same workspace (including subagents) can cooperate with the same `recordingId`, a different workspace gets `recording_workspace_mismatch`, and ids do not survive a restart.
- Fixed encoding: `libx264` / `veryfast` / CRF 14 / `yuv420p` / `+faststart`, no audio; **no gdigrab and no low-frame-rate fallback**, and `stop` enforces FFprobe (`-count_frames`) plus a full decode before publishing.

### Page screenshots vs screen screenshots

`capture_screenshot` captures **what is really displayed on the desktop** (physical pixels, never upscaled). So:

- **The page is not on screen** (headless browser, offscreen rendering, minimized window): this plugin cannot see it and that is not its job. Use the rendering side (e.g. CDP) with `deviceScaleFactor` set to `capture_probe`'s `displays[].scaleFactor` (2 on this machine), or `Page.captureScreenshot` with `clip.scale`; emit PNG and do not downscale afterwards.
- **The page / window is on screen**: use this plugin with `target:"window"` or `target:"display"`; for fine text use `target:"region"` to crop a 1:1 area.
- **The image looks small to the model**: the attachment store downscales it (3072x1920 → about 2590x1619, `model_image_downscaled`); the file on disk stays sharp.

## Configuration

Optional keys on this plugin's row under `config:`:

| Key | Default | Notes |
|---|---|---|
| `skillRoot` | `$DSH_HOME/skills` | Install root for the guidance skill; must be an absolute path |
| `skillInstall` | `true` | Set to `false` to skip the skill; the tools keep working |
| `timeoutMs` | `20000` | Per-capture timeout; on expiry the whole process tree is killed and `capture_timeout` is reported |
| `maxWidth` | no scaling | Service-level default downscale width; a per-call `maxWidth` wins |

An invalid configuration fails the plugin outright (fiber FAILED, observable) instead of silently falling back to defaults.

## Uninstall and leftovers

When the plugin is disabled or removed while DSH is running, the `capture-sharp` skill this plugin installed is cleaned up. If the process is killed, the plugin directory is deleted by hand, or the profile is restored, **there is no reliable hook**: the skill directory stays behind and must be removed manually at `$DSH_HOME/skills/capture-sharp`. A same-named directory you created yourself is never overwritten; in that case `capture_probe` reports `skillStatus: "shadowed"` and the tools still work.

## Known limitations

- **Scope = screenshots plus single-display Windows recording**: screenshots cover `display` / `window` / `region`; recording covers `display` / `region` on a single-display Windows console session. There is no UI panel.
- **Recording limits**: no audio, no `window` / multi-display / HDR / RDP / session 0, no macOS or Linux recording; `yuv420p` is lossy and **not pixel-identical to PNG**, and there is no lossless mode.
- **Recording needs external FFmpeg / FFprobe** (ddagrab + libx264): when missing, the call fails with `backend_unavailable` and lists each item in `missing`; nothing is downloaded or bundled.
- **Hard-kill leftovers**: after a crash or force-quit, orphan FFmpeg processes and `.tmp-*.mp4` files are not guaranteed to be cleaned (0.3.0 has no Job Object).
- **Readiness semantics**: `start` means "the process is alive and the temp file is non-empty (header)"; FFmpeg output buffering can keep video data off disk until `stop`, and delivery quality is enforced by the `stop` FFprobe + full-decode validation.
- Windows is measured at beta only for single-display console sessions; multi-display, mixed DPI, HDR, RDP, session 0 and the secure desktop are not claimed.
- macOS, Linux X11 and Wayland have **no real hardware evidence** and stay experimental; Wayland may prompt for permission and does not support a single-window target.
- `target:"all"` is not supported, and regions spanning two displays are rejected (capture them separately).
- A full-screen image is downscaled before the model sees it; fine detail needs `target:"region"`.
- No UI card is registered (`presentCall` / `presentResult`); results live in the tool text and image only.
- The plugin does not modify the system prompt and does not use `tools.restrict` / `tools.guard` to manufacture priority.
- **A `target:"window"` capture of a GPU-composited window can come back blank**: the compositor layer of some browser / Electron windows is not reachable through `PrintWindow`, so the result is a flat colour instead of the window content. That case carries the `content_uniform` warning — do not treat it as a successful capture; switch to `target:"display"` or `target:"region"` (measured 2026-10-27 on this machine: a Chrome window produced a plain white 2528x1936 image while `display`/`region` of the same window worked).
- **A `window` capture may bring the target window to the foreground**: on Windows, when `PrintWindow` fails the backend falls back to capturing the window rectangle from the screen and will **try to** activate that window (`SetForegroundWindow` can be refused by the system, hence "try", not "always"). Use `target:"region"` if you do not want the focus change. On Wayland, falling back from the Portal to grim is reported honestly in the `backend` field as `wayland-grim`.
- A timeout kills the whole process tree, but **a real capture timeout has never fired on this machine** (only mechanism-level verification); that wording will not change until the target is promoted to stable.

## Migrating from 0.1.x (breaking)

### 0.3.0: recording is back, but not as the old script

0.3.0 brings recording back as the host-side **`capture_recording` tool** (DDA + libx264 + atomic MP4 publishing), **not** the 0.1.x `rec.ps1` / `capture.sh rec`; the skill still contains **no scripts**, so there is no second execution path. Upgrade path: uninstall the old version, install 0.3.0, restart DSH.

### The 0.2.0 breaking change (history)

0.2.0 removes the screen recording and page capture abilities of 0.1.x and deletes every script that used to live in the skill: `capture_screenshot` is now the single execution path.

- The skill no longer has a `scripts/` directory; automation that calls the old script paths stops working.
- The old recording parameters and the page target-width derivation are no longer accepted, and the page E2E check is gone from the gate.
- Upgrade path: uninstall the old version, install 0.2.0, restart DSH, then delete any leftover scripts in the global skill directory by hand.
- Per-version detail lives in [CHANGELOG.md](CHANGELOG.md).

## Project structure

```text
lib/index.js                          host entry: lifecycle, tool registration and cleanup
lib/service.js                        the only capture service: arguments, backend choice, writes, attachments, error mapping
lib/tool.js                           schemas and result rendering for capture_screenshot / capture_probe
lib/adapters/{windows,macos,linux}.js per-platform backends: raw bytes only, never decide the destination
lib/native/windows-shot.ps1           Windows DPI-aware native helper
lib/png.js / lib/paths.js             PNG validation, output root, unique naming and atomic writes
lib/provision-skill.js                guidance skill install, content hash and cleanup
cordis.patch.yml                      plugin row declaration
locale/                               plugin card copy (zh / en)
skill/capture-sharp/                  bundled guidance skill (no scripts; staged from the skill source by the gate)
```

## License

[MIT](LICENSE).
