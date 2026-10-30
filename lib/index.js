// index.js — Host 入口：生命周期与注册链（contract.md §2 / §11.2 / §16.2）。
//
// 只做四件事：
//   1. 手工校验 config（不引 schemastery；非法配置抛错 → fiber FAILED 可观测）；
//   2. 组装依赖并创建唯一 capture service + recording service（采集细节全在 service.js / recording-service.js）；
//   3. 注册三个工具（capture_screenshot / capture_probe / capture_recording；**先工具后 skill**：skill 供给失败不得影响工具可用性）；
//   4. 供给/更新引导 skill（降级项，失败只在日志与 capture_probe 里可见），并在 dispose 时等待 recording 清理。
//
// `inject = ['tools']` 是唯一硬依赖；workingDirectory / attachments 在**执行期**按需取，
// 缺失时由 service 报 workspace_unavailable / backend_unavailable，而不是让整个插件停在 PENDING。
//
// §16.2：`apply` 不返回 disposer —— `ctx.tools.register()` 自身就是本 fiber 的 effect；
// 这里额外挂一个 `ctx.effect`，用于“注销三工具 + await recording dispose + skill 清理”的双保险。

import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as png from './png.js';
import * as paths from './paths.js';
import * as provision from './provision-skill.js';
import { createRecordingService } from './recording-service.js';
import { createRecordingTool } from './recording-tool.js';
import { createCaptureService } from './service.js';
import { createCaptureTools } from './tool.js';

/** 必须 == cordis.patch.yml 的 insert.id。 */
export const name = 'capture-sharp';

/** 唯一硬依赖。 */
export const inject = ['tools'];

const PKG_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCOPE = 'capture-sharp';
const KNOWN_CONFIG_KEYS = ['skillRoot', 'skillInstall', 'skillCleanupOnUnload', 'timeoutMs', 'maxWidth', 'recordingMaxDurationSec'];

/**
 * 日志端口容错：`ctx.logger` 可能是 `logger(scope) => Logger`（cordis 标准形态）、
 * 也可能直接是对象、甚至缺失。**任何日志失败都不得中断注册**。
 */
function createLogger(ctx) {
  const emit = (level, message) => {
    try {
      const logger = ctx && ctx.logger;
      if (!logger) return;
      if (typeof logger === 'function') {
        let scoped;
        try {
          scoped = logger(SCOPE);
        } catch {
          scoped = undefined;
        }
        if (scoped && typeof scoped[level] === 'function') {
          scoped[level](message);
          return;
        }
        if (typeof scoped === 'function') {
          scoped(message);
          return;
        }
        logger(message);
        return;
      }
      const fn = typeof logger[level] === 'function' ? logger[level] : typeof logger.log === 'function' ? logger.log : null;
      if (fn) fn.call(logger, message);
    } catch {
      /* 日志是旁路，绝不打断注册链 */
    }
  };
  return {
    info: (message) => emit('info', message),
    warn: (message) => emit('warn', message),
    error: (message) => emit('error', message),
    debug: (message) => emit('debug', message),
  };
}

function configError(message) {
  return new TypeError(`${SCOPE}: config.${message}`);
}

/**
 * 手工校验配置（§11.2）。字段缺省 → 默认值；类型/取值非法 → 抛错（不静默掩盖）。
 *
 * @param {object|undefined|null} raw
 * @returns {{ skillRoot?: string, skillInstall: boolean, timeoutMs: number, maxWidth?: number, recordingMaxDurationSec: number }}
 */
export function normalizeConfig(raw) {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new TypeError(`${SCOPE}: config must be an object`);
  }
  const input = raw || {};

  let skillRoot;
  if (input.skillRoot !== undefined && input.skillRoot !== null) {
    if (typeof input.skillRoot !== 'string' || input.skillRoot.trim() === '') {
      throw configError('skillRoot must be a non-empty string');
    }
    if (!isAbsolute(input.skillRoot.trim())) {
      throw configError('skillRoot must be an absolute path');
    }
    skillRoot = input.skillRoot.trim();
  }

  let skillInstall = true;
  if (input.skillInstall !== undefined && input.skillInstall !== null) {
    if (typeof input.skillInstall !== 'boolean') throw configError('skillInstall must be a boolean');
    skillInstall = input.skillInstall;
  }

  // 默认 false：dispose 在"正常退出/重启"时也会跑，删技能会与新进程的 provisioning 抢目录（实测过）。
  let skillCleanupOnUnload = false;
  if (input.skillCleanupOnUnload !== undefined && input.skillCleanupOnUnload !== null) {
    if (typeof input.skillCleanupOnUnload !== 'boolean') throw configError('skillCleanupOnUnload must be a boolean');
    skillCleanupOnUnload = input.skillCleanupOnUnload;
  }

  let timeoutMs = 20000;
  if (input.timeoutMs !== undefined && input.timeoutMs !== null) {
    if (typeof input.timeoutMs !== 'number' || !Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0) {
      throw configError('timeoutMs must be a positive integer');
    }
    timeoutMs = input.timeoutMs;
  }

  let maxWidth;
  if (input.maxWidth !== undefined && input.maxWidth !== null) {
    if (typeof input.maxWidth !== 'number' || !Number.isInteger(input.maxWidth) || input.maxWidth <= 0) {
      throw configError('maxWidth must be a positive integer');
    }
    maxWidth = input.maxWidth;
  }

  // 0.3.0 契约 §4.5：录屏最大时长的 Host 配置。缺省 3600s，整数 1–86400s。
  // 非法值必须让插件失败，**不得静默替换默认值**（否则“配置没生效”会伪装成成功）。
  let recordingMaxDurationSec = 3600;
  if (input.recordingMaxDurationSec !== undefined && input.recordingMaxDurationSec !== null) {
    if (
      typeof input.recordingMaxDurationSec !== 'number'
      || !Number.isInteger(input.recordingMaxDurationSec)
      || input.recordingMaxDurationSec < 1
      || input.recordingMaxDurationSec > 86400
    ) {
      throw configError('recordingMaxDurationSec must be an integer between 1 and 86400');
    }
    recordingMaxDurationSec = input.recordingMaxDurationSec;
  }

  return {
    ...(skillRoot !== undefined ? { skillRoot } : {}),
    skillInstall,
    skillCleanupOnUnload,
    timeoutMs,
    ...(maxWidth !== undefined ? { maxWidth } : {}),
    recordingMaxDurationSec,
  };
}

const TOOL_NAMES = ['capture_screenshot', 'capture_probe', 'capture_recording'];

/** 恰好三工具、无别名：公共注册链的唯一事实在此断言，防止某个工厂多返回一个定义。 */
function assertToolDefinitions(definitions) {
  const names = Array.isArray(definitions) ? definitions.map((definition) => definition && definition.name) : [];
  const unique = new Set(names);
  const missing = TOOL_NAMES.filter((name) => !unique.has(name));
  if (names.length !== TOOL_NAMES.length || unique.size !== TOOL_NAMES.length || missing.length > 0) {
    throw new Error(
      `${SCOPE}: expected exactly ${TOOL_NAMES.join(', ')}; got ${names.map((name) => String(name)).join(', ') || '(none)'}`
      + (missing.length ? `; missing ${missing.join(', ')}` : ''),
    );
  }
}

/**
 * Host apply。
 *
 * @param {object} ctx cordis 插件 context（需要 tools；logger/effect 可选）
 * @param {object} [config] { skillRoot?, skillInstall?, timeoutMs?, maxWidth?, recordingMaxDurationSec? }
 */
export function apply(ctx, config) {
  const log = createLogger(ctx);
  const cfg = normalizeConfig(config);

  if (config && typeof config === 'object') {
    for (const key of Object.keys(config)) {
      if (!KNOWN_CONFIG_KEYS.includes(key)) log.warn(`ignoring unknown config key "${key}"`);
    }
  }

  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
    throw new Error(`${SCOPE}: requires the tools service (ctx.tools.register)`);
  }

  // 录屏 service 只在 apply 阶段构造：不 probe、不 spawn、不落 MP4（安装期零采集副作用）。
  const recordingService = createRecordingService(ctx, cfg);
  if (
    !recordingService
    || typeof recordingService.execute !== 'function'
    || typeof recordingService.probe !== 'function'
    || typeof recordingService.dispose !== 'function'
  ) {
    throw new Error(`${SCOPE}: createRecordingService(ctx, config) must return { execute, probe, dispose }`);
  }

  // 清理必须能等到 recordingService.dispose() 完成：cordis 的 effect disposer 允许返回 Promise，
  // fiber unload 会 await 它（见 evals/recording-0.3.0/T2-tools.md 的运行时文件与行号依据）。
  const disposers = [];
  let cleanupPromise;
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      // 先同步注销工具（ctx.tools.register 的 disposer 正常是同步的；返回 Promise 的仍会在下面 await）。
      const pending = [];
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          const result = dispose();
          if (result && typeof result.then === 'function') pending.push(Promise.resolve(result));
        } catch (e) {
          log.warn(`failed to unregister a tool during cleanup: ${(e && e.message) || String(e)}`);
        }
      }
      // 再等待 recording service 清理活动会话/子进程/临时文件；失败只记录，不阻断其它清理。
      try {
        await recordingService.dispose();
      } catch (e) {
        log.warn(`recording dispose failed: ${(e && e.message) || String(e)}`);
      }
      for (const promise of pending) {
        try {
          await promise;
        } catch (e) {
          log.warn(`tool cleanup failed: ${(e && e.message) || String(e)}`);
        }
      }
      // skill 清理：**默认不删**。
      // 依据（2026-10-27 实机）：cordis 的 dispose 在"应用正常退出/Electron 重启用新进程替换旧进程"时同样会跑，
      // 那不是"用户卸载插件"。若在 dispose 里删 skill，就会与新进程 apply 的 provisioning 抢同一个全局目录，
      // 结果是**重启后技能消失**（实测发生过）。所以只在显式配置 skillCleanupOnUnload=true 时才删，
      // 且 removeProvisionedSkill 仍只删"带本插件 marker 且 hash 未变"的目录。
      if (cfg.skillCleanupOnUnload === true) {
        try {
          const removal = provision.removeProvisionedSkill(cfg, PKG_ROOT);
          if (removal.removed) log.info('removed the provisioned skill during cleanup (skillCleanupOnUnload=true)');
          else log.info(`kept the provisioned skill during cleanup (${removal.reason})`);
        } catch (e) {
          log.warn(`skill cleanup failed: ${(e && e.message) || String(e)}`);
        }
      } else {
        log.info('kept the provisioned skill on unload (skillCleanupOnUnload is off by default; remove it manually or set the flag)');
      }
    })();
    return cleanupPromise;
  };

  // 先登记清理 effect（早于工具注册）：后续任一步抛错时，fiber unload 仍能回收 recording service。
  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => cleanup, `${SCOPE}: tools + recording + skill cleanup`);
    } catch (e) {
      log.warn(`could not register the cleanup effect: ${(e && e.message) || String(e)}`);
    }
  }

  // 平台→后端映射只有一处（service.js 的 PLATFORM_BACKENDS + 未知平台占位实现），
  // 这里不再传 backend，避免两份映射各自漂移（P3/R5）。
  // 录屏用固定接口接线：capture_probe 只把 recording service 的 probe 结果并列带出。
  const service = createCaptureService(ctx, cfg, {
    png,
    paths,
    provisionSkill: provision,
    recordingProbe: (exec) => recordingService.probe(exec),
  });
  const definitions = [...createCaptureTools(service), createRecordingTool(recordingService)];
  assertToolDefinitions(definitions);

  // ① 先注册三个工具（核心能力）。注册失败 = 核心失败：记录诊断后原样抛出，让 fiber 变 FAILED。
  for (const definition of definitions) {
    try {
      const dispose = ctx.tools.register(definition);
      if (typeof dispose === 'function') disposers.push(dispose);
      log.info(`registered ${definition.name}`);
    } catch (e) {
      log.error(`failed to register ${definition.name}: ${(e && e.message) || String(e)}`);
      throw e;
    }
  }

  // ② 再供给 skill（降级项）。失败不抛出，但必须留下可诊断日志 + probe 可见状态。
  let skill = { status: 'failed', path: null, version: null, contentHash: null, message: '' };
  try {
    skill = provision.provisionSkill(cfg, PKG_ROOT, (message) => log.info(message));
  } catch (e) {
    skill = { status: 'failed', path: null, version: null, contentHash: null, message: String((e && e.message) || e) };
  }
  if (skill.status === 'failed') {
    log.warn(`skill provisioning failed: ${skill.message || 'unknown error'}`);
  } else if (skill.status === 'shadowed') {
    log.warn(`skill "${provision.SKILL_NAME}" is shadowed by an existing user copy at ${skill.path}; the tools still work`);
  } else if (skill.status === 'skipped:no-source') {
    log.warn(`package has no skill/${provision.SKILL_NAME}; capture_probe will report skipped:no-source`);
  } else {
    log.info(`skill ${skill.status}${skill.path ? ' at ' + skill.path : ''}`);
  }

  log.info(`[${SCOPE}] registered ${definitions.map((definition) => definition.name).join(', ')}; skill=${skill.status}`);
}
