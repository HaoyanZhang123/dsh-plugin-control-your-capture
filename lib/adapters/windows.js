// adapters/windows.js — Windows 后端（contract.md §1.1：probe(ctx, run) / capture(request, run)）。
//
// 只做“平台命令 → 原始结果”：调用 native/windows-shot.ps1，解析单行 JSON，
// 把临时 PNG 读成内存字节后删掉临时文件。不构造对外结果、不定义新错误码、不落最终文件。
// 进程执行/依赖查找/临时路径全部由 service 注入的 `run` 提供（spawn 只有 service 一处）。

import { readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readPngSize } from '../png.js';

const BACKEND_NAME = 'windows-gdi';
const SCRIPT_PATH = fileURLToPath(new URL('../native/windows-shot.ps1', import.meta.url));

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

function shortDetail(text, limit = 400) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? value.slice(0, limit) + '…' : value;
}

/** 取最后一行可解析的 JSON（忽略 CLIXML 等噪声）。 */
function parseJsonLine(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      return JSON.parse(line);
    } catch {
      /* 继续往前找 */
    }
  }
  return null;
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

function powershellPath(run) {
  const env = run.env || {};
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || env.windir || '';
  if (systemRoot) {
    const direct = String(systemRoot).replace(/[\\/]+$/, '') + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const found = run.findExe(direct);
    if (found) return found;
  }
  return run.findExe('powershell.exe') || run.findExe('pwsh.exe') || run.findExe('pwsh') || null;
}

function scriptPath(run) {
  // native/ 与 adapters/ 同级，用包内相对定位（run 里带 nativeScript 时优先，便于测试替身）
  return run.nativeScript || SCRIPT_PATH;
}

async function invoke(mode, extraArgs, run, timeoutMs) {
  const shell = powershellPath(run);
  if (!shell) {
    return fail('backend_unavailable', 'no PowerShell available to run the Windows native helper', {
      details: { backend: BACKEND_NAME, missing: ['powershell.exe'] },
      hint: 'check %SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    });
  }
  const script = scriptPath(run);
  const argv = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    String(script),
    '-Mode',
    mode,
    ...extraArgs,
  ];
  const result = await run.exec(shell, argv, { timeoutMs: timeoutMs || run.timeoutMs, signal: run.signal });
  if (result.timedOut) {
    return fail('capture_timeout', 'the Windows native helper exceeded its time budget; its process tree was killed', {
      details: { timeoutMs: timeoutMs || run.timeoutMs, backend: BACKEND_NAME },
      hint: 'retry once; if it keeps timing out capture a region instead of the whole display',
    });
  }
  if (result.aborted) {
    return fail('capture_timeout', 'the capture was aborted and its process tree was killed', {
      details: { reason: 'aborted', backend: BACKEND_NAME },
      retryable: true,
      hint: 'retry the capture',
    });
  }
  if (result.spawnError) {
    return fail('backend_unavailable', 'could not start the Windows native helper', {
      details: { reason: shortDetail(result.spawnError), backend: BACKEND_NAME },
      hint: 'run capture_probe to confirm the backend is available',
    });
  }
  const payload = parseJsonLine(result.stdout);
  if (!payload) {
    return fail('capture_failed', 'the Windows native helper returned no parsable JSON', {
      details: { exitCode: result.exitCode, stderrTail: shortDetail(result.stderr), backend: BACKEND_NAME },
      hint: 'run capture_probe; if it also fails the native helper is broken',
    });
  }
  return payload;
}

function targetsFor(sessionType, displayCount) {
  if (sessionType === 'rdp') {
    return { display: 'experimental', window: 'unsupported', region: 'experimental' };
  }
  if (displayCount > 1) {
    return { display: 'experimental', window: 'experimental', region: 'experimental' };
  }
  return { display: 'beta', window: 'beta', region: 'beta' };
}

/**
 * 只读诊断（契约 §5 的数据来源）。绝不截图。
 */
export async function probe(_ctx, run) {
  const payload = await invoke('probe', [], run, Math.min(run.timeoutMs, 10000));

  if (payload.ok !== true) {
    if (payload.code === 'no_display') {
      return {
        platform: 'win32',
        sessionType: 'headless',
        headless: true,
        displays: [],
        backends: [{ name: BACKEND_NAME, available: false, missing: ['interactive desktop session'] }],
        permissions: { status: 'not_applicable', note: 'no interactive desktop in this session' },
        targets: { display: 'unsupported', window: 'unsupported', region: 'unsupported' },
        warnings: [],
      };
    }
    return {
      platform: 'win32',
      sessionType: 'unknown',
      headless: false,
      displays: [],
      backends: [
        {
          name: BACKEND_NAME,
          available: false,
          missing: ['powershell.exe', 'windows-shot.ps1', String(payload.code || 'native helper failure')],
        },
      ],
      permissions: { status: 'unknown', note: shortDetail(payload.message) },
      targets: { display: 'unsupported', window: 'unsupported', region: 'unsupported' },
      // 探针没跑通 → 无法验证任何采集能力；不谎报 headless（§16.12）
      warnings: ['quality_unverified'],
    };
  }

  const displays = toArray(payload.displays)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const bounds = item.bounds || {};
      const x = Number(bounds.x);
      const y = Number(bounds.y);
      const width = Number(bounds.width);
      const height = Number(bounds.height);
      const id = typeof item.id === 'string' ? item.id : '';
      if (!id || ![x, y, width, height].every((n) => Number.isFinite(n)) || width <= 0 || height <= 0) return null;
      const scale = Number(item.scale);
      return {
        id,
        x,
        y,
        width,
        height,
        ...(Number.isFinite(scale) && scale > 0 ? { scaleFactor: scale } : {}),
        primary: item.primary === true,
      };
    })
    .filter(Boolean);

  const sessionType = typeof payload.sessionType === 'string' ? payload.sessionType : 'unknown';
  return {
    platform: 'win32',
    sessionType,
    headless: false,
    displays,
    backends: [{ name: BACKEND_NAME, available: true }],
    permissions: { status: 'not_applicable', note: 'Windows has no per-application Screen Recording permission' },
    targets: targetsFor(sessionType, displays.length),
    warnings: toArray(payload.warnings).filter((w) => typeof w === 'string'),
  };
}

/**
 * 采集一次，返回内存 PNG 字节。
 *
 * @param {{ target:string, display:string|null, window:string|null, region:object|null, maxWidth:number|null }} request
 * @param {{ timeoutMs:number, signal?:AbortSignal, tempFile:()=>string, exec:Function, findExe:Function, env:object }} run
 */
export async function capture(request, run) {
  const rawPath = join(run.tmpDir || '', 'dsh-capture-win-' + randomUUID() + '.png');
  const args = [];

  if (request.target === 'display') {
    if (request.display) args.push('-DisplayId', request.display);
  } else if (request.target === 'region') {
    if (!request.region) {
      return fail('invalid_region', 'target "region" requires a region object', {
        details: { reason: 'region_missing' },
      });
    }
    args.push(
      '-X',
      String(request.region.x),
      '-Y',
      String(request.region.y),
      '-W',
      String(request.region.width),
      '-H',
      String(request.region.height),
    );
    if (request.display) args.push('-DisplayId', request.display);
  } else if (request.target === 'window') {
    if (request.window) args.push('-Window', String(request.window));
  } else {
    return fail('unsupported_target', `the Windows backend does not support target "${request.target}"`, {
      details: { target: request.target, platform: 'win32', supported: ['display', 'window', 'region'] },
      hint: 'use target "display", "window" or "region"',
    });
  }

  args.push('-Out', rawPath);
  if (request.maxWidth) args.push('-MaxWidth', String(request.maxWidth));

  try {
    const payload = await invoke(request.target, args, run, run.timeoutMs);

    if (payload.ok !== true) {
      const code = typeof payload.code === 'string' ? payload.code : 'capture_failed';
      return fail(code, String(payload.message || 'the Windows native capture failed'), {
        details: {
          ...(payload.details && typeof payload.details === 'object' ? payload.details : {}),
          backend: BACKEND_NAME,
        },
        ...(payload.hint ? { hint: String(payload.hint) } : {}),
        ...(payload.retryable === true ? { retryable: true } : {}),
      });
    }

    let bytes;
    try {
      bytes = await readFile(rawPath);
    } catch (e) {
      return fail('invalid_output', 'the Windows native helper reported success but its PNG is unreadable', {
        details: { reason: 'read_failed', backend: BACKEND_NAME },
      });
    }

    const size = readPngSize(bytes);
    if (!size) {
      return fail('invalid_output', 'the Windows native helper wrote a file that is not a valid PNG', {
        details: { reason: 'png_invalid', backend: BACKEND_NAME },
      });
    }

    const display = payload.display && typeof payload.display === 'object' && typeof payload.display.id === 'string'
      ? payload.display.id
      : '';

    return {
      bytes,
      nativeWidth: Number(payload.nativeWidth) > 0 ? Number(payload.nativeWidth) : size.width,
      nativeHeight: Number(payload.nativeHeight) > 0 ? Number(payload.nativeHeight) : size.height,
      width: size.width,
      height: size.height,
      backend: BACKEND_NAME,
      display,
      warnings: toArray(payload.warnings).filter((w) => typeof w === 'string'),
    };
  } finally {
    await unlink(rawPath).catch(() => {});
  }
}
