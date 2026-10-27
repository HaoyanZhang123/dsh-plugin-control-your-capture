// adapters/linux.js — Linux 后端（X11 与 Wayland 分开处理），contract.md §1.1 / §16。
//
// 只做“平台命令 → 原始字节”：写 run.tmpDir 里的临时 PNG，读成内存字节，
// **成功与失败路径都删除临时文件**；落盘/命名/附件由 service.js 独占。
//
// 硬规则：
//  - X11：在 scrot → maim → import 中按固定优先级选定一个并记录，不每次盲扫；
//  - Wayland：有 WAYLAND_DISPLAY 时优先 XDG Desktop Portal；grim 只作为 portal 不可用时的
//    compositor 后端；**绝不静默退回 X11**；本轮整体 experimental；
//  - 无 DISPLAY / 无 WAYLAND_DISPLAY → no_display；
//  - 缩小需要 ImageMagick；缺工具时**不静默交付原生**——请求了 maxWidth 就报
//    `backend_unavailable`（details.reason 指明"缩小的后端缺失"），未请求则不受影响（契约 §16.10）。

import { createHash, randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { readPngSize } from '../png.js';

/** X11 后端的固定优先级。 */
const X11_PRIORITY = ['scrot', 'maim', 'import'];

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

function shortDetail(text, limit = 400) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? value.slice(0, limit) + '…' : value;
}

function shortHash(text) {
  return createHash('sha1').update(String(text)).digest('hex').slice(0, 12);
}

function fail(code, message, extra = {}) {
  // 契约 §16.7.1：adapter 失败一律 throw；成功形状不带 ok。
  const error = new Error(message);
  error.failure = {
    code,
    message,
    ...(extra.details && typeof extra.details === 'object' ? { details: extra.details } : {}),
    ...(extra.hint ? { hint: String(extra.hint) } : {}),
  };
  throw error;
}

function parseXrandr(text) {
  const outputs = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+connected\s+(?:(primary)\s+)?(\d{2,5})x(\d{2,5})\+(-?\d+)\+(-?\d+)/);
    if (!m) continue;
    const width = Number(m[3]);
    const height = Number(m[4]);
    if (!(width > 0) || !(height > 0)) continue;
    outputs.push({
      name: m[1],
      primary: Boolean(m[2]) || (outputs.length === 0 && Number(m[5]) === 0 && Number(m[6]) === 0),
      x: Number(m[5]),
      y: Number(m[6]),
      width,
      height,
    });
  }
  return outputs;
}

function parseWlrRandr(text) {
  const outputs = [];
  let current = null;
  const flush = () => {
    if (current && current.width > 0) outputs.push(current);
    current = null;
  };
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }
    if (!/^\s/.test(rawLine) && !current) {
      current = { name: line.split(/\s+/)[0], x: 0, y: 0, width: 0, height: 0, scale: null };
      continue;
    }
    if (!current) continue;
    const mode = line.match(/Current mode:\s*(\d{2,5})x(\d{2,5})/i);
    if (mode) {
      current.width = Number(mode[1]);
      current.height = Number(mode[2]);
    }
    const pos = line.match(/Position:\s*(-?\d+)\s*,\s*(-?\d+)/i);
    if (pos) {
      current.x = Number(pos[1]);
      current.y = Number(pos[2]);
    }
    const scale = line.match(/Scale:\s*([\d.]+)/i);
    if (scale) current.scale = Number(scale[1]);
  }
  flush();
  return outputs.map((item) => ({
    name: item.name,
    primary: item.x === 0 && item.y === 0,
    x: item.x,
    y: item.y,
    width: item.width,
    height: item.height,
    scaleFactor: item.scale && item.scale > 0 ? item.scale : undefined,
  }));
}

function pickX11(run) {
  for (const name of X11_PRIORITY) {
    const exe = run.findExe(name);
    if (exe) return { name, exe };
  }
  return null;
}

function pickMagick(run) {
  const magick = run.findExe('magick');
  if (magick) return { exe: magick, kind: 'magick' };
  const convert = run.findExe('convert');
  if (convert) return { exe: convert, kind: 'convert' };
  return null;
}

function sessionMode(run) {
  const env = run.env || {};
  if (env.WAYLAND_DISPLAY) return 'wayland';
  if (env.DISPLAY) return 'x11';
  return 'none';
}

async function x11Displays(run) {
  const warnings = [];
  const xrandr = await run.exec('xrandr', ['--query'], {
    timeoutMs: Math.min(run.timeoutMs, 6000),
    signal: run.signal,
    env: run.env,
  });
  if (xrandr.ok) {
    const parsed = parseXrandr(xrandr.stdout);
    if (parsed.length > 0) {
      return {
        displays: parsed.map((item) => ({
          id: shortHash('x11|' + item.name + '|' + item.x + ',' + item.y + ',' + item.width + ',' + item.height),
          x: item.x,
          y: item.y,
          width: item.width,
          height: item.height,
          primary: item.primary,
          device: item.name,
        })),
        warnings,
      };
    }
  }
  const xdpyinfo = await run.exec('xdpyinfo', [], {
    timeoutMs: Math.min(run.timeoutMs, 6000),
    signal: run.signal,
    env: run.env,
  });
  if (xdpyinfo.ok) {
    const m = String(xdpyinfo.stdout).match(/dimensions:\s+(\d+)x(\d+)\s+pixels/);
    if (m) {
      warnings.push('quality_unverified');
      return {
        displays: [
          {
            id: shortHash('x11|screen|' + m[1] + 'x' + m[2]),
            x: 0,
            y: 0,
            width: Number(m[1]),
            height: Number(m[2]),
            primary: true,
            device: null,
          },
        ],
        warnings,
      };
    }
  }
  warnings.push('quality_unverified');
  return {
    displays: [{ id: shortHash('x11|unknown'), x: 0, y: 0, width: 0, height: 0, primary: true, device: null }],
    warnings,
  };
}

async function waylandDisplays(run) {
  const warnings = [];
  const wlr = await run.exec('wlr-randr', [], {
    timeoutMs: Math.min(run.timeoutMs, 6000),
    signal: run.signal,
    env: run.env,
  });
  if (wlr.ok) {
    const parsed = parseWlrRandr(wlr.stdout);
    if (parsed.length > 0) {
      return {
        displays: parsed.map((item) => ({
          id: shortHash('wl|' + item.name + '|' + item.x + ',' + item.y + ',' + item.width + ',' + item.height),
          x: item.x,
          y: item.y,
          width: item.width,
          height: item.height,
          primary: item.primary,
          device: item.name,
          ...(item.scaleFactor ? { scaleFactor: item.scaleFactor } : {}),
        })),
        warnings,
      };
    }
  }
  warnings.push('quality_unverified');
  return {
    displays: [
      {
        id: shortHash('wl|' + String((run.env || {}).WAYLAND_DISPLAY || 'unknown')),
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        primary: true,
        device: null,
      },
    ],
    warnings,
  };
}

function publicDisplay(entry) {
  return {
    id: entry.id,
    x: entry.x,
    y: entry.y,
    width: entry.width,
    height: entry.height,
    ...(entry.scaleFactor ? { scaleFactor: entry.scaleFactor } : {}),
    primary: entry.primary,
  };
}

function findDisplay(displays, displayId) {
  if (!displayId) return displays.find((item) => item.primary) || displays[0] || null;
  return displays.find((item) => item.id === displayId) || null;
}

async function portalAvailable(run) {
  const gdbus = run.findExe('gdbus');
  if (!gdbus) return false;
  const introspect = await run.exec(
    gdbus,
    ['introspect', '--session', '--dest', 'org.freedesktop.portal.Desktop', '--object-path', '/org/freedesktop/portal/desktop'],
    { timeoutMs: Math.min(run.timeoutMs, 6000), signal: run.signal, env: run.env },
  );
  return Boolean(introspect.ok && /org\.freedesktop\.portal\.Screenshot/.test(introspect.stdout));
}

async function portalCapture(run) {
  const gdbus = run.findExe('gdbus');
  if (!gdbus) {
    return fail('backend_unavailable', 'Wayland needs gdbus to reach the XDG Desktop Portal', {
      details: { backend: 'wayland-portal', missing: ['gdbus'] },
      hint: 'install glib2 / gdbus, or install grim for a wlroots compositor',
    });
  }
  const request = await run.exec(
    gdbus,
    [
      'call',
      '--session',
      '--dest',
      'org.freedesktop.portal.Desktop',
      '--object-path',
      '/org/freedesktop/portal/desktop',
      '--method',
      'org.freedesktop.portal.Screenshot.Screenshot',
      '',
      "{'interactive': <false>, 'modal': <false>}",
    ],
    { timeoutMs: Math.min(run.timeoutMs, 15000), signal: run.signal, env: run.env },
  );

  if (!request.ok) {
    const text = shortDetail(String(request.stderr || '') + ' ' + String(request.stdout || ''));
    if (/denied|not allowed|permission/i.test(text)) {
      return fail('permission_required', 'the XDG Desktop Portal refused the screenshot request', {
        details: { backend: 'wayland-portal', permission: 'portal-screenshot' },
        hint: 'allow the portal screenshot prompt; unattended sessions cannot grant it',
      });
    }
    return fail('backend_unavailable', 'the XDG Desktop Portal is unavailable', {
      details: { backend: 'wayland-portal', reason: text },
    });
  }

  const handleMatch = String(request.stdout).match(/objectpath '([^']+)'/);
  if (!handleMatch) {
    return fail('capture_failed', 'the portal returned no request handle', {
      details: { backend: 'wayland-portal', reason: 'no_handle' },
    });
  }
  const handle = handleMatch[1];

  // monitor 会在超时后被 kill；超时前收集到的 stdout 仍然可用（单次 runner，不做流式回调）
  const monitor = await run.exec(
    gdbus,
    ['monitor', '--session', '--dest', 'org.freedesktop.portal.Desktop', '--object-path', handle],
    { timeoutMs: Math.min(run.timeoutMs, 25000), signal: run.signal, env: run.env },
  );
  const text = String(monitor.stdout || '');
  const responseMatch = text.match(/\.Response\s*\(uint32\s+(\d+),\s*\{([^}]*)\}/);
  if (!responseMatch) {
    return fail('permission_required', 'timed out waiting for the portal screenshot response (a user prompt may be pending)', {
      details: { backend: 'wayland-portal', permission: 'portal-screenshot', reason: 'response_timeout' },
      hint: 'the first portal capture prompts for consent; unattended sessions cannot complete it',
    });
  }
  const responseCode = Number(responseMatch[1]);
  if (responseCode !== 0) {
    return fail(responseCode === 1 ? 'permission_required' : 'capture_failed', 'the portal screenshot was refused', {
      details: { backend: 'wayland-portal', responseCode },
      hint: responseCode === 1 ? 'allow the portal prompt' : 'retry, then run capture_probe',
    });
  }
  const uriMatch = responseMatch[2].match(/'uri':\s*<'([^']+)'>/);
  if (!uriMatch) {
    return fail('capture_failed', 'the portal response carried no image URI', {
      details: { backend: 'wayland-portal', reason: 'no_uri' },
    });
  }
  const uri = uriMatch[1];
  if (!uri.startsWith('file://')) {
    return fail('capture_failed', 'the portal returned a non-local image URI', {
      details: { backend: 'wayland-portal', reason: 'non_local_uri' },
    });
  }
  const localPath = decodeURIComponent(uri.slice('file://'.length));
  try {
    const bytes = await readFile(localPath);
    await unlink(localPath).catch(() => {});
    return { bytes, backend: 'wayland-portal' };
  } catch (e) {
    return fail('capture_failed', 'the portal image file could not be read', {
      details: { backend: 'wayland-portal', reason: 'read_failed' },
    });
  }
}

function x11Args(tool, rect, outPath) {
  if (tool.name === 'scrot') return [tool.exe, ['-o', '-a', `${rect.x},${rect.y},${rect.width},${rect.height}`, outPath]];
  if (tool.name === 'maim') return [tool.exe, ['-g', `${rect.width}x${rect.height}+${rect.x}+${rect.y}`, outPath]];
  return [tool.exe, ['-window', 'root', '-crop', `${rect.width}x${rect.height}+${rect.x}+${rect.y}`, '+repage', outPath]];
}

async function maybeDownscale(run, rawPath, rawBytes, rawSize, maxWidth) {
  if (!maxWidth || maxWidth <= 0 || maxWidth >= rawSize.width) {
    return { bytes: rawBytes, width: rawSize.width, height: rawSize.height, warnings: [] };
  }
  const magick = pickMagick(run);
  if (!magick) {
    // 契约 §16.5 词表已不含 scale_skipped_backend_missing：兑现不了 maxWidth 就明确失败，不静默降级
    return fail('backend_unavailable', 'Linux cannot downscale without ImageMagick, so maxWidth cannot be honored', {
      details: { backend: 'imagemagick', missing: ['magick'], reason: 'resize_backend_missing' },
      hint: 'install imagemagick, or drop maxWidth',
    });
  }
  const scaledPath = join(run.tmpDir || '', 'dsh-capture-linux-scaled-' + randomUUID() + '.png');
  try {
    const result = await run.exec(magick.exe, [rawPath, '-filter', 'Lanczos', '-resize', `${maxWidth}x`, '-strip', scaledPath], {
      timeoutMs: run.timeoutMs,
      signal: run.signal,
      env: run.env,
    });
    if (!result.ok) {
      return fail('capture_failed', 'ImageMagick failed to downscale the capture', {
        details: { backend: 'imagemagick', exitCode: result.exitCode, stderrTail: shortDetail(result.stderr) },
      });
    }
    const scaledBytes = await readFile(scaledPath);
    const scaledSize = readPngSize(scaledBytes);
    if (!scaledSize) {
      return fail('invalid_output', 'ImageMagick produced an unreadable PNG', { details: { reason: 'png_invalid' } });
    }
    return { bytes: scaledBytes, width: scaledSize.width, height: scaledSize.height, warnings: [] };
  } finally {
    await unlink(scaledPath).catch(() => {});
  }
}

/** 只读诊断：会话类型、显示器、可用后端与缺失依赖。绝不截图。 */
export async function probe(_ctx, run) {
  const mode = sessionMode(run);

  if (mode === 'none') {
    return {
      platform: 'linux',
      sessionType: 'headless',
      headless: true,
      displays: [],
      backends: [
        { name: 'x11-scrot', available: Boolean(run.findExe('scrot')), ...(run.findExe('scrot') ? {} : { missing: ['scrot'] }) },
        { name: 'wayland-portal', available: false, missing: ['WAYLAND_DISPLAY'] },
        { name: 'imagemagick', available: Boolean(pickMagick(run)), ...(pickMagick(run) ? {} : { missing: ['magick'] }) },
      ],
      permissions: { status: 'not_applicable', note: 'no display server in this session' },
      targets: { display: 'unsupported', window: 'unsupported', region: 'unsupported' },
      warnings: [],
    };
  }

  if (mode === 'wayland') {
    const portal = await portalAvailable(run);
    const grim = run.findExe('grim');
    const magick = pickMagick(run);
    const { displays, warnings } = await waylandDisplays(run);
    
    return {
      platform: 'linux',
      sessionType: 'wayland',
      headless: false,
      displays: displays.map(publicDisplay),
      backends: [
        { name: 'wayland-portal', available: portal, ...(portal ? {} : { missing: ['xdg-desktop-portal'] }) },
        { name: 'wayland-grim', available: Boolean(grim), ...(grim ? {} : { missing: ['grim'] }) },
        { name: 'imagemagick', available: Boolean(magick), ...(magick ? {} : { missing: ['magick'] }) },
      ],
      permissions: {
        status: 'unknown',
        note: 'the portal may prompt for consent on the first capture; unattended sessions cannot complete it',
      },
      targets: {
        display: portal || grim ? 'experimental' : 'unsupported',
        window: 'unsupported',
        region: grim ? 'experimental' : 'unsupported',
      },
      warnings,
    };
  }

  const tool = pickX11(run);
  const magick = pickMagick(run);
  const { displays, warnings } = await x11Displays(run);

  return {
    platform: 'linux',
    sessionType: 'x11',
    headless: false,
    displays: displays.map(publicDisplay),
    backends: [
      { name: 'x11-scrot', available: Boolean(run.findExe('scrot')), ...(run.findExe('scrot') ? {} : { missing: ['scrot'] }) },
      { name: 'x11-maim', available: Boolean(run.findExe('maim')), ...(run.findExe('maim') ? {} : { missing: ['maim'] }) },
      { name: 'x11-import', available: Boolean(run.findExe('import')), ...(run.findExe('import') ? {} : { missing: ['import'] }) },
      { name: 'imagemagick', available: Boolean(magick), ...(magick ? {} : { missing: ['magick'] }) },
    ],
    permissions: { status: 'unknown', note: 'X11 capture needs no dedicated permission' },
    targets: {
      display: tool ? 'experimental' : 'unsupported',
      window: tool && (tool.name === 'scrot' || tool.name === 'import') ? 'experimental' : 'unsupported',
      region: tool ? 'experimental' : 'unsupported',
    },
    warnings,
  };
}

/** 采集一次，返回内存 PNG 字节；临时文件在成功与失败路径都会被删除。 */
export async function capture(request, run) {
  const mode = sessionMode(run);
  const tmpPath = join(run.tmpDir || '', 'dsh-capture-linux-' + randomUUID() + '.png');

  if (mode === 'none') {
    return fail('no_display', 'no DISPLAY or WAYLAND_DISPLAY is set, so this is a headless session', {
      details: { sessionType: 'headless', backend: 'none' },
      hint: 'run capture_probe; screen capture needs a desktop session',
    });
  }

  try {
    if (mode === 'wayland') {
      return await captureWayland(request, run, tmpPath);
    }
    return await captureX11(request, run, tmpPath);
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

async function captureWayland(request, run, tmpPath) {
  if (request.target === 'window') {
    return fail('unsupported_target', 'Wayland cannot capture a single window without compositor-specific protocols', {
      details: { target: 'window', platform: 'linux', sessionType: 'wayland', supported: ['display', 'region with grim'] },
      hint: 'use target "display" or "region" on Wayland',
    });
  }

  const { displays, warnings } = await waylandDisplays(run);
  const display = findDisplay(displays, request.display);
  if (!display) {
    return fail('invalid_argument', 'display id does not match any current display', {
      details: { reason: 'display_unknown', display: request.display },
      hint: 'call capture_probe to get the current display ids',
    });
  }

  if (request.target === 'region') {
    const grim = run.findExe('grim');
    if (!grim) {
      return fail('unsupported_target', 'Wayland region capture needs grim (the portal has no region API)', {
        details: { target: 'region', platform: 'linux', sessionType: 'wayland', supported: ['display'] },
        hint: 'install grim, or capture the display',
      });
    }
    if (display.width <= 0 || display.height <= 0) {
      return fail('invalid_region', 'cannot map region coordinates without display geometry', {
        details: { reason: 'region_requires_display_geometry', display: display.id },
        hint: 'install wlr-randr so the output geometry can be read',
      });
    }
    const region = request.region;
    if (region.x + region.width > display.width || region.y + region.height > display.height) {
      return fail('invalid_region', 'region exceeds the selected display bounds (cross-display is not supported)', {
        details: {
          reason: 'region_out_of_bounds',
          display: display.id,
          bounds: { x: display.x, y: display.y, width: display.width, height: display.height },
        },
      });
    }
    const scale = display.scaleFactor && display.scaleFactor > 0 ? display.scaleFactor : 1;
    const logicalX = Math.round((display.x + region.x) / scale);
    const logicalY = Math.round((display.y + region.y) / scale);
    const logicalW = Math.max(1, Math.round(region.width / scale));
    const logicalH = Math.max(1, Math.round(region.height / scale));
    const result = await run.exec(
      grim,
      ['-g', `${logicalX},${logicalY} ${logicalW}x${logicalH}`, tmpPath],
      { timeoutMs: run.timeoutMs, signal: run.signal, env: run.env },
    );
    if (!result.ok) {
      return fail('capture_failed', 'grim failed to capture the region', {
        details: { backend: 'wayland-grim', exitCode: result.exitCode, stderrTail: shortDetail(result.stderr) },
      });
    }
    return await finishLinuxCapture(run, tmpPath, request, display, 'wayland-grim', [...warnings]);
  }

  // display：优先 portal
  if (await portalAvailable(run)) {
    // portalCapture 失败即 throw（§16.7.1），所以这里没有 `.ok` 分支
    try {
      const portal = await portalCapture(run);
      const size = readPngSize(portal.bytes);
      if (!size) {
        return fail('invalid_output', 'the portal returned an unreadable PNG', {
          details: { reason: 'png_invalid', backend: 'wayland-portal' },
        });
      }
      const scaled = await maybeDownscale(run, tmpPath, portal.bytes, size, request.maxWidth);
      return {
        bytes: scaled.bytes,
        nativeWidth: size.width,
        nativeHeight: size.height,
        width: scaled.width,
        height: scaled.height,
        backend: 'wayland-portal',
        display: display.id,
        warnings: [...warnings, ...scaled.warnings],
      };
    } catch (e) {
      const failure = e && e.failure ? e.failure : null;
      // 用户/Poral 明确拒绝 → 如实失败，不偷偷换后端
      if (failure && failure.code === 'permission_required') throw e;
      // 其它 portal 故障：有 grim 才降级，且不产出词表外 warning
      if (!run.findExe('grim')) throw e;
    }
  }

  const grim = run.findExe('grim');
  if (!grim) {
    return fail('backend_unavailable', 'Wayland has neither a usable portal nor grim', {
      details: { backend: 'wayland-none', missing: ['xdg-desktop-portal', 'grim'] },
      hint: 'install xdg-desktop-portal with a backend, or grim on a wlroots compositor',
    });
  }
  const argv = display.device ? ['-o', String(display.device), tmpPath] : [tmpPath];
  const result = await run.exec(grim, argv, { timeoutMs: run.timeoutMs, signal: run.signal, env: run.env });
  if (!result.ok) {
    return fail('capture_failed', 'grim failed to capture the display', {
      details: { backend: 'wayland-grim', exitCode: result.exitCode, stderrTail: shortDetail(result.stderr) },
    });
  }
  if (!display.device) warnings.push('quality_unverified');
  return await finishLinuxCapture(run, tmpPath, request, display, 'wayland-grim', warnings);
}

async function captureX11(request, run, tmpPath) {
  const tool = pickX11(run);
  if (!tool) {
    return fail('backend_unavailable', 'no X11 screenshot tool is installed (scrot, maim, import)', {
      details: { backend: 'x11-none', missing: ['scrot', 'maim', 'import'] },
      hint: 'install scrot, maim or imagemagick',
    });
  }

  const { displays, warnings } = await x11Displays(run);
  const display = findDisplay(displays, request.display);
  if (!display) {
    return fail('invalid_argument', 'display id does not match any current display', {
      details: { reason: 'display_unknown', display: request.display },
      hint: 'call capture_probe to get the current display ids',
    });
  }

  if (request.target === 'window') {
    if (tool.name === 'maim') {
      return fail('unsupported_target', 'the selected X11 backend (maim) cannot capture a single window', {
        details: { target: 'window', platform: 'linux', backend: 'x11-maim', supported: ['display', 'region'] },
        hint: 'install scrot or imagemagick import for window capture',
      });
    }
    if (request.window) {
      if (tool.name !== 'import') {
        return fail('unsupported_target', 'the scrot backend can only capture the focused window, not an arbitrary window id', {
          details: { target: 'window', platform: 'linux', backend: 'x11-scrot', supported: ['display', 'region', 'focused window'] },
          hint: 'omit the window argument to capture the focused window',
        });
      }
      if (!/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(String(request.window))) {
        return fail('invalid_argument', 'window must be a decimal or 0x-prefixed X11 window id', {
          details: { reason: 'window_not_numeric', window: request.window },
        });
      }
      const shot = await run.exec(tool.exe, ['-window', String(request.window), tmpPath], {
        timeoutMs: run.timeoutMs,
        signal: run.signal,
        env: run.env,
      });
      if (!shot.ok) {
        const text = shortDetail(shot.stderr);
        if (/no such window|not found|unable to/i.test(text)) {
          return fail('window_not_found', 'X11 could not find the requested window', {
            details: { reason: 'window_missing', window: request.window, backend: 'x11-import', stderrTail: text },
          });
        }
        return fail('capture_failed', 'import failed to capture the window', {
          details: { backend: 'x11-import', exitCode: shot.exitCode, stderrTail: text },
        });
      }
      return await finishLinuxCapture(run, tmpPath, request, display, 'x11-import', warnings);
    }
    if (tool.name === 'scrot') {
      const shot = await run.exec(tool.exe, ['-u', '-o', tmpPath], {
        timeoutMs: run.timeoutMs,
        signal: run.signal,
        env: run.env,
      });
      if (!shot.ok) {
        return fail('window_not_found', 'scrot could not capture the focused window', {
          details: { reason: 'no_focused_window', backend: 'x11-scrot', stderrTail: shortDetail(shot.stderr) },
        });
      }
      return await finishLinuxCapture(run, tmpPath, request, display, 'x11-scrot', warnings);
    }
    const xdotool = run.findExe('xdotool');
    if (!xdotool) {
      return fail('unsupported_target', 'the import backend needs xdotool to resolve the focused window id', {
        details: { target: 'window', platform: 'linux', backend: 'x11-import', missing: ['xdotool'] },
        hint: 'install xdotool, or pass an explicit window id',
      });
    }
    const active = await run.exec(xdotool, ['getactivewindow'], { timeoutMs: run.timeoutMs, signal: run.signal, env: run.env });
    const id = String(active.stdout || '').trim();
    if (!active.ok || !/^[0-9]+$/.test(id)) {
      return fail('window_not_found', 'cannot resolve the focused X11 window id', {
        details: { reason: 'no_focused_window', backend: 'x11-import', stderrTail: shortDetail(active.stderr) },
      });
    }
    const shot = await run.exec(tool.exe, ['-window', id, tmpPath], {
      timeoutMs: run.timeoutMs,
      signal: run.signal,
      env: run.env,
    });
    if (!shot.ok) {
      return fail('window_not_found', 'import could not capture the focused window', {
        details: { reason: 'window_missing', backend: 'x11-import', stderrTail: shortDetail(shot.stderr) },
      });
    }
    return await finishLinuxCapture(run, tmpPath, request, display, 'x11-import', warnings);
  }

  if (display.width <= 0 || display.height <= 0) {
    return fail('no_display', 'the selected display has no usable geometry', {
      details: { reason: 'no_display_geometry', display: display.id },
      hint: 'install xrandr or xdpyinfo so the screen size can be read',
    });
  }

  let rect;
  if (request.target === 'region') {
    const region = request.region;
    if (region.x + region.width > display.width || region.y + region.height > display.height) {
      return fail('invalid_region', 'region exceeds the selected display bounds (cross-display is not supported)', {
        details: {
          reason: 'region_out_of_bounds',
          display: display.id,
          bounds: { x: display.x, y: display.y, width: display.width, height: display.height },
        },
      });
    }
    rect = {
      x: display.x + region.x,
      y: display.y + region.y,
      width: region.width,
      height: region.height,
    };
  } else if (request.target === 'display') {
    rect = { x: display.x, y: display.y, width: display.width, height: display.height };
  } else {
    return fail('unsupported_target', `the Linux backend does not support target "${request.target}"`, {
      details: { target: request.target, platform: 'linux', supported: ['display', 'window', 'region'] },
    });
  }

  const argv = x11Args(tool, rect, tmpPath);
  const shot = await run.exec(argv[0], argv[1], { timeoutMs: run.timeoutMs, signal: run.signal, env: run.env });
  if (!shot.ok) {
    return fail('capture_failed', `${tool.name} failed to capture the screen`, {
      details: { backend: 'x11-' + tool.name, exitCode: shot.exitCode, stderrTail: shortDetail(shot.stderr) },
    });
  }
  return await finishLinuxCapture(run, tmpPath, request, display, 'x11-' + tool.name, warnings);
}

async function finishLinuxCapture(run, tmpPath, request, display, backend, warnings) {
  let rawBytes;
  try {
    rawBytes = await readFile(tmpPath);
  } catch {
    return fail('invalid_output', `${backend} reported success but produced no readable file`, {
      details: { reason: 'read_failed', backend },
    });
  }
  const size = readPngSize(rawBytes);
  if (!size) {
    return fail('invalid_output', `${backend} produced a file that is not a valid PNG`, {
      details: { reason: 'png_invalid', backend },
    });
  }

  const scaled = await maybeDownscale(run, tmpPath, rawBytes, size, request.maxWidth);

  // region 尺寸与请求不一致由 service 判成 invalid_output（词表已无 region_clamped_reported）
  const outWarnings = [...toArray(warnings), ...scaled.warnings];

  return {
    bytes: scaled.bytes,
    nativeWidth: size.width,
    nativeHeight: size.height,
    width: scaled.width,
    height: scaled.height,
    backend,
    display: display.id,
    warnings: outWarnings,
  };
}
