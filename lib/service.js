// service.js — 唯一截图服务（contract.md §1.1 / §4 / §7 / §8 / §9）。
//
// 唯一执行路径：只有本文件决定“怎么截、能不能截、结果与错误长什么样”，
// 也只有本文件 spawn 外部命令（含超时、AbortSignal、进程树清理）。
// tool.js 只做 schema/render 映射；adapters/* 只做“平台命令 → 原始字节”。
//
// 对外（契约签名）：
//   createCaptureService(ctx, config, deps) -> { screenshot(args, exec), probe(args, exec) }
//   deps = { png, paths, backend, provisionSkill }（缺省用本包实现/按平台选后端）
//
// 失败一律 throw：message 首行固定 `capture_screenshot failed [<code>]: <message>`，
// 随后可选 `details: <单行 JSON ≤1KiB>` 与 `hint: <一句话>`（契约 §9.1）。
// quality_unverified / skill_shadowed 是**非失败标识**，只进 warnings / probe 状态（§9.2）。

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import * as defaultPng from './png.js';
import * as defaultPaths from './paths.js';
import * as darwinBackend from './adapters/macos.js';
import * as linuxBackend from './adapters/linux.js';
import * as windowsBackend from './adapters/windows.js';

/** 契约 §9.1：11 个失败码（全部 throw）。 */
export const CAPTURE_FAILURE_CODES = Object.freeze([
  'invalid_argument',
  'invalid_region',
  'workspace_unavailable',
  'no_display',
  'permission_required',
  'backend_unavailable',
  'unsupported_target',
  'window_not_found',
  'capture_timeout',
  'capture_failed',
  'invalid_output',
]);

/**
 * 契约 §16.11 的 warnings 封闭词表，**最终 7 个**（新增第 8 个必须先改契约）。
 * service 只做去重与保序，**不过滤**；越界 id 由静态门禁（warning-vocabulary 用例）拦住。
 */
export const CAPTURE_WARNING_IDS = Object.freeze([
  'active_display_unavailable',
  'quality_unverified',
  'model_image_downscaled',
  'attachment_reencoded',
  'out_renamed',
  'skill_shadowed',
  'content_uniform',
]);

/** 本包根目录（skillStatus 需要它，避免让 index.js 额外传参）。 */
const PKG_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const FAILURE_SET = new Set(CAPTURE_FAILURE_CODES);
const TARGETS = ['display', 'window', 'region'];
const TARGET_SET = new Set(TARGETS);

const MAX_STREAM_BYTES = 1024 * 1024;
const DETAILS_LIMIT = 1024;
const DEFAULT_TIMEOUT_MS = 20000;
const KILL_GRACE_MS = 3000;

const PLATFORM_BACKENDS = {
  win32: { name: 'windows-gdi', module: windowsBackend },
  darwin: { name: 'macos-screencapture', module: darwinBackend },
  linux: { name: 'linux', module: linuxBackend },
};

/**
 * 未知平台占位后端——**平台→后端映射与占位实现的唯一出处**（P3/R5：index.js 不再复制第二份）。
 *
 * import 期绝不抛错，运行期一律 throw `unsupported_target`：
 * adapter 失败即 throw（契约 §16.7.1），service 只认"带 bytes 的成功结果"或"throw"，
 * 返回 `{ok:false}` 会退化成 capture_failed/no_bytes 把 code 弄错。
 * probe 同样 throw：输出 schema 的 platform 枚举只有 win32/darwin/linux，
 * 返回真实平台会被 INVALID_TOOL_OUTPUT 丢弃、返回 'linux' 又是编造平台，
 * 所以选择诚实的结构化失败（真实平台放 details.platform）。
 */
function createUnsupportedBackend(platform) {
  const buildError = () => {
    const message = `screen capture is not implemented for platform ${platform}`;
    const error = new Error(message);
    error.failure = {
      code: 'unsupported_target',
      message,
      details: { platform, supported: ['win32', 'darwin', 'linux'] },
      hint: 'this plugin supports Windows, macOS and Linux only',
    };
    return error;
  };

  return {
    name: 'unsupported',
    async probe() {
      throw buildError();
    },
    async capture() {
      throw buildError();
    },
  };
}

// ---------------------------------------------------------------------------
// 结构化失败：构造 / 规范化 / 渲染
// ---------------------------------------------------------------------------

function safeDetails(details) {
  if (!details || typeof details !== 'object') return undefined;
  try {
    const json = JSON.stringify(details);
    if (json.length <= DETAILS_LIMIT) return details;
    return { truncated: json.slice(0, DETAILS_LIMIT - 40) + '...' };
  } catch {
    return { reason: 'details_not_serializable' };
  }
}

/** 渲染契约 §9.1 的固定文本（code 必须在首行，因为模型只读文本）。 */
export function formatFailure(toolName, failure) {
  const code = FAILURE_SET.has(failure.code) ? failure.code : 'capture_failed';
  const message = failure.message ? String(failure.message) : 'unknown failure';
  const lines = [`${toolName} failed [${code}]: ${message}`];
  const details = safeDetails(failure.details);
  if (details) {
    let json = '{}';
    try {
      json = JSON.stringify(details);
    } catch {
      json = '{"reason":"details_not_serializable"}';
    }
    lines.push('details: ' + json);
  }
  if (failure.hint) lines.push('hint: ' + String(failure.hint));
  return lines.join('\n');
}

function makeFailure(code, message, extra = {}) {
  return {
    code: FAILURE_SET.has(code) ? code : 'capture_failed',
    message: String(message || ''),
    ...(extra.details && typeof extra.details === 'object' ? { details: extra.details } : {}),
    ...(extra.hint ? { hint: String(extra.hint) } : {}),
  };
}

/** 抛出带 `failure` 属性的 Error；message 已是三行文本。 */
function throwFailure(toolName, failure) {
  const normalized = makeFailure(failure.code, failure.message, failure);
  const error = new Error(formatFailure(toolName, normalized));
  error.failure = normalized;
  throw error;
}

/** 把任意章节里的异常统一成结构化 failure。 */
function failureFromError(error) {
  if (error && error.failure && error.failure.code) return error.failure;
  return makeFailure('capture_failed', `unexpected failure: ${(error && error.message) || String(error)}`);
}

/** 只认 adapter 自己声明的 `.failure`（不兜底成 capture_failed），供 probe 区分“平台不支持”。 */
function backendFailureOf(error) {
  return error && error.failure && typeof error.failure.code === 'string' ? error.failure : null;
}

// ---------------------------------------------------------------------------
// 进程执行（唯一 spawn 实现）
// ---------------------------------------------------------------------------

function clampTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(n), 1000), 120000);
}

function isExecutableFile(filePath, platform) {
  try {
    const info = statSync(filePath);
    if (!info.isFile()) return false;
    if (platform === 'win32') return true;
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 在 PATH 中查找可执行文件（只做存在性判断，不启动进程）。 */
export function findExe(name, env = process.env, platform = process.platform) {
  if (!name || typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (/^[a-zA-Z]:/.test(trimmed) || trimmed.startsWith('/') || trimmed.includes('\\') || trimmed.includes('/')) {
    return isExecutableFile(resolve(trimmed), platform) ? resolve(trimmed) : null;
  }
  const pathValue = env.PATH || env.Path || '';
  const exts = platform === 'win32' ? ['', '.exe', '.cmd', '.bat', '.com'] : [''];
  for (const dir of String(pathValue).split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, trimmed + ext);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return null;
}

/** 杀掉整个进程树：Windows taskkill /T /F；POSIX 进程组 SIGKILL。 */
function killProcessTree(child) {
  if (!child || child.pid === undefined || child.pid === null) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 5000,
      });
    } catch {
      /* ignore */
    }
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

/**
 * 有界执行外部命令；超时或 AbortSignal 时清理整个进程树。
 *
 * @param {string} file
 * @param {string[]} argv
 * @param {{ timeoutMs?: number, env?: Record<string,string|undefined>, signal?: AbortSignal }} [options]
 * @returns {Promise<{ ok:boolean, exitCode:number|null, signal:string|null, timedOut:boolean, aborted:boolean,
 *   stdout:string, stderr:string, spawnError:string|null, errorCode:string|null, durationMs:number }>}
 */
export function runBounded(file, argv, options = {}) {
  const timeoutMs = clampTimeout(options.timeoutMs);
  const childEnv = options.env || process.env;
  const abortSignal = options.signal || null;
  const startedAt = Date.now();

  return new Promise((resolvePromise) => {
    let child = null;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let timer = null;
    let watchdog = null;
    let stdout = '';
    let stderr = '';

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (watchdog) clearTimeout(watchdog);
      if (abortSignal && typeof abortSignal.removeEventListener === 'function') {
        abortSignal.removeEventListener('abort', onAbort);
      }
      resolvePromise({ durationMs: Date.now() - startedAt, ...payload });
    };

    const onAbort = () => {
      aborted = true;
      killProcessTree(child);
      setTimeout(() => {
        finish({ ok: false, exitCode: null, signal: null, timedOut, aborted: true, stdout, stderr, spawnError: null, errorCode: 'ABORTED' });
      }, 200).unref?.();
    };

    if (abortSignal && abortSignal.aborted) {
      finish({ ok: false, exitCode: null, signal: null, timedOut: false, aborted: true, stdout: '', stderr: '', spawnError: null, errorCode: 'ABORTED' });
      return;
    }

    const collect = (chunk, sink) => {
      if (sink === 'stdout') {
        if (stdout.length < MAX_STREAM_BYTES) stdout += chunk;
      } else if (stderr.length < MAX_STREAM_BYTES) {
        stderr += chunk;
      }
    };

    try {
      child = spawn(file, argv, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: childEnv,
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      finish({
        ok: false,
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: false,
        stdout: '',
        stderr: '',
        spawnError: (e && e.message) || 'spawn failed',
        errorCode: (e && e.code) || null,
      });
      return;
    }

    if (child.stdout) child.stdout.setEncoding('utf8');
    if (child.stderr) child.stderr.setEncoding('utf8');
    if (child.stdout) child.stdout.on('data', (chunk) => collect(chunk, 'stdout'));
    if (child.stderr) child.stderr.on('data', (chunk) => collect(chunk, 'stderr'));

    if (abortSignal && typeof abortSignal.addEventListener === 'function') {
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => {
      finish({
        ok: false,
        exitCode: null,
        signal: null,
        timedOut,
        aborted,
        stdout,
        stderr,
        spawnError: (err && err.message) || 'child error',
        errorCode: (err && err.code) || null,
      });
    });

    child.on('close', (code, signal) => {
      finish({
        ok: !timedOut && !aborted && code === 0,
        exitCode: typeof code === 'number' ? code : null,
        signal: signal || null,
        timedOut,
        aborted,
        stdout,
        stderr,
        spawnError: null,
        errorCode: null,
      });
    });

    timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      watchdog = setTimeout(() => {
        finish({ ok: false, exitCode: null, signal: null, timedOut: true, aborted, stdout, stderr, spawnError: null, errorCode: 'TIMEOUT' });
      }, KILL_GRACE_MS);
      if (watchdog && typeof watchdog.unref === 'function') watchdog.unref();
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
}

// ---------------------------------------------------------------------------
// 参数规范化（契约 §3.1）
// ---------------------------------------------------------------------------

function isInt(value) {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * @param {object} rawArgs
 * @param {{ defaultMaxWidth?: number }} [options]
 * @returns {{ target:string, display:string|null, window:string|null, region:object|null, out:string|null|undefined, maxWidth:number|null }}
 */
export function normalizeScreenshotArgs(rawArgs, options = {}) {
  if (rawArgs !== undefined && rawArgs !== null && (typeof rawArgs !== 'object' || Array.isArray(rawArgs))) {
    throwFailure('capture_screenshot', {
      code: 'invalid_argument',
      message: 'screenshot arguments must be an object',
      details: { reason: 'args_not_object' },
      hint: 'pass an object such as { "target": "display" }',
    });
  }
  const args = rawArgs || {};

  let target = 'display';
  if (args.target !== undefined && args.target !== null) {
    if (typeof args.target !== 'string') {
      throwFailure('capture_screenshot', {
        code: 'invalid_argument',
        message: 'target must be a string',
        details: { reason: 'target_not_string' },
        hint: `use one of ${TARGETS.join(', ')}`,
      });
    }
    if (args.target === 'all') {
      throwFailure('capture_screenshot', {
        code: 'unsupported_target',
        message: 'target "all" is not supported in 0.2.0',
        details: { reason: 'target_all', target: 'all', platform: process.platform, supported: TARGETS },
        hint: 'capture each display separately with target "display"',
      });
    }
    if (!TARGET_SET.has(args.target)) {
      throwFailure('capture_screenshot', {
        code: 'invalid_argument',
        message: `unknown target "${args.target}"`,
        details: { reason: 'target_unknown', target: args.target, supported: TARGETS },
        hint: `use one of ${TARGETS.join(', ')}`,
      });
    }
    target = args.target;
  }

  let display = null;
  if (args.display !== undefined && args.display !== null) {
    if (typeof args.display !== 'string' || args.display.trim() === '') {
      throwFailure('capture_screenshot', {
        code: 'invalid_argument',
        message: 'display must be a non-empty opaque id string',
        details: { reason: 'display_not_string' },
        hint: 'call capture_probe and pass one of the returned display ids',
      });
    }
    display = args.display.trim();
  }

  let windowId = null;
  if (args.window !== undefined && args.window !== null) {
    if (typeof args.window !== 'string' || args.window.trim() === '') {
      throwFailure('capture_screenshot', {
        code: 'invalid_argument',
        message: 'window must be a non-empty backend window id string',
        details: { reason: 'window_not_string' },
        hint: 'omit window to capture the foreground window',
      });
    }
    windowId = args.window.trim();
    if (target !== 'window') {
      throwFailure('capture_screenshot', {
        code: 'invalid_argument',
        message: 'window is only meaningful when target is "window"',
        details: { reason: 'window_without_target', target, window: windowId },
        hint: 'set target to "window" or drop the window argument',
      });
    }
  }

  let region = null;
  if (args.region !== undefined && args.region !== null) {
    if (typeof args.region !== 'object' || Array.isArray(args.region)) {
      throwFailure('capture_screenshot', {
        code: 'invalid_argument',
        message: 'region must be an object with integer x, y, width, height',
        details: { reason: 'region_not_object' },
        hint: 'pass { "x": 0, "y": 0, "width": 800, "height": 500 }',
      });
    }
    if (target !== 'region') {
      throwFailure('capture_screenshot', {
        code: 'invalid_argument',
        message: 'region is only meaningful when target is "region"',
        details: { reason: 'region_without_target', target },
        hint: 'set target to "region" or drop the region argument',
      });
    }
    const { x, y, width, height } = args.region;
    if (!isInt(x) || !isInt(y) || !isInt(width) || !isInt(height)) {
      throwFailure('capture_screenshot', {
        code: 'invalid_region',
        message: 'region x, y, width and height must be integers (physical pixels)',
        details: { reason: 'region_non_integer', region: { x, y, width, height } },
        hint: 'use integer pixel values relative to the display top-left corner',
      });
    }
    if (x < 0 || y < 0) {
      throwFailure('capture_screenshot', {
        code: 'invalid_region',
        message: `region origin ${x},${y} is negative; coordinates are relative to the display top-left`,
        details: { reason: 'region_negative_origin', region: { x, y, width, height } },
        hint: 'use x >= 0 and y >= 0',
      });
    }
    if (width <= 0 || height <= 0) {
      throwFailure('capture_screenshot', {
        code: 'invalid_region',
        message: `region size ${width}x${height} is not positive`,
        details: { reason: 'region_non_positive_size', region: { x, y, width, height } },
        hint: 'use width >= 1 and height >= 1',
      });
    }
    region = { x, y, width, height };
  }
  if (target === 'region' && !region) {
    throwFailure('capture_screenshot', {
      code: 'invalid_region',
      message: 'target "region" requires a region object',
      details: { reason: 'region_missing' },
      hint: 'pass region { x, y, width, height } in physical pixels',
    });
  }

  let out;
  if (args.out !== undefined && args.out !== null) {
    if (typeof args.out !== 'string') {
      throwFailure('capture_screenshot', {
        code: 'invalid_argument',
        message: 'out must be a string relative path inside the workspace',
        details: { reason: 'out_not_string' },
        hint: 'omit out to write output/capture/<uuid>.png',
      });
    }
    out = args.out;
  }

  let maxWidth = null;
  if (args.maxWidth !== undefined && args.maxWidth !== null) {
    if (!isInt(args.maxWidth) || args.maxWidth <= 0) {
      throwFailure('capture_screenshot', {
        code: 'invalid_argument',
        message: 'maxWidth must be a positive integer',
        details: { reason: 'max_width_invalid', maxWidth: args.maxWidth },
        hint: 'use maxWidth >= 1; the tool never upscales',
      });
    }
    maxWidth = args.maxWidth;
  } else if (isInt(options.defaultMaxWidth) && options.defaultMaxWidth > 0) {
    maxWidth = options.defaultMaxWidth;
  }

  return { target, display, window: windowId, region, out, maxWidth };
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

/**
 * 去重 + 保序，**不过滤**（契约 §16.11：adapter 返回什么就透传什么）。
 * 词表由静态门禁守住（run-tool-verify 的 warning-vocabulary 用例），
 * 运行时静默丢弃会让“黑图 ok:true”这类问题零线索。
 */
function normalizeWarnings(list) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function normalizeProbeDisplay(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  const x = Number(raw.x);
  const y = Number(raw.y);
  const width = Number(raw.width);
  const height = Number(raw.height);
  if (!id || ![x, y, width, height].every((n) => Number.isFinite(n))) return null;
  const scale = Number(raw.scaleFactor);
  return {
    id,
    x,
    y,
    width,
    height,
    ...(Number.isFinite(scale) && scale > 0 ? { scaleFactor: scale } : {}),
    primary: raw.primary === true,
  };
}

function normalizeBackends(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== 'object') continue;
    const name = typeof item.name === 'string' ? item.name : '';
    if (!name) continue;
    const entry = { name, available: item.available === true };
    if (Array.isArray(item.missing) && item.missing.length > 0) {
      entry.missing = item.missing.filter((m) => typeof m === 'string');
    }
    out.push(entry);
  }
  return out;
}

function normalizeTargets(raw, headless) {
  const grades = new Set(['stable', 'beta', 'experimental', 'unsupported']);
  const pick = (value) => (grades.has(value) ? value : 'unsupported');
  if (headless) return { display: 'unsupported', window: 'unsupported', region: 'unsupported' };
  return {
    display: pick(raw && raw.display),
    window: pick(raw && raw.window),
    region: pick(raw && raw.region),
  };
}

/**
 * 创建唯一截图服务。
 *
 * @param {object} ctx 插件 context（读 workingDirectory / attachments）
 * @param {{ skillRoot?:string, skillInstall?:boolean, timeoutMs?:number, maxWidth?:number }} config
 * @param {{ png?:object, paths?:object, backend?:object, provisionSkill?:object }} [deps]
 */
export function createCaptureService(ctx, config, deps = {}) {
  const png = deps.png || defaultPng;
  const paths = deps.paths || defaultPaths;
  const provisionSkill = deps.provisionSkill || null;
  const timeoutMs = clampTimeout(config && config.timeoutMs);
  const defaultMaxWidth = config && isInt(config.maxWidth) && config.maxWidth > 0 ? config.maxWidth : undefined;

  const platform = process.platform;
  const platformBackend = PLATFORM_BACKENDS[platform] || null;
  const backend = deps.backend || (platformBackend ? platformBackend.module : createUnsupportedBackend(platform));
  const backendLabel = deps.backend && typeof deps.backend.name === 'string' ? deps.backend.name : platformBackend ? platformBackend.name : 'unsupported';

  const env = process.env;
  // run 的契约字段是 { signal, timeoutMs, tmpDir }（contract §16）；
  // exec/findExe/env 是本实现额外注入的“运行时缝”，保证 spawn/超时/杀进程树只有 service 一处实现。
  const runtime = {
    exec: runBounded,
    findExe: (name) => findExe(name, env, platform),
    env,
  };

  function buildRun(exec, tmpDir) {
    return {
      signal: exec && exec.signal ? exec.signal : undefined,
      timeoutMs,
      tmpDir: tmpDir || tmpdir(),
      ...runtime,
    };
  }

  function attachmentService() {
    if (!ctx || typeof ctx.get !== 'function') return null;
    try {
      const service = ctx.get('attachments');
      return service && typeof service.saveImage === 'function' ? service : null;
    } catch {
      return null;
    }
  }

  /**
   * 只读诊断（契约 §5）：不截图、不写图片；不得因为环境不可用而 throw。
   */
  async function probe(_args, exec) {
    let outputRoot;
    try {
      const root = await paths.resolveOutputRoot(ctx, exec || {});
      outputRoot = { path: root.dir, writable: true };
    } catch (e) {
      const failure = failureFromError(e);
      outputRoot = {
        path: '',
        writable: false,
        reason: (failure.details && failure.details.reason) || failure.code,
      };
    }

    let backendProbe = null;
    let probeFailure = null;
    if (backend && typeof backend.probe === 'function') {
      try {
        backendProbe = await backend.probe(ctx, buildRun({}, null));
      } catch (e) {
        const failure = backendFailureOf(e);
        // 平台本身不支持 → 如实失败；其它探针异常也不编造环境事实（见下）。
        if (failure && failure.code === 'unsupported_target') {
          throwFailure('capture_probe', failure);
        }
        probeFailure = failure || makeFailure('capture_failed', String((e && e.message) || e));
      }
    }

    const probeValue = backendProbe || null;
    // §16.12/P2：探针失败时**不得**谎报 headless；headless 只能来自后端的真实报告。
    const headless = probeValue ? probeValue.headless === true : false;

    let skill = { status: 'disabled' };
    if (provisionSkill && typeof provisionSkill.skillStatus === 'function') {
      try {
        const status = provisionSkill.skillStatus(config || {}, PKG_ROOT);
        if (status && typeof status.status === 'string') skill = status;
      } catch {
        skill = { status: 'failed' };
      }
    }

    const warnings = [];
    if (probeValue && Array.isArray(probeValue.warnings)) {
      for (const item of probeValue.warnings) {
        if (typeof item === 'string' && item.trim()) warnings.push(item.trim());
      }
    }
    // 后端探针失败：不是 headless，而是“无法验证任何采集能力”（§16.11 词表内唯一贴切的 id）
    if (!probeValue) warnings.push('quality_unverified');
    if (skill.status === 'shadowed') warnings.push('skill_shadowed');

    const backendWarning = probeFailure
      ? `${probeFailure.code || 'capture_failed'}: ${String(probeFailure.message || '').slice(0, 160)}`
      : 'backend probe did not run';

    return {
      ok: true,
      platform,
      architecture: process.arch,
      sessionType: ['console', 'rdp', 'wayland', 'x11', 'headless', 'unknown'].includes(probeValue && probeValue.sessionType)
        ? probeValue.sessionType
        : 'unknown',
      headless,
      displays: ((probeValue && probeValue.displays) || []).map(normalizeProbeDisplay).filter(Boolean),
      backends:
        probeValue && Array.isArray(probeValue.backends) && probeValue.backends.length > 0
          ? normalizeBackends(probeValue.backends)
          : [{ name: backendLabel, available: false, missing: [backendWarning] }],
      permissions:
        probeValue && probeValue.permissions && typeof probeValue.permissions === 'object'
          ? {
              status: ['granted', 'denied', 'unknown', 'not_applicable'].includes(probeValue.permissions.status)
                ? probeValue.permissions.status
                : 'unknown',
              note: String(probeValue.permissions.note || ''),
            }
          : { status: 'unknown', note: 'no backend could report a permission state' },
      outputRoot,
      toolRegistered: true,
      skillStatus: typeof skill.status === 'string' ? skill.status : 'failed',
      ...(typeof skill.path === 'string' && skill.path ? { skillPath: skill.path } : {}),
      ...(typeof skill.version === 'string' && skill.version ? { skillVersion: skill.version } : {}),
      ...(typeof skill.contentHash === 'string' && skill.contentHash ? { skillHash: skill.contentHash } : {}),
      targets: normalizeTargets(probeValue && probeValue.targets, headless),
      warnings: [...new Set(warnings)],
    };
  }

  /**
   * 唯一采集入口（契约 §8）。
   */
  async function screenshot(rawArgs, exec) {
    const request = normalizeScreenshotArgs(rawArgs, { defaultMaxWidth });

    if (!backend || typeof backend.capture !== 'function') {
      throwFailure('capture_screenshot', {
        code: 'backend_unavailable',
        message: `no capture backend is available for platform ${platform}`,
        details: { reason: 'no_backend', platform, backend: backendLabel, missing: [] },
        hint: 'this plugin supports Windows, macOS and Linux only',
      });
    }

    // ① 输出根（非猜测）
    let resolved;
    try {
      resolved = await paths.resolveOutputRoot(ctx, exec);
    } catch (e) {
      throwFailure('capture_screenshot', failureFromError(e));
    }

    // ② out → 绝对路径（含父目录 + 可写性）
    let outPath;
    try {
      outPath = paths.resolveOutPath(resolved.root, request.out, randomUUID() + '.png');
    } catch (e) {
      throwFailure('capture_screenshot', failureFromError(e));
    }

    const run = buildRun(exec);

    // ③ 后端采集，返回内存字节
    let raw;
    try {
      raw = await backend.capture(
        {
          target: request.target,
          display: request.display,
          window: request.window,
          region: request.region,
          out: request.out,
          maxWidth: request.maxWidth,
        },
        run,
      );
    } catch (e) {
      throwFailure('capture_screenshot', failureFromError(e));
    }

    if (!raw || !raw.bytes) {
      // 契约 §16.7.1：adapter 失败一律 throw；走到这里说明它返回了不含字节的非法形状
      throwFailure('capture_screenshot', {
        code: 'capture_failed',
        message: 'the capture backend returned no image bytes',
        details: { reason: 'no_bytes', backend: backendLabel },
        hint: 'run capture_probe; the backend module is not following the adapter contract',
      });
    }

    const bytes = toBytes(raw.bytes);
    if (!bytes) {
      throwFailure('capture_screenshot', {
        code: 'invalid_output',
        message: 'the capture backend returned image bytes of an unsupported type',
        details: { reason: 'bytes_not_uint8array', backend: raw.backend || backendLabel },
        hint: 'retry once; if it persists run capture_probe',
      });
    }

    // ④ PNG 结构 + 尺寸
    const checked = png.inspectPng(bytes);
    if (!checked.ok) {
      throwFailure('capture_screenshot', {
        code: 'invalid_output',
        message: `the captured image is not a valid PNG: ${checked.message}`,
        details: { reason: 'png_invalid', backend: raw.backend || backendLabel },
        hint: 'retry once; if it persists run capture_probe',
      });
    }

    const nativeWidth = Number(raw.nativeWidth) > 0 ? Number(raw.nativeWidth) : null;
    const nativeHeight = Number(raw.nativeHeight) > 0 ? Number(raw.nativeHeight) : null;
    if (nativeWidth && checked.width > nativeWidth) {
      throwFailure('capture_screenshot', {
        code: 'invalid_output',
        message: `the delivered image is ${checked.width}px wide but the backend captured only ${nativeWidth}px, so it was upscaled`,
        details: { reason: 'upscaled_output', width: checked.width, nativeWidth, backend: raw.backend || backendLabel },
        hint: 'this tool never upscales; retry without maxWidth and report the backend',
      });
    }

    // ---- 尺寸语义（契约 §16.11 / P1-1）------------------------------------
    // nativeWidth/nativeHeight = 后端报告的**采集**尺寸（= 请求的 region/display/window 尺寸）。
    // 文件 IHDR 只有在“未缩放”时才必须等于 native；一旦 maxWidth 触发一次缩小，
    // 就必须等于 maxWidth × round(nativeH * maxWidth / nativeW)。
    const scalingRequested = Boolean(request.maxWidth && nativeWidth && request.maxWidth < nativeWidth);
    const targetLabel = request.target === 'region' ? 'region' : request.target;
    if (nativeWidth && nativeHeight) {
      if (scalingRequested) {
        const expectedWidth = request.maxWidth;
        const expectedHeight = Math.max(1, Math.round((nativeHeight * request.maxWidth) / nativeWidth));
        const widthOk = checked.width === expectedWidth;
        const heightOk = Math.abs(checked.height - expectedHeight) <= 1; // 允许 ±1 的舍入
        if (!widthOk) {
          // 区分“根本没缩”（宽 == native）与“缩了但宽度算错”
          const ignored = checked.width === nativeWidth;
          throwFailure('capture_screenshot', {
            code: 'invalid_output',
            message: ignored
              ? `maxWidth ${expectedWidth} was requested but the backend returned the native ${nativeWidth}x${nativeHeight} without downscaling`
              : `the image was downscaled to ${checked.width}x${checked.height} but maxWidth ${expectedWidth} was requested (native ${nativeWidth}x${nativeHeight})`,
            details: {
              reason: ignored ? 'max_width_ignored' : 'scaled_width_mismatch',
              maxWidth: expectedWidth,
              expected: { width: expectedWidth, height: expectedHeight },
              actual: { width: checked.width, height: checked.height },
              native: { width: nativeWidth, height: nativeHeight },
              backend: raw.backend || backendLabel,
            },
            hint: ignored
              ? 'the backend ignored maxWidth; reinstall the backend that supports downscaling'
              : 'retry once; if it persists capture the display and crop it yourself',
          });
        }
        if (!heightOk) {
          throwFailure('capture_screenshot', {
            code: 'invalid_output',
            message: `the downscaled height ${checked.height} does not match native ${nativeWidth}x${nativeHeight} at maxWidth ${expectedWidth} (expected ${expectedHeight}±1)`,
            details: {
              reason: 'scaled_height_mismatch',
              expected: { width: expectedWidth, height: expectedHeight },
              actual: { width: checked.width, height: checked.height },
              native: { width: nativeWidth, height: nativeHeight },
              backend: raw.backend || backendLabel,
            },
            hint: 'retry once; if it persists capture the display and crop it yourself',
          });
        }
      } else if (checked.width !== nativeWidth || checked.height !== nativeHeight) {
        // 没有缩放：文件必须就是采集尺寸。region 的 native 必须等于请求区域，否则坐标映射错了。
        const requestedRegion = request.target === 'region' ? request.region : null;
        if (requestedRegion && (nativeWidth !== requestedRegion.width || nativeHeight !== requestedRegion.height)) {
          throwFailure('capture_screenshot', {
            code: 'invalid_output',
            message: `the region capture is ${nativeWidth}x${nativeHeight} but ${requestedRegion.width}x${requestedRegion.height} was requested`,
            details: {
              reason: 'region_size_mismatch',
              requested: { width: requestedRegion.width, height: requestedRegion.height },
              actual: { width: nativeWidth, height: nativeHeight },
              backend: raw.backend || backendLabel,
            },
            hint: 'retry once; if it persists capture the display and crop it yourself',
          });
        }
        throwFailure('capture_screenshot', {
          code: 'invalid_output',
          message: `the ${targetLabel} PNG is ${checked.width}x${checked.height} but the backend captured ${nativeWidth}x${nativeHeight} without scaling`,
          details: {
            reason: 'size_mismatch',
            expected: { width: nativeWidth, height: nativeHeight },
            actual: { width: checked.width, height: checked.height },
            backend: raw.backend || backendLabel,
          },
          hint: 'retry once; if it persists run capture_probe',
        });
      }
    }

    // ⑤ 原子落盘（原生 PNG）
    let written;
    try {
      written = await paths.writeAtomicEx(dirname(outPath), basename(outPath), bytes);
    } catch (e) {
      throwFailure('capture_screenshot', failureFromError(e));
    }

    // ⑥ 同一份字节进附件库（模型可见副本）
    const attachments = attachmentService();
    if (!attachments) {
      throwFailure('capture_screenshot', {
        code: 'backend_unavailable',
        message: 'no attachment service is mounted, so the capture could not be delivered to the model',
        details: { reason: 'no_attachment_service', backend: raw.backend || backendLabel },
        hint: 'enable the attachments service in this DSH profile',
      });
    }

    let saved;
    try {
      saved = await attachments.saveImage({ data: bytes, mediaType: 'image/png', name: basename(written.path) });
    } catch (e) {
      throwFailure('capture_screenshot', {
        code: 'invalid_output',
        message: 'the attachment store rejected the captured image',
        details: {
          reason: 'attachment_rejected',
          attachmentCode: (e && (e.code || e.name)) || 'unknown',
          width: checked.width,
          height: checked.height,
          bytes: bytes.length,
        },
        hint: 'retry once; if it persists capture a region instead of the whole display',
      });
    }

    const imageMediaType = typeof saved.mediaType === 'string' && saved.mediaType ? saved.mediaType : 'image/png';
    const imageWidth = Number(saved.width) > 0 ? Number(saved.width) : checked.width;
    const imageHeight = Number(saved.height) > 0 ? Number(saved.height) : checked.height;
    const originalDimensions =
      saved.originalDimensions && Number(saved.originalDimensions.width) > 0 && Number(saved.originalDimensions.height) > 0
        ? { width: Number(saved.originalDimensions.width), height: Number(saved.originalDimensions.height) }
        : undefined;

    const image = {
      attachmentId: String(saved.attachmentId || ''),
      mediaType: imageMediaType,
      bytes: Number(saved.bytes) > 0 ? Number(saved.bytes) : bytes.length,
      width: imageWidth,
      height: imageHeight,
      ...(typeof saved.name === 'string' && saved.name ? { name: saved.name } : {}),
      ...(originalDimensions ? { originalDimensions } : {}),
    };

    const warnings = normalizeWarnings(raw.warnings);
    if (!nativeWidth || !nativeHeight) warnings.push('quality_unverified');
    if (originalDimensions || imageWidth !== checked.width || imageHeight !== checked.height) {
      warnings.push('model_image_downscaled');
    }
    if (imageMediaType !== 'image/png') warnings.push('attachment_reencoded');
    if (written.renamed && request.out) warnings.push('out_renamed');

    return {
      ok: true,
      path: written.path,
      width: checked.width,
      height: checked.height,
      ...(nativeWidth && nativeHeight ? { nativeWidth, nativeHeight } : {}),
      platform,
      backend: typeof raw.backend === 'string' && raw.backend ? raw.backend : backendLabel,
      target: request.target,
      display: typeof raw.display === 'string' ? raw.display : '',
      scaled: Boolean(nativeWidth && checked.width < nativeWidth),
      upscaled: false,
      warnings: normalizeWarnings(warnings),
      image,
    };
  }

  return { screenshot, probe };
}
