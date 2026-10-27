// adapters/macos.js — macOS 后端（screencapture + sips），contract.md §1.1 / §16。
//
// 只做“平台命令 → 原始字节”：采集到 run.tmpDir 里的临时 PNG，读成内存字节后
// **成功与失败路径都删除临时文件**；落盘/命名/附件由 service.js 独占。
//
// 事实边界（必须诚实标注）：
//  - 本仓库没有 macOS 真机，等级只能 experimental；
//  - Retina 比例以实际 PNG 尺寸为准，不写死 2x；
//  - 零依赖下无法枚举窗口 id，因此 window 目标必须显式给 id，否则 unsupported_target
//    （noninteractive_unsupported），绝不启动会卡住 agent 的交互式选择；
//  - 多显示器时无法在零依赖下确定各显示器的物理原点 → region 明确拒绝，不猜坐标。

import { createHash, randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { readPngSize } from '../png.js';

const BACKEND_NAME = 'macos-screencapture';

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

function parseResolution(text) {
  const m = String(text || '').match(/(\d{2,5})\s*[x×]\s*(\d{2,5})/);
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (!(width > 0) || !(height > 0)) return null;
  return { width, height };
}

function pickString(entry, keys) {
  for (const key of keys) {
    const value = entry && entry[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function collectDisplayEntries(json) {
  const gpus = Array.isArray(json && json.SPDisplaysDataType) ? json.SPDisplaysDataType : [];
  const entries = [];
  for (const gpu of gpus) {
    const ndrvs = gpu && gpu.spdisplays_ndrvs;
    if (Array.isArray(ndrvs) && ndrvs.length > 0) {
      for (const item of ndrvs) entries.push(item);
    } else if (gpu && typeof gpu === 'object') {
      entries.push(gpu);
    }
  }
  return entries;
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

function permissionHint() {
  return 'System Settings > Privacy & Security > Screen Recording: allow the host app, then restart it';
}

async function listDisplays(run) {
  const result = await run.exec('system_profiler', ['SPDisplaysDataType', '-json'], {
    timeoutMs: Math.min(run.timeoutMs, 8000),
    signal: run.signal,
    env: run.env,
  });

  const warnings = [];
  let entries = [];
  if (result.ok) {
    try {
      entries = collectDisplayEntries(JSON.parse(result.stdout));
    } catch {
      warnings.push('quality_unverified');
    }
  } else {
    warnings.push('quality_unverified');
  }

  const displays = [];
  entries.forEach((entry, index) => {
    const points = parseResolution(pickString(entry, ['_spdisplays_resolution', 'spdisplays_resolution']));
    const pixels = parseResolution(pickString(entry, ['_spdisplays_pixels', 'spdisplays_pixels']));
    const pointSize = points || pixels;
    const pixelSize = pixels || points;
    if (!pointSize || !pixelSize) return;
    const scale = pointSize.width > 0 ? Math.round((pixelSize.width / pointSize.width) * 1000) / 1000 : null;
    displays.push({
      id: shortHash('mac|' + index + '|' + pointSize.width + 'x' + pointSize.height + '|' + pixelSize.width + 'x' + pixelSize.height),
      x: 0,
      y: 0,
      width: Math.round(pixelSize.width),
      height: Math.round(pixelSize.height),
      ...(scale && scale > 0 ? { scaleFactor: scale } : {}),
      primary: index === 0,
      // 内部换算用（不进入 probe 输出）
      pointSize: { width: Math.round(pointSize.width), height: Math.round(pointSize.height) },
      index,
    });
  });

  if (displays.length === 0) {
    displays.push({
      id: shortHash('mac|primary|fallback'),
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      primary: true,
      pointSize: null,
      index: 0,
    });
    warnings.push('quality_unverified');
  }

  return { displays, warnings };
}

function publicDisplay(entry) {
  if (!entry) return null;
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

function indexForDisplay(displayId, displays) {
  if (!displayId) return 0;
  const index = displays.findIndex((item) => item.id === displayId);
  return index;
}

function classifyFailure(result, context) {
  const text = shortDetail(String(result.stderr || '') + ' ' + String(result.stdout || ''));
  if (/screen recording|not authorized|not permitted|could not create image|unable to capture/i.test(text)) {
    return fail('permission_required', 'macOS denied screen capture; Screen Recording permission is missing', {
      details: { backend: BACKEND_NAME, permission: 'Screen Recording', target: context.target },
      hint: permissionHint(),
    });
  }
  if (result.timedOut) {
    return fail('capture_timeout', 'screencapture exceeded its time budget; its process tree was killed', {
      details: { timeoutMs: result.timeoutMs || null, backend: BACKEND_NAME },
    });
  }
  if (result.aborted) {
    return fail('capture_timeout', 'the capture was aborted and its process tree was killed', {
      details: { reason: 'aborted', backend: BACKEND_NAME },
      retryable: true,
    });
  }
  if (/no such window|window .* not found|invalid window/i.test(text)) {
    return fail('window_not_found', 'macOS could not find the requested window', {
      details: { reason: 'window_missing', window: context.window || null, backend: BACKEND_NAME },
      hint: 'pass a live window id, or capture the display instead',
    });
  }
  return fail('capture_failed', 'screencapture failed', {
    details: { backend: BACKEND_NAME, exitCode: result.exitCode, stderrTail: text, target: context.target },
    hint: 'run capture_probe; retry after granting Screen Recording permission',
  });
}

/** 只读诊断：显示器与依赖。绝不截图。 */
export async function probe(_ctx, run) {
  const available = Boolean(run.findExe('screencapture'));
  const backends = [
    { name: BACKEND_NAME, available, ...(available ? {} : { missing: ['screencapture'] }) },
    ...(run.findExe('sips') ? [{ name: 'macos-sips', available: true }] : [{ name: 'macos-sips', available: false, missing: ['sips'] }]),
  ];

  if (!available) {
    return {
      platform: 'darwin',
      sessionType: 'unknown',
      headless: false,
      displays: [],
      backends,
      permissions: { status: 'unknown', note: 'screencapture is missing, so permission state cannot be probed' },
      targets: { display: 'unsupported', window: 'unsupported', region: 'unsupported' },
      // 缺失的依赖由 backends[].missing 表达；warnings 只放契约词表内的 id
      warnings: [],
    };
  }

  const { displays, warnings } = await listDisplays(run);
  return {
    platform: 'darwin',
    sessionType: 'console',
    headless: false,
    displays: displays.map(publicDisplay),
    backends,
    permissions: {
      status: 'unknown',
      note: 'macOS reports the Screen Recording permission only when a capture is attempted',
    },
    targets: { display: 'experimental', window: 'experimental', region: 'experimental' },
    warnings,
  };
}

/** 采集一次，返回内存 PNG 字节；临时文件在成功与失败路径都会被删除。 */
export async function capture(request, run) {
  const tmpPath = join(run.tmpDir || '', 'dsh-capture-mac-' + randomUUID() + '.png');
  const screencapture = run.findExe('screencapture') || '/usr/sbin/screencapture';

  try {
    const { displays } = await listDisplays(run);
    const index = indexForDisplay(request.display, displays);
    if (index < 0) {
      return fail('invalid_argument', 'display id does not match any current display', {
        details: { reason: 'display_unknown', display: request.display, backend: BACKEND_NAME },
        hint: 'call capture_probe to get the current display ids',
      });
    }
    const entry = displays[index];
    const args = ['-x', '-t', 'png'];

    if (request.target === 'window') {
      const id = String(request.window || '').trim();
      if (!id) {
        return fail('unsupported_target', 'macOS needs an explicit window id; interactive window picking is refused', {
          details: { target: 'window', platform: 'darwin', supported: ['display', 'window with id', 'region'], backend: BACKEND_NAME },
          hint: 'noninteractive_unsupported: pass a window id, or capture the display and crop with a region',
        });
      }
      if (!/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(id)) {
        return fail('unsupported_target', 'macOS window must be a numeric window id', {
          details: { target: 'window', platform: 'darwin', reason: 'window_id_not_numeric', backend: BACKEND_NAME },
          hint: 'noninteractive_unsupported: pass a numeric window id',
        });
      }
      args.push('-l', id, '-o', tmpPath);
    } else if (request.target === 'region') {
      if (!request.region) {
        return fail('invalid_region', 'target "region" requires a region object', { details: { reason: 'region_missing' } });
      }
      if (displays.length > 1) {
        return fail('invalid_region', 'macOS cannot map physical region coordinates across multiple displays', {
          details: { reason: 'region_requires_single_display', displays: displays.length, backend: BACKEND_NAME },
          hint: 'capture the display, or use a single-display Mac for region capture',
        });
      }
      const scale = entry.scaleFactor && entry.scaleFactor > 0 ? entry.scaleFactor : null;
      if (!scale || !entry.pointSize) {
        return fail('invalid_region', 'macOS cannot convert physical pixels for this display (pixel/point ratio unknown)', {
          details: { reason: 'region_scale_unknown', display: entry.id, backend: BACKEND_NAME },
          hint: 'capture target "display" and crop afterwards',
        });
      }
      const px = Math.round(request.region.x / scale);
      const py = Math.round(request.region.y / scale);
      const pw = Math.max(1, Math.round(request.region.width / scale));
      const ph = Math.max(1, Math.round(request.region.height / scale));
      if (px + pw > entry.pointSize.width || py + ph > entry.pointSize.height) {
        return fail('invalid_region', 'region exceeds the selected display bounds (cross-display is not supported)', {
          details: {
            reason: 'region_out_of_bounds',
            display: entry.id,
            bounds: { x: 0, y: 0, width: entry.width, height: entry.height },
          },
        });
      }
      args.push('-R', `${px},${py},${pw},${ph}`, tmpPath);
    } else if (request.target === 'display') {
      args.push('-D', String(index + 1), tmpPath);
    } else {
      return fail('unsupported_target', `the macOS backend does not support target "${request.target}"`, {
        details: { target: request.target, platform: 'darwin', supported: ['display', 'window', 'region'] },
      });
    }

    const result = await run.exec(screencapture, args, { timeoutMs: run.timeoutMs, signal: run.signal, env: run.env });
    if (!result.ok) {
      return classifyFailure(result, { target: request.target, window: request.window });
    }

    let bytes;
    try {
      bytes = await readFile(tmpPath);
    } catch (e) {
      return fail('permission_required', 'screencapture produced no file; Screen Recording permission is likely missing', {
        details: { backend: BACKEND_NAME, reason: 'no_output_file', target: request.target },
        hint: permissionHint(),
      });
    }

    const before = readPngSize(bytes);
    if (!before) {
      return fail('invalid_output', 'screencapture wrote a file that is not a valid PNG', {
        details: { reason: 'png_invalid', backend: BACKEND_NAME },
      });
    }

    const warnings = [];
    let finalBytes = bytes;
    let finalSize = before;

    if (request.maxWidth && request.maxWidth > 0 && request.maxWidth < before.width) {
      if (!run.findExe('sips')) {
        // 契约 §16.5 词表已不含 scale_skipped_backend_missing：无法兑现 maxWidth 就明确失败，不静默降级
        return fail('backend_unavailable', 'macOS cannot downscale because sips is missing, so maxWidth cannot be honored', {
          details: { backend: BACKEND_NAME, missing: ['sips'], reason: 'resize_backend_missing' },
          hint: 'sips ships with macOS; restore it or drop maxWidth',
        });
      }
      const sips = await run.exec(
        run.findExe('sips'),
        ['--resampleWidth', String(request.maxWidth), tmpPath],
        { timeoutMs: run.timeoutMs, signal: run.signal, env: run.env },
      );
      if (!sips.ok) {
        return fail('capture_failed', 'sips failed to downscale the capture', {
          details: { backend: BACKEND_NAME, exitCode: sips.exitCode, stderrTail: shortDetail(sips.stderr) },
        });
      }
      finalBytes = await readFile(tmpPath);
      finalSize = readPngSize(finalBytes);
      if (!finalSize) {
        return fail('invalid_output', 'sips produced an unreadable PNG', { details: { reason: 'png_invalid', backend: BACKEND_NAME } });
      }
    }

    return {
      bytes: finalBytes,
      nativeWidth: before.width,
      nativeHeight: before.height,
      width: finalSize.width,
      height: finalSize.height,
      backend: BACKEND_NAME,
      display: entry.id,
      warnings,
    };
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}
