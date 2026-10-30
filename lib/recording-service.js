// recording-service.js — Host 内存录屏会话服务（第一层 §2–§8）。
//
// 固定组合接口（T1/T2 契约，不得单侧变更）：
//   createRecordingService(ctx, config, deps?) -> { execute(rawArgs, exec), probe(exec), dispose() }
//   execute：Promise，处理 start/status/stop/cancel，错误按 `capture_recording failed [code]: ...` throw；
//   probe：  Promise<recording 对象>，绝不 throw（recording 不可用不得拖垮截图 probe）；
//   dispose：Promise<void>，清理完成后 resolve，重复调用共享同一清理结果。
//
// 本文件是**会话/状态机/质量校验/发布**的唯一实现，不直接 spawn/kill：
// 进程执行与进程树清理全部经 service.js 的受控接口（managed process / 有界短进程）。

import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';

import * as defaultPaths from './paths.js';
import * as windowsBackend from './adapters/windows.js';
import * as windowsRecording from './recording/windows.js';
import {
  CAPTURE_FAILURE_CODES,
  createManagedProcess,
  findExe,
  killProcessTree,
  runBounded,
  runBoundedDeadline,
} from './service.js';

const TOOL_NAME = 'capture_recording';
const ACTIONS = Object.freeze(['start', 'status', 'stop', 'cancel']);
const START_ONLY_FIELDS = Object.freeze(['target', 'display', 'region', 'fps', 'drawMouse', 'out']);

/** 启动就绪总上限：固定 10000ms，是“开始产生有效输出”的等待，不是整段录制超时。 */
const STARTUP_TIMEOUT_MS = 10000;
/** q 写入后到录制进程 close 的正常停止 grace。 */
const STOP_GRACE_MS = 15000;
/** kill 之后等待进程确实被回收的上限（不属于 q→close grace）。 */
const KILL_WAIT_MS = 5000;
const STARTUP_POLL_MS = 100;
/** 终态会话有界保留数量（淘汰只移出内存，不删已交付文件）。 */
const TERMINAL_LIMIT = 32;
const DEFAULT_MAX_DURATION_SEC = 3600;
const MAX_DURATION_MIN = 1;
const MAX_DURATION_MAX = 86400;
const DETAILS_LIMIT = 1024;

// ---------------------------------------------------------------------------
// 结构化失败（沿用 11 个顶层错误码；原因放 details.reason）
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

function makeFailure(code, message, extra = {}) {
  return {
    code: CAPTURE_FAILURE_CODES.includes(code) ? code : 'capture_failed',
    message: String(message || ''),
    ...(extra.details && typeof extra.details === 'object' ? { details: extra.details } : {}),
    ...(extra.hint ? { hint: String(extra.hint) } : {}),
  };
}

function formatFailureText(failure) {
  const lines = [`${TOOL_NAME} failed [${failure.code}]: ${failure.message}`];
  const details = safeDetails(failure.details);
  if (details) lines.push('details: ' + JSON.stringify(details));
  if (failure.hint) lines.push('hint: ' + String(failure.hint));
  return lines.join('\n');
}

function throwFailure(code, message, extra = {}) {
  const failure = makeFailure(code, message, extra);
  const error = new Error(formatFailureText(failure));
  error.failure = failure;
  throw error;
}

function throwFailureFrom(failure) {
  const normalized = makeFailure(failure && failure.code, failure && failure.message, failure || {});
  const error = new Error(formatFailureText(normalized));
  error.failure = normalized;
  throw error;
}

function failureFromError(error) {
  if (error && error.failure && typeof error.failure.code === 'string') {
    return makeFailure(error.failure.code, error.failure.message, error.failure);
  }
  return makeFailure('capture_failed', 'unexpected failure: ' + shortError(error));
}

function shortError(error) {
  if (!error) return 'unknown';
  const code = error.code ? String(error.code) : '';
  const message = error.message ? String(error.message) : String(error);
  return (code ? code + ': ' : '') + message.slice(0, 300);
}

// ---------------------------------------------------------------------------
// 参数（Schema default 不自动填值，service 逐字段校验）
// ---------------------------------------------------------------------------

function isInt(value) {
  return typeof value === 'number' && Number.isInteger(value);
}

function normalizeEnvelope(rawArgs) {
  if (rawArgs === undefined || rawArgs === null) return {};
  if (typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    throwFailure('invalid_argument', 'recording arguments must be an object', {
      details: { reason: 'args_not_object' },
      hint: 'pass an object such as { "action": "start" }',
    });
  }
  return rawArgs;
}

function readAction(args) {
  if (typeof args.action !== 'string' || args.action.trim() === '') {
    throwFailure('invalid_argument', 'action is required', {
      details: { reason: 'action_missing' },
      hint: 'use one of start, status, stop, cancel',
    });
  }
  const action = args.action.trim();
  if (!ACTIONS.includes(action)) {
    throwFailure('invalid_argument', `unknown action "${action}"`, {
      details: { reason: 'action_unknown', action, supported: [...ACTIONS] },
      hint: 'use one of start, status, stop, cancel',
    });
  }
  return action;
}

function normalizeStartArgs(args) {
  if (args.recordingId !== undefined && args.recordingId !== null) {
    throwFailure('invalid_argument', 'recordingId is only valid for status, stop and cancel', {
      details: { reason: 'recording_id_not_allowed' },
      hint: 'drop recordingId when starting a recording',
    });
  }

  let target = 'display';
  if (args.target !== undefined && args.target !== null) {
    if (typeof args.target !== 'string') {
      throwFailure('invalid_argument', 'target must be a string', { details: { reason: 'target_not_string' }, hint: 'use display or region' });
    }
    if (args.target === 'window' || args.target === 'all') {
      throwFailure('unsupported_target', `target "${args.target}" is not supported for recording in 0.3.0`, {
        details: { reason: args.target === 'window' ? 'target_window' : 'target_all', target: args.target, supported: ['display', 'region'] },
        hint: 'record the whole display or a region of it',
      });
    }
    if (args.target !== 'display' && args.target !== 'region') {
      throwFailure('invalid_argument', `unknown target "${args.target}"`, {
        details: { reason: 'target_unknown', target: args.target, supported: ['display', 'region'] },
        hint: 'use display or region',
      });
    }
    target = args.target;
  }

  let display = null;
  if (args.display !== undefined && args.display !== null) {
    if (typeof args.display !== 'string' || args.display.trim() === '') {
      throwFailure('invalid_argument', 'display must be a non-empty opaque display id string', {
        details: { reason: 'display_not_string' },
        hint: 'call capture_probe and pass the returned display id',
      });
    }
    display = args.display.trim();
  }

  let region = null;
  if (args.region !== undefined && args.region !== null) {
    if (target !== 'region') {
      throwFailure('invalid_argument', 'region is only meaningful when target is "region"', {
        details: { reason: 'region_without_target', target },
        hint: 'set target to "region" or drop region',
      });
    }
    if (typeof args.region !== 'object' || Array.isArray(args.region)) {
      throwFailure('invalid_argument', 'region must be an object with integer x, y, width, height', {
        details: { reason: 'region_not_object' },
        hint: 'pass { "x": 0, "y": 0, "width": 800, "height": 500 }',
      });
    }
    const { x, y, width, height } = args.region;
    if (!isInt(x) || !isInt(y) || !isInt(width) || !isInt(height)) {
      throwFailure('invalid_region', 'region x, y, width and height must be integers (physical pixels)', {
        details: { reason: 'region_non_integer', region: { x, y, width, height } },
        hint: 'use integer pixel values relative to the display top-left corner',
      });
    }
    if (x < 0 || y < 0) {
      throwFailure('invalid_region', `region origin ${x},${y} is negative; coordinates are relative to the display top-left`, {
        details: { reason: 'region_negative_origin', region: { x, y, width, height } },
        hint: 'use x >= 0 and y >= 0',
      });
    }
    if (width <= 0 || height <= 0) {
      throwFailure('invalid_region', `region size ${width}x${height} is not positive`, {
        details: { reason: 'region_non_positive_size', region: { x, y, width, height } },
        hint: 'use width >= 1 and height >= 1',
      });
    }
    if (width % 2 !== 0 || height % 2 !== 0) {
      throwFailure('invalid_region', 'region width and height must be even for the yuv420p contract', {
        details: { reason: 'region_odd_dimensions', region: { x, y, width, height } },
        hint: 'use even width and height; the recording never pads or scales',
      });
    }
    region = { x, y, width, height };
  }
  if (target === 'region' && !region) {
    throwFailure('invalid_region', 'target "region" requires a region object', {
      details: { reason: 'region_missing' },
      hint: 'pass region { x, y, width, height } in physical pixels',
    });
  }

  let fps = 60;
  if (args.fps !== undefined && args.fps !== null) {
    if (!isInt(args.fps) || (args.fps !== 30 && args.fps !== 60)) {
      throwFailure('invalid_argument', 'fps must be 30 or 60 in 0.3.0', {
        details: { reason: 'fps_unsupported', fps: args.fps, supported: [30, 60] },
        hint: 'use fps 30 or 60',
      });
    }
    fps = args.fps;
  }

  let drawMouse = true;
  if (args.drawMouse !== undefined && args.drawMouse !== null) {
    if (typeof args.drawMouse !== 'boolean') {
      throwFailure('invalid_argument', 'drawMouse must be a boolean', { details: { reason: 'draw_mouse_not_boolean' } });
    }
    drawMouse = args.drawMouse;
  }

  let out;
  if (args.out !== undefined && args.out !== null) {
    if (typeof args.out !== 'string') {
      throwFailure('invalid_argument', 'out must be a string relative path inside the workspace', {
        details: { reason: 'out_not_string' },
        hint: 'omit out to write output/capture/<uuid>.mp4',
      });
    }
    out = args.out;
  }

  return { target, display, region, fps, drawMouse, out };
}

function normalizeRecordingId(args, action) {
  for (const field of START_ONLY_FIELDS) {
    if (args[field] !== undefined && args[field] !== null) {
      throwFailure('invalid_argument', `"${field}" is not valid for action "${action}"`, {
        details: { reason: 'unexpected_field', field, action },
        hint: `only pass action and recordingId for ${action}`,
      });
    }
  }
  if (typeof args.recordingId !== 'string' || args.recordingId.trim() === '') {
    throwFailure('invalid_argument', `recordingId is required for action "${action}"`, {
      details: { reason: 'recording_id_required', action },
      hint: 'use the recordingId returned by capture_recording start',
    });
  }
  return args.recordingId.trim();
}

function normalizeMaxDuration(config) {
  if (config !== undefined && config !== null && (typeof config !== 'object' || Array.isArray(config))) {
    throw new TypeError('capture-sharp: config must be an object');
  }
  const raw = config && config.recordingMaxDurationSec;
  if (raw === undefined || raw === null) return DEFAULT_MAX_DURATION_SEC;
  if (!isInt(raw) || raw < MAX_DURATION_MIN || raw > MAX_DURATION_MAX) {
    throw new TypeError(`capture-sharp: config.recordingMaxDurationSec must be an integer between ${MAX_DURATION_MIN} and ${MAX_DURATION_MAX}`);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function fileSize(filePath) {
  try {
    const info = statSync(filePath);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolvePromise({ timedOut: true });
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({ ...(value || {}), timedOut: false });
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({ timedOut: false, spawnError: error, exitCode: null, stderr: '' });
      },
    );
  });
}

/**
 * 轻量 MP4 box 检查：沿 top-level box 链表证明 moov 位于 mdat 之前（+faststart 真的生效），
 * 不把整个视频读进内存。
 */
function checkMoovBeforeMdat(filePath) {
  let fd = null;
  try {
    fd = openSync(filePath, 'r');
    const total = statSync(filePath).size;
    let offset = 0;
    let moov = -1;
    let mdat = -1;
    let guard = 0;
    while (offset + 8 <= total && guard < 4096) {
      guard += 1;
      const header = Buffer.alloc(16);
      const bytesRead = readSync(fd, header, 0, 16, offset);
      if (bytesRead < 8) break;
      let size = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      let headerSize = 8;
      if (size === 1) {
        if (bytesRead < 16) break;
        const large = header.readBigUInt64BE(8);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, reason: 'mp4_box_too_large' };
        size = Number(large);
        headerSize = 16;
      } else if (size === 0) {
        size = total - offset;
      }
      if (size < headerSize) return { ok: false, reason: 'mp4_box_invalid' };
      if (type === 'moov' && moov < 0) moov = offset;
      if (type === 'mdat' && mdat < 0) mdat = offset;
      if (moov >= 0 && mdat >= 0) break;
      offset += size;
    }
    if (moov < 0) return { ok: false, reason: 'moov_missing' };
    if (mdat < 0) return { ok: false, reason: 'mdat_missing' };
    return { ok: moov < mdat, reason: moov < mdat ? 'ok' : 'moov_after_mdat' };
  } catch (e) {
    return { ok: false, reason: 'mp4_unreadable', error: shortError(e) };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

/**
 * 创建唯一录屏服务。所有会话状态只在本 Host 内存中。
 *
 * @param {object} ctx 插件 context（执行期按需读 workingDirectory）
 * @param {{ recordingMaxDurationSec?: number }} [config]
 * @param {object} [deps] 测试/集成注入缝（paths/backend/windows/managedProcess/capabilityRun/runDeadline/
 *   findExe/env/platform/now/timings/capabilityCheck/environmentProbe）
 */
export function createRecordingService(ctx, config, deps = {}) {
  const paths = deps.paths || defaultPaths;
  const backend = deps.backend || windowsBackend;
  const windows = deps.windows || windowsRecording;
  const managedProcess = deps.managedProcess || createManagedProcess;
  const capabilityRun = deps.capabilityRun || runBounded;
  const runDeadline = deps.runDeadline || runBoundedDeadline;
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const now = typeof deps.now === 'function' ? deps.now : () => performance.now();
  const find = typeof deps.findExe === 'function' ? deps.findExe : (name) => findExe(name, env, platform);
  const removeFile = typeof deps.removeFile === 'function' ? deps.removeFile : (filePath) => rmSync(filePath, { force: true });
  const maxDurationSec = normalizeMaxDuration(config);
  const timings = {
    startupTimeoutMs: STARTUP_TIMEOUT_MS,
    stopGraceMs: STOP_GRACE_MS,
    killWaitMs: KILL_WAIT_MS,
  };
  if (deps.timings && typeof deps.timings === 'object') {
    for (const key of Object.keys(timings)) {
      if (Number.isInteger(deps.timings[key]) && deps.timings[key] > 0) timings[key] = deps.timings[key];
    }
  }

  const sessions = new Map();
  const terminalOrder = [];
  let activeSession = null;
  let disposed = false;
  let disposePromise = null;

  // -------------------------------------------------------------------------
  // 能力探针
  // -------------------------------------------------------------------------

  async function capabilityCheck(session) {
    if (typeof deps.capabilityCheck === 'function') return deps.capabilityCheck();
    const trackChild = session
      ? (child) => {
          session.preflightChild = child;
        }
      : undefined;
    return windows.probeCapabilities({
      platform,
      findExe: find,
      run: (file, argv, options) => capabilityRun(file, argv, { ...(options || {}), ...(trackChild ? { onSpawn: trackChild } : {}) }),
      env,
      timeoutMs: timings.startupTimeoutMs,
    });
  }

  async function environmentProbe(exec, session) {
    if (typeof deps.environmentProbe === 'function') return deps.environmentProbe(exec);
    if (!backend || typeof backend.probe !== 'function') {
      throwFailure('backend_unavailable', 'no Windows display probe is available for recording', {
        details: { reason: 'no_probe', platform },
      });
    }
    const trackChild = session
      ? (child) => {
          session.preflightChild = child;
        }
      : undefined;
    const run = {
      timeoutMs: timings.startupTimeoutMs,
      signal: exec && exec.signal ? exec.signal : undefined,
      exec: (file, argv, options) => capabilityRun(file, argv, { ...(options || {}), ...(trackChild ? { onSpawn: trackChild } : {}) }),
      findExe: find,
      env,
    };
    return backend.probe(ctx, run);
  }

  function pushMissing(list, extra) {
    for (const item of Array.isArray(extra) ? extra : []) {
      if (typeof item === 'string' && item && !list.includes(item)) list.push(item);
    }
  }

  /** recording probe：绝不 throw；recording 不可用只是 available=false + missing/reason。 */
  async function probe(exec) {
    const base = {
      available: false,
      backend: 'none',
      grade: windows.GRADE,
      targets: { ...windows.UNSUPPORTED_TARGETS },
      missing: [],
      reason: '',
      sourceDpiAware: false,
    };
    if (platform !== 'win32') {
      return { ...base, missing: ['windows'], reason: 'recording is implemented on Windows only in 0.3.0' };
    }
    try {
      const caps = await capabilityCheck();
      const missing = [];
      pushMissing(missing, caps.missing);
      let environment = null;
      let environmentFailure = null;
      try {
        environment = await environmentProbe(exec);
      } catch (e) {
        environmentFailure = e;
      }
      let support = null;
      if (!environment) {
        missing.push('interactive desktop');
        environmentFailure = environmentFailure || new Error('no environment probe result');
      } else {
        support = windows.judgeEnvironment({
          platform,
          sessionType: environment.sessionType,
          headless: environment.headless,
          dpiAware: environment.dpiAware,
          displays: environment.displays,
        });
        if (!support.ok) {
          const failure = support.failure;
          const reason = failure && failure.details ? failure.details.reason : '';
          if (reason === 'multiple_displays') missing.push('single display');
          else if (reason === 'session_unsupported') missing.push('console session');
          else if (reason === 'dpi_awareness_unverified') missing.push('dpiAware');
          else if (reason === 'no_display') missing.push('interactive desktop');
          else if (reason === 'odd_display_dimensions') missing.push('even display dimensions');
        }
      }
      const available = caps.available === true && Boolean(support && support.ok) && missing.length === 0;
      let reason = '';
      if (!available) {
        const supportReason = support && !support.ok && support.failure ? support.failure.message : '';
        reason = supportReason || (missing.length ? 'missing: ' + missing.join(', ') : 'recording backend is unavailable');
        if (environmentFailure && !supportReason) reason = reason + ' (' + shortError(environmentFailure) + ')';
      }
      return {
        available,
        backend: available ? windows.BACKEND_NAME : 'none',
        grade: windows.GRADE,
        targets: available ? { ...windows.GRADES } : { ...windows.UNSUPPORTED_TARGETS },
        missing,
        reason,
        sourceDpiAware: environment ? environment.dpiAware === true : false,
      };
    } catch (e) {
      return { ...base, missing: ['probe_failed'], reason: shortError(e) };
    }
  }

  // -------------------------------------------------------------------------
  // 会话注册表与保留
  // -------------------------------------------------------------------------

  function rememberTerminal(session) {
    if (!session.remembered) {
      session.remembered = true;
      terminalOrder.push(session);
    }
    while (terminalOrder.length > TERMINAL_LIMIT) {
      const oldest = terminalOrder.shift();
      if (!oldest) break;
      if (oldest === activeSession || oldest.cleanupPending || oldest.finalizationInProgress) {
        // 活动/未清理会话不得淘汰；放回队尾避免丢记录。
        terminalOrder.push(oldest);
        break;
      }
      sessions.delete(oldest.id);
    }
  }

  function maybeRelease(session) {
    if (session.cleanupPending) return;
    if (session.state === 'starting' || session.state === 'recording' || session.state === 'stopping') return;
    if (session.finalizationInProgress) return;
    if (activeSession === session) activeSession = null;
    rememberTerminal(session);
  }

  function clearTimer(session) {
    if (session.maxDurationTimer) {
      clearTimeout(session.maxDurationTimer);
      session.maxDurationTimer = null;
    }
  }

  async function cleanupTemp(session) {
    if (!session.tempPath) {
      session.cleanupPending = false;
      return;
    }
    try {
      removeFile(session.tempPath);
      session.cleanupPending = false;
      session.cleanupError = null;
    } catch (e) {
      session.cleanupPending = true;
      session.cleanupError = shortError(e);
    }
  }

  async function waitCloseBounded(processHandle, ms) {
    if (!processHandle) return { timedOut: false, exitCode: null, signal: null, spawnError: null };
    if (processHandle.closed) {
      return {
        timedOut: false,
        exitCode: processHandle.exitCode,
        signal: processHandle.signal,
        spawnError: processHandle.spawnError || null,
      };
    }
    return withTimeout(processHandle.waitClose(), ms);
  }

  // -------------------------------------------------------------------------
  // start
  // -------------------------------------------------------------------------

  async function startSession(request, exec) {
    if (disposed) {
      throwFailure('invalid_argument', 'the recording service is shutting down and accepts no new recordings', {
        details: { reason: 'recording_service_disposed' },
      });
    }
    // 同步 reservation：在首个 await 之前占住唯一活动槽（并发 start 的 TOCTOU 由这里消除）。
    if (activeSession) {
      throwFailure('invalid_argument', 'another recording is still active in this plugin instance', {
        details: { reason: 'recording_already_active' },
        hint: 'stop or cancel the active recording before starting another',
      });
    }
    const session = {
      id: randomUUID(),
      state: 'starting',
      request,
      warnings: [],
      createdAt: now(),
      ownerRoot: null,
      workspace: null,
      finalPath: null,
      tempPath: null,
      display: null,
      nativeWidth: null,
      nativeHeight: null,
      backend: null,
      encoder: null,
      ffmpegPath: null,
      ffprobePath: null,
      pid: null,
      process: null,
      startedAt: null,
      endedAt: null,
      media: null,
      publishedPath: null,
      bytes: null,
      error: null,
      terminationAccepted: null,
      cleanupPending: false,
      cleanupError: null,
      abortPublish: false,
      finalization: null,
      finalizationInProgress: false,
      finalizationOutcome: null,
      cancelPromise: null,
      maxDurationTimer: null,
      validationChild: null,
      preflightChild: null,
      remembered: false,
    };
    activeSession = session;
    sessions.set(session.id, session);

    try {
      const workspace = await paths.resolveCanonicalWorkspace(ctx, exec || {});
      session.workspace = workspace.root;
      session.ownerRoot = workspace.canonicalRoot;
      const finalPath = paths.resolveOutPath(workspace.root, request.out, session.id + '.mp4', {
        extension: '.mp4',
        label: 'MP4',
      });
      session.finalPath = finalPath;
      session.tempPath = paths.createMediaTempPath(dirname(finalPath), '.mp4');

      await prepareSession(session, exec);
      return renderSnapshot(session, 'start');
    } catch (e) {
      const failure = failureFromError(e);
      await failStart(session);
      throwFailureFrom(failure);
    }
  }

  async function prepareSession(session, exec) {
    const request = session.request;
    let environment;
    try {
      environment = await environmentProbe(exec, session);
    } finally {
      session.preflightChild = null;
    }
    if (!environment || typeof environment !== 'object') {
      throwFailure('backend_unavailable', 'the Windows display probe returned no usable result', {
        details: { reason: 'environment_probe_failed', platform },
      });
    }
    const support = windows.judgeEnvironment({
      platform,
      sessionType: environment.sessionType,
      headless: environment.headless,
      dpiAware: environment.dpiAware,
      displays: environment.displays,
    });
    if (!support.ok) throwFailureFrom(support.failure);
    const display = support.display;

    if (request.display && request.display !== display.id) {
      throwFailure('invalid_argument', 'the requested display id does not match the current display', {
        details: { reason: 'display_unknown', display: request.display },
        hint: 'call capture_probe and pass the returned display id',
      });
    }

    if (request.target === 'region' && request.region) {
      const region = request.region;
      if (region.x + region.width > display.width || region.y + region.height > display.height) {
        throwFailure('invalid_region', 'the region is not fully inside the display bounds', {
          details: {
            reason: 'region_out_of_bounds',
            region,
            bounds: { x: display.x, y: display.y, width: display.width, height: display.height },
          },
          hint: 'use physical pixel coordinates relative to the display top-left corner',
        });
      }
    }

    const capabilities = await capabilityCheck(session).finally(() => {
      session.preflightChild = null;
    });
    if (!capabilities || capabilities.available !== true) {
      throwFailure('backend_unavailable', 'the recording backend is missing required external capabilities', {
        details: {
          reason: 'missing_capabilities',
          backend: windows.BACKEND_NAME,
          missing: Array.isArray(capabilities && capabilities.missing) ? capabilities.missing : [],
        },
        hint: 'install FFmpeg with the ddagrab filter and the libx264 encoder, then retry',
      });
    }

    session.display = display.id;
    session.nativeWidth = request.target === 'region' ? request.region.width : display.width;
    session.nativeHeight = request.target === 'region' ? request.region.height : display.height;
    session.backend = windows.BACKEND_NAME;
    session.encoder = windowsRecording.ENCODER;
    session.ffmpegPath = capabilities.ffmpegPath;
    session.ffprobePath = capabilities.ffprobePath;

    const argv = windows.buildFfmpegArgs({
      tempPath: session.tempPath,
      target: request.target,
      region: request.region || undefined,
      fps: request.fps,
      drawMouse: request.drawMouse,
    });

    session.process = managedProcess(capabilities.ffmpegPath, argv, {
      env,
      now,
      onSpawn: (child) => {
        session.pid = child && typeof child.pid === 'number' ? child.pid : null;
      },
    });
    session.startedAt = now();

    await waitReady(session, exec);

    session.state = 'recording';
    session.readyAt = now();
    watchEarlyExit(session);
    armMaxDuration(session);
  }

  async function waitReady(session, exec) {
    const processHandle = session.process;
    const deadline = now() + timings.startupTimeoutMs;
    while (true) {
      if (processHandle.spawnError) {
        throwFailure('backend_unavailable', 'FFmpeg could not be started', {
          details: { reason: 'spawn_failed', backend: session.backend, error: shortError(processHandle.spawnError) },
          hint: 'check that FFmpeg is installed and executable',
        });
      }
      if (processHandle.closed) {
        throwFailure('capture_failed', 'FFmpeg exited before the recording produced any output', {
          details: {
            reason: 'startup_exited',
            exitCode: processHandle.exitCode,
            stderrTail: processHandle.stderrTail(4096),
          },
          hint: 'run capture_probe to confirm the recording backend is available',
        });
      }
      if (fileSize(session.tempPath) > 0) return;
      if (exec && exec.signal && exec.signal.aborted) {
        throwFailure('capture_timeout', 'the recording start was aborted before it became ready', {
          details: { reason: 'aborted', retryable: true },
          hint: 'retry the recording',
        });
      }
      if (now() >= deadline) {
        throwFailure('capture_timeout', `FFmpeg did not produce output within ${timings.startupTimeoutMs}ms`, {
          details: { reason: 'startup_timeout', timeoutMs: timings.startupTimeoutMs, backend: session.backend },
          hint: 'run capture_probe to confirm the recording backend is available',
        });
      }
      await sleep(STARTUP_POLL_MS);
    }
  }

  async function failStart(session) {
    clearTimer(session);
    if (session.preflightChild) {
      try {
        killProcessTree(session.preflightChild);
      } catch {
        /* ignore */
      }
      session.preflightChild = null;
    }
    const processHandle = session.process;
    if (processHandle && !processHandle.closed) {
      processHandle.killTree();
      await waitCloseBounded(processHandle, timings.killWaitMs);
    }
    await cleanupTemp(session);
    session.state = 'failed';
    sessions.delete(session.id);
    if (activeSession === session) activeSession = null;
  }

  function watchEarlyExit(session) {
    const processHandle = session.process;
    if (!processHandle) return;
    processHandle.waitClose().then(
      (outcome) => {
        if (session.state === 'recording' && !session.terminationAccepted) {
          void handleUnexpectedExit(session, outcome);
        }
      },
      () => {
        /* close promise 永不 reject；忽略 */
      },
    );
  }

  async function handleUnexpectedExit(session, outcome) {
    if (session.state !== 'recording' || session.terminationAccepted) return;
    session.state = 'failed';
    session.endedAt = (outcome && outcome.closedAt) || now();
    session.error = makeFailure('capture_failed', 'the recording process exited without a stop or cancel request', {
      details: {
        reason: 'unexpected_exit',
        exitCode: outcome ? outcome.exitCode : null,
        signal: outcome ? outcome.signal : null,
        stderrTail: session.process ? session.process.stderrTail(4096) : '',
      },
    });
    clearTimer(session);
    await cleanupTemp(session);
    maybeRelease(session);
  }

  function armMaxDuration(session) {
    clearTimer(session);
    session.maxDurationTimer = setTimeout(() => {
      session.maxDurationTimer = null;
      if (session.state !== 'recording' || session.terminationAccepted) return;
      void runFinalization(session);
    }, maxDurationSec * 1000);
    if (session.maxDurationTimer && typeof session.maxDurationTimer.unref === 'function') session.maxDurationTimer.unref();
  }

  // -------------------------------------------------------------------------
  // stop / finalization
  // -------------------------------------------------------------------------

  function runFinalization(session) {
    if (session.finalization) return session.finalization;
    session.finalizationInProgress = true;
    if (!session.terminationAccepted) session.terminationAccepted = 'stop';
    clearTimer(session);
    session.state = 'stopping';
    const promise = (async () => {
      let outcome;
      try {
        outcome = await doFinalize(session);
      } catch (e) {
        outcome = { ok: false, failure: failureFromError(e) };
        await cleanupTemp(session);
        if (session.abortPublish) {
          session.state = 'cancelled';
          session.error = null;
        } else {
          session.state = 'failed';
          session.error = outcome.failure;
        }
      } finally {
        session.finalizationInProgress = false;
        session.finalizationOutcome = outcome;
        maybeRelease(session);
      }
      return outcome;
    })();
    session.finalization = promise;
    return promise;
  }

  async function doFinalize(session) {
    const processHandle = session.process;
    if (!processHandle) {
      return failFinalization(session, makeFailure('capture_failed', 'the recording process is missing', { details: { reason: 'no_process' } }));
    }

    // ① q → close（15s grace 只覆盖这一段）
    const wrote = processHandle.writeStdin('q');
    if (!wrote && !processHandle.closed) {
      processHandle.killTree();
      await waitCloseBounded(processHandle, timings.killWaitMs);
      return failFinalization(
        session,
        makeFailure('capture_failed', 'FFmpeg stdin is not writable, so a clean stop is impossible', {
          details: { reason: 'stdin_closed', exitCode: processHandle.exitCode },
          hint: 'retry the recording; the process closed its stdin',
        }),
      );
    }
    const stopped = await waitCloseBounded(processHandle, timings.stopGraceMs);
    if (stopped.timedOut) {
      processHandle.killTree();
      await waitCloseBounded(processHandle, timings.killWaitMs);
      return failFinalization(
        session,
        makeFailure('capture_timeout', `FFmpeg did not exit within ${timings.stopGraceMs}ms after q; its process tree was killed`, {
          details: { reason: 'stop_timeout', timeoutMs: timings.stopGraceMs, exitCode: processHandle.exitCode },
          hint: 'the recording was not delivered because it could not be finalized cleanly',
        }),
      );
    }
    session.endedAt = stopped.closedAt || now();
    if (stopped.spawnError) {
      return failFinalization(
        session,
        makeFailure('capture_failed', 'FFmpeg failed while stopping', {
          details: { reason: 'unexpected_exit', error: shortError(stopped.spawnError), stderrTail: processHandle.stderrTail(4096) },
        }),
      );
    }
    if (stopped.exitCode !== 0) {
      return failFinalization(
        session,
        makeFailure('capture_failed', 'FFmpeg exited with a non-zero code; the MP4 is incomplete', {
          details: { reason: 'unexpected_exit', exitCode: stopped.exitCode, stderrTail: processHandle.stderrTail(4096) },
        }),
      );
    }

    // ② close 后的 validation/publish 共享一个按时长计算的 deadline（不经过 120s clamp）
    const recordedDurationSec = Math.max(1, (session.endedAt - session.startedAt) / 1000);
    const validationBudgetMs = Math.max(120000, recordedDurationSec * 3000 + 60000);
    const deadlineAt = now() + validationBudgetMs;
    const expected = {
      requestedFps: session.request.fps,
      expectedWidth: session.nativeWidth,
      expectedHeight: session.nativeHeight,
    };

    // ③ FFprobe（-count_frames + 完整 streams/format）
    const probeResult = await runValidation(session, session.ffprobePath, windows.buildFfprobeArgs(session.tempPath), deadlineAt);
    if (probeResult.timedOut) return validationTimeout(session, 'ffprobe');
    if (probeResult.spawnError) {
      return failFinalization(
        session,
        makeFailure('backend_unavailable', 'FFprobe could not be started for validation', {
          details: { reason: 'ffprobe_unavailable', error: shortError(probeResult.spawnError) },
        }),
      );
    }
    if (probeResult.exitCode !== 0) {
      return failFinalization(
        session,
        makeFailure('invalid_output', 'FFprobe could not read the recorded file', {
          details: { reason: 'ffprobe_failed', exitCode: probeResult.exitCode, stderrTail: String(probeResult.stderr || '').slice(-4096) },
        }),
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(String(probeResult.stdout || ''));
    } catch (e) {
      return failFinalization(
        session,
        makeFailure('invalid_output', 'FFprobe returned output that is not JSON', { details: { reason: 'ffprobe_not_json' } }),
      );
    }
    const judged = windows.judgeProbeJson(parsed, expected);
    if (!judged.ok) return failFinalization(session, judged.failure);

    // ④ 完整解码（-xerror；exit 0 且 error stderr 为空）
    const decodeResult = await runValidation(session, session.ffmpegPath, windows.buildDecodeArgs(session.tempPath), deadlineAt);
    if (decodeResult.timedOut) return validationTimeout(session, 'decode');
    if (decodeResult.spawnError) {
      return failFinalization(
        session,
        makeFailure('backend_unavailable', 'FFmpeg could not be started for full-file decode validation', {
          details: { reason: 'decode_unavailable', error: shortError(decodeResult.spawnError) },
        }),
      );
    }
    const decodeStderr = String(decodeResult.stderr || '');
    if (decodeResult.exitCode !== 0 || decodeStderr.trim() !== '') {
      return failFinalization(
        session,
        makeFailure('invalid_output', 'the full-file decode reported an error', {
          details: { reason: 'decode_error', exitCode: decodeResult.exitCode, stderrTail: decodeStderr.slice(-4096) },
        }),
      );
    }

    // ⑤ moov 必须在 mdat 之前（faststart 实际生效）
    const box = checkMoovBeforeMdat(session.tempPath);
    if (!box.ok) {
      return failFinalization(
        session,
        makeFailure('invalid_output', 'the MP4 is not complete/faststart: moov is missing or after mdat', {
          details: { reason: box.reason, ...(box.error ? { error: box.error } : {}) },
        }),
      );
    }

    // ⑥ 原子 no-clobber 发布（dispose 已请求清理则绝不发布）
    if (session.abortPublish) {
      return failFinalization(
        session,
        makeFailure('capture_failed', 'publishing was cancelled by host disposal', { details: { reason: 'disposed' } }),
      );
    }
    let published;
    try {
      published = paths.publishNoClobberEx(session.tempPath, session.finalPath);
    } catch (e) {
      return failFinalization(session, failureFromError(e));
    }

    session.publishedPath = published.path;
    session.bytes = fileSize(published.path);
    session.media = judged;
    if (published.renamed) {
      if (!session.warnings.includes('out_renamed')) session.warnings.push('out_renamed');
    }
    session.state = 'completed';
    session.error = null;
    return { ok: true };
  }

  async function failFinalization(session, failure) {
    await cleanupTemp(session);
    if (session.process && !session.process.closed) {
      // 进程树尚未确认回收：活动槽必须继续被占用，直到 cancel 重试/dispose 完成回收。
      session.cleanupPending = true;
      session.cleanupError = session.cleanupError || 'process_not_reaped';
    }
    if (session.abortPublish) {
      session.state = 'cancelled';
      session.error = null;
    } else {
      session.state = 'failed';
      session.error = failure;
    }
    return { ok: false, failure, disposed: Boolean(session.abortPublish) };
  }

  async function validationTimeout(session, stage) {
    return failFinalization(
      session,
      makeFailure('capture_timeout', 'validating the recording exceeded its deadline; the file was not published', {
        details: { reason: 'validation_timeout', stage },
      }),
    );
  }

  async function runValidation(session, file, argv, deadlineAt) {
    const remaining = Math.floor(deadlineAt - now());
    if (remaining <= 0) return { timedOut: true };
    session.validationChild = null;
    try {
      return await runDeadline(file, argv, {
        timeoutMs: remaining,
        env,
        onSpawn: (child) => {
          session.validationChild = child;
        },
      });
    } finally {
      session.validationChild = null;
    }
  }

  // -------------------------------------------------------------------------
  // status / stop / cancel
  // -------------------------------------------------------------------------

  async function currentCanonicalRoot(exec) {
    const workspace = await paths.resolveCanonicalWorkspace(ctx, exec || {});
    return workspace.canonicalRoot;
  }

  async function findOwnedSession(recordingId, exec) {
    const session = sessions.get(recordingId);
    if (!session) {
      throwFailure('invalid_argument', 'no recording with that id exists in this plugin instance', {
        details: { reason: 'recording_not_found' },
        hint: 'start a new recording; recording ids do not survive a plugin restart',
      });
    }
    const currentRoot = await currentCanonicalRoot(exec);
    if (session.ownerRoot !== currentRoot) {
      // 刻意不泄漏 owner 路径/会话元数据。
      throwFailure('invalid_argument', 'that recording belongs to a different workspace', {
        details: { reason: 'recording_workspace_mismatch' },
      });
    }
    return session;
  }

  function stateConflict(session) {
    return makeFailure('invalid_argument', `the recording is in state "${session.state}" and cannot perform that action`, {
      details: { reason: 'recording_state_conflict', state: session.state },
      hint: 'query status and wait for the current operation to finish',
    });
  }

  async function statusAction(recordingId, exec) {
    const session = await findOwnedSession(recordingId, exec);
    return renderSnapshot(session, 'status');
  }

  async function stopAction(recordingId, exec) {
    const session = await findOwnedSession(recordingId, exec);
    if (session.state === 'completed') return renderSnapshot(session, 'stop');
    if (session.state === 'failed' || session.state === 'cancelled') {
      throwFailureFrom(stateConflict(session));
    }
    if (session.terminationAccepted === 'cancel') throwFailureFrom(stateConflict(session));
    if (session.state === 'starting') {
      throwFailure('invalid_argument', 'the recording is still starting; wait for start to return before stopping', {
        details: { reason: 'recording_state_conflict', state: session.state },
      });
    }
    if (session.state === 'stopping') {
      if (!session.finalization) throwFailureFrom(stateConflict(session));
      const outcome = await session.finalization;
      if (!outcome || !outcome.ok) throwFailureFrom(outcome ? outcome.failure : stateConflict(session));
      return renderSnapshot(session, 'stop');
    }
    session.terminationAccepted = 'stop';
    const outcome = await runFinalization(session);
    if (!outcome || !outcome.ok) throwFailureFrom(outcome ? outcome.failure : stateConflict(session));
    return renderSnapshot(session, 'stop');
  }

  async function cancelAction(recordingId, exec) {
    const session = await findOwnedSession(recordingId, exec);
    if (session.state === 'cancelled') return renderSnapshot(session, 'cancel');
    if (session.state === 'completed') throwFailureFrom(stateConflict(session));
    if (session.state === 'stopping') throwFailureFrom(stateConflict(session));
    if (session.state === 'failed' && !session.cleanupPending) throwFailureFrom(stateConflict(session));

    if (session.cancelPromise) {
      const outcome = await session.cancelPromise;
      if (!outcome || !outcome.ok) throwFailureFrom(outcome ? outcome.failure : stateConflict(session));
      return renderSnapshot(session, 'cancel');
    }

    const retryCleanup = session.state === 'failed' && session.cleanupPending;
    const promise = retryCleanup ? retryCleanupForCancel(session) : cancelRecording(session);
    session.cancelPromise = promise;
    let outcome;
    try {
      outcome = await promise;
    } finally {
      // 失败后必须允许下一次 cancel 重新尝试清理（failed+cleanupPending → cancelled）。
      if (session.cancelPromise === promise) session.cancelPromise = null;
    }
    if (!outcome || !outcome.ok) throwFailureFrom(outcome ? outcome.failure : stateConflict(session));
    return renderSnapshot(session, 'cancel');
  }

  async function cancelRecording(session) {
    session.terminationAccepted = 'cancel';
    clearTimer(session);
    const processHandle = session.process;
    if (processHandle && !processHandle.closed) {
      processHandle.killTree();
      await waitCloseBounded(processHandle, timings.killWaitMs);
    }
    if (session.preflightChild) {
      try {
        killProcessTree(session.preflightChild);
      } catch {
        /* ignore */
      }
    }
    if (session.validationChild) {
      try {
        killProcessTree(session.validationChild);
      } catch {
        /* ignore */
      }
    }
    await cleanupTemp(session);
    const reaped = !processHandle || processHandle.closed;
    if (!reaped || session.cleanupPending) {
      session.state = 'failed';
      session.cleanupPending = true;
      session.error = makeFailure('capture_failed', 'the recording process or its temporary file could not be cleaned up', {
        details: { reason: 'cancel_cleanup_failed', reaped, cleanupError: session.cleanupError || null },
      });
      maybeRelease(session);
      return { ok: false, failure: session.error };
    }
    session.state = 'cancelled';
    session.error = null;
    maybeRelease(session);
    return { ok: true };
  }

  async function retryCleanupForCancel(session) {
    const processHandle = session.process;
    if (processHandle && !processHandle.closed) {
      processHandle.killTree();
      await waitCloseBounded(processHandle, timings.killWaitMs);
    }
    await cleanupTemp(session);
    if (processHandle && !processHandle.closed) {
      session.cleanupPending = true;
      session.cleanupError = session.cleanupError || 'process_not_reaped';
    }
    if (session.cleanupPending) {
      return {
        ok: false,
        failure: makeFailure('capture_failed', 'the temporary recording still cannot be removed', {
          details: { reason: 'cancel_cleanup_failed', cleanupError: session.cleanupError || null },
        }),
      };
    }
    session.state = 'cancelled';
    session.error = null;
    maybeRelease(session);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // 结果快照（path 只在 completed 出现）
  // -------------------------------------------------------------------------

  function renderSnapshot(session, action) {
    const base = {
      ok: true,
      action,
      state: session.state,
      recordingId: session.id,
      warnings: session.warnings.slice(),
    };
    const params = {
      target: session.request.target,
      ...(session.display ? { display: session.display } : {}),
      ...(Number.isFinite(session.nativeWidth) ? { nativeWidth: session.nativeWidth } : {}),
      ...(Number.isFinite(session.nativeHeight) ? { nativeHeight: session.nativeHeight } : {}),
      requestedFps: session.request.fps,
      ...(session.backend ? { backend: session.backend } : {}),
      ...(session.encoder ? { encoder: session.encoder } : {}),
      drawMouse: session.request.drawMouse,
    };

    if (session.state === 'starting') {
      return {
        ...base,
        target: session.request.target,
        requestedFps: session.request.fps,
        drawMouse: session.request.drawMouse,
      };
    }
    if (session.state === 'recording' || session.state === 'stopping') {
      return { ...base, ...params, upscaled: false };
    }
    if (session.state === 'completed') {
      const media = session.media || {};
      return {
        ...base,
        ...params,
        upscaled: false,
        scaled: false,
        path: session.publishedPath,
        width: media.width,
        height: media.height,
        actualFps: media.actualFps,
        actualFpsSource: media.actualFpsSource,
        durationSec: media.durationSec,
        durationSource: media.durationSource,
        frameCount: media.frameCount,
        frameCountSource: media.frameCountSource,
        bytes: session.bytes,
        pixelFormat: media.pixelFormat,
      };
    }
    if (session.state === 'failed') {
      return {
        ...base,
        ...params,
        ...(session.error ? { error: { code: session.error.code, message: session.error.message } } : {}),
      };
    }
    // cancelled：不交付路径/文件。
    return { ...base, ...params };
  }

  // -------------------------------------------------------------------------
  // execute / dispose
  // -------------------------------------------------------------------------

  async function execute(rawArgs, exec) {
    if (disposed) {
      throwFailure('invalid_argument', 'the recording service is shutting down and accepts no further actions', {
        details: { reason: 'recording_service_disposed' },
      });
    }
    const args = normalizeEnvelope(rawArgs);
    const action = readAction(args);
    if (action === 'start') {
      const request = normalizeStartArgs(args);
      return startSession(request, exec || {});
    }
    if (action === 'status') {
      const recordingId = normalizeRecordingId(args, 'status');
      return statusAction(recordingId, exec || {});
    }
    if (action === 'stop') {
      const recordingId = normalizeRecordingId(args, 'stop');
      return stopAction(recordingId, exec || {});
    }
    const recordingId = normalizeRecordingId(args, 'cancel');
    return cancelAction(recordingId, exec || {});
  }

  async function disposeSession(session) {
    const wasFailedPending = session.state === 'failed' && session.cleanupPending === true;
    const inFlight = session.state === 'starting' || session.state === 'recording' || session.state === 'stopping';
    session.abortPublish = true;
    clearTimer(session);
    const processHandle = session.process;
    if (processHandle && !processHandle.closed) {
      processHandle.killTree();
    }
    if (session.preflightChild) {
      try {
        killProcessTree(session.preflightChild);
      } catch {
        /* ignore */
      }
    }
    if (session.validationChild) {
      try {
        killProcessTree(session.validationChild);
      } catch {
        /* ignore */
      }
    }
    if (processHandle) await waitCloseBounded(processHandle, timings.killWaitMs);
    if (session.finalization) {
      await withTimeout(session.finalization, timings.killWaitMs);
    }
    await cleanupTemp(session);
    if (processHandle && !processHandle.closed) {
      session.cleanupPending = true;
      session.cleanupError = session.cleanupError || 'process_not_reaped';
    }
    if (session.state !== 'completed') {
      if (session.cleanupPending) {
        session.state = 'failed';
        session.error = session.error || makeFailure('capture_failed', 'host disposal could not clean up the recording', {
          details: { reason: 'dispose_cleanup_failed', cleanupError: session.cleanupError || null },
        });
      } else if (inFlight || wasFailedPending) {
        // 仅 Host dispose 的安全清理成功后，才允许 starting/recording/stopping（或 failed+cleanupPending）转 cancelled。
        session.state = 'cancelled';
        session.error = null;
      }
    }
    maybeRelease(session);
  }

  function dispose() {
    if (disposePromise) return disposePromise;
    disposed = true;
    disposePromise = (async () => {
      const pending = [...sessions.values()].filter(
        (session) =>
          session.state === 'starting' ||
          session.state === 'recording' ||
          session.state === 'stopping' ||
          (session.state === 'failed' && session.cleanupPending === true),
      );
      for (const session of pending) {
        try {
          await disposeSession(session);
        } catch {
          /* dispose 没有调用方可接收 throw：记录失败态并继续尽最大努力清理 */
          session.state = session.cleanupPending ? 'failed' : 'cancelled';
          if (session.cleanupPending) {
            session.error = session.error || makeFailure('capture_failed', 'host disposal failed while cleaning up', {
              details: { reason: 'dispose_cleanup_failed' },
            });
          }
        }
      }
    })();
    return disposePromise;
  }

  return { execute, probe, dispose };
}
