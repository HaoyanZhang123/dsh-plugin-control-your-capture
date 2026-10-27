<p align="center"><a href="./README.md">中文</a> | <a href="./README.en.md">English</a></p>

<h1 align="center">dsh-plugin-control-your-capture</h1>

> panel plugin v0.2.1 · skill v0.2.1

<p align="center">A screenshot tool for DSH: capture a display, a window or a region at physical pixels; the result carries both a PNG on disk and an attachment reference.</p>

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

This plugin ships the fix as a **tool**, not as a pile of scripts. On mount it registers `capture_screenshot` and `capture_probe` and installs a thin `capture-sharp` guidance skill into the global skill directory, so every workspace and session can use it.

## Features

| Capability | What it does |
|---|---|
| `capture_screenshot` | Captures `display`, `window` or `region` targets; PNG by default, no scaling by default |
| `capture_probe` | Diagnostics only, never captures: displays, available backends, permissions, output root, skill health, per-target support level |
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
| Any platform + `target:"all"` | — | — | — | `unsupported_target` (not offered in 0.2.0) |

- This matrix matches what `capture_probe` returns in `targets`; any mismatch is a defect.
- Only a measured platform x target pair may ever be called stable, and **no platform is claimed to work everywhere**.
- The plugin does not hide other screenshot tools and does not force any preset or model to call it.

## Installation

Requirement: DSH installed. The package has no runtime dependency; capture uses what the OS already provides (GDI on Windows, screencapture on macOS, maim / scrot / import or Portal / grim on Linux).

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

- **Screenshots only**: the whole scope is the `display` / `window` / `region` targets, with no other capture shape and no UI panel; the migration section lists what was removed.
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
