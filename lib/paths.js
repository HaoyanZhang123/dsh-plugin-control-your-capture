// paths.js — 输出根解析、越界拒绝、唯一命名、原子重命名（契约 §1.1 / §7）。
//
// 导出：
//   resolveOutputRoot(ctx, exec)          -> { root, dir }  失败 throw workspace_unavailable
//   resolveOutPath(root, out, fileName)   -> string(绝对)    失败 throw invalid_argument / invalid_output
//   writeAtomic(dir, fileName, bytes)     -> Promise<string>
//   writeAtomicEx(dir, fileName, bytes)   -> Promise<{ path, renamed }>
//
// 硬规则：
//  - 不读 process.cwd()：根必须来自 workingDirectory.ensure(agent, signal)，
//    并且要求 exec.agent.session.header.cwd 是非空绝对路径作为“非猜测”证据；
//  - 所有失败都是带 `failure` 属性的 Error（{code,message,details,hint}），由 service 统一渲染文本；
//  - 临时文件与目标同目录，写完 fsync 再 rename；并发调用不共享任何路径。

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** 落盘子目录（契约 §7.1）。 */
export const OUTPUT_SUBDIR = ['output', 'capture'];

/** 构造带结构化 failure 的 Error（service 负责渲染成三行文本）。 */
export function captureError(code, message, extra = {}) {
  const error = new Error(message);
  error.failure = {
    code,
    message,
    ...(extra.details ? { details: extra.details } : {}),
    ...(extra.hint ? { hint: extra.hint } : {}),
  };
  return error;
}

function fail(code, message, extra) {
  throw captureError(code, message, extra);
}

function shortError(e) {
  if (!e) return 'unknown';
  const code = e.code ? String(e.code) : '';
  const message = e.message ? String(e.message) : String(e);
  return (code ? code + ': ' : '') + message.slice(0, 200);
}

/** 平台不敏感的前缀包含判断（Windows 大小写不敏感）。 */
export function isInside(root, target, platform = process.platform) {
  const normalize = (value) => {
    const abs = resolve(value);
    return platform === 'win32' ? abs.toLowerCase() : abs;
  };
  const rel = relative(normalize(root), normalize(target));
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return !(rel === '..' || rel.startsWith('..' + sep));
}

/** 找到最近的已存在祖先目录（用于 realpath 复核符号链接）。 */
function nearestExistingAncestor(target) {
  let current = target;
  for (let i = 0; i < 64; i += 1) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function realpathOrSelf(target) {
  try {
    return realpathSync.native ? realpathSync.native(target) : realpathSync(target);
  } catch {
    return target;
  }
}

/**
 * 解析输出根（契约 §7.1 的 ①→④ 顺序，全部失败即 workspace_unavailable）。
 *
 * @param {object} ctx 插件 context（只需要 ctx.get）
 * @param {{ agent?: object, signal?: AbortSignal }} exec 工具执行上下文
 * @returns {Promise<{ root: string, dir: string }>}
 */
export async function resolveOutputRoot(ctx, exec) {
  const agent = exec && exec.agent;
  if (!agent) {
    fail('workspace_unavailable', 'this capture has no calling agent to resolve a workspace for', {
      details: { reason: 'no_agent' },
      hint: 'run capture_screenshot from an agent session that has a workspace',
    });
  }

  // ① 非猜测证据：会话原始目录
  const header = agent.session && agent.session.header;
  const original = header && header.cwd;
  if (typeof original !== 'string' || original.trim() === '' || !isAbsolute(original)) {
    fail('workspace_unavailable', 'the calling session records no absolute workspace directory', {
      details: { reason: 'no_session_header_cwd' },
      hint: 'open the session inside a workspace directory instead of a detached/cwd-less session',
    });
  }

  // ② 唯一权威来源
  const service = ctx && typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined;
  if (!service || typeof service.ensure !== 'function') {
    fail('workspace_unavailable', 'this deployment has no workingDirectory service', {
      details: { reason: 'no_working_directory_service' },
      hint: 'enable the workingDirectory service (it ships with the standard DSH desktop profile)',
    });
  }

  // ③ 存在性 + 文档化恢复
  let root;
  try {
    root = await service.ensure(agent, exec.signal);
  } catch (e) {
    fail('workspace_unavailable', 'the workspace directory is unavailable', {
      details: { reason: 'not_a_directory', error: shortError(e) },
      hint: 're-open the project folder before capturing',
    });
  }
  if (typeof root !== 'string' || !isAbsolute(root)) {
    fail('workspace_unavailable', 'the resolved workspace is not an absolute path', {
      details: { reason: 'not_a_directory' },
      hint: 're-open the project folder before capturing',
    });
  }

  // ④ 可写性：建目录 + 写一个探针文件再删掉（不截图、不落图片）
  const dir = join(root, ...OUTPUT_SUBDIR);
  const probeFile = join(dir, '.probe-' + randomUUID());
  try {
    mkdirSync(dir, { recursive: true });
    const fd = openSync(probeFile, 'w');
    try {
      writeSync(fd, Buffer.alloc(0));
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    rmSync(probeFile, { force: true });
    fail('workspace_unavailable', 'the workspace output directory is not writable', {
      details: { reason: 'not_writable', dir, error: shortError(e) },
      hint: 'check directory permissions for ' + dir,
    });
  }
  rmSync(probeFile, { force: true });

  return { root, dir };
}

/**
 * 解析 out 参数（契约 §7.2）。相对**工作区根**；缺省落到 <root>/output/capture/<fileName>。
 *
 * @param {string} root 工作区根（绝对）
 * @param {string|undefined|null} out
 * @param {string} fileName 缺省文件名（uuid.png）
 * @returns {string} 绝对路径
 */
export function resolveOutPath(root, out, fileName) {
  if (typeof root !== 'string' || !isAbsolute(root)) {
    fail('workspace_unavailable', 'the workspace root is not an absolute path', { details: { reason: 'not_a_directory' } });
  }
  if (typeof fileName !== 'string' || !fileName) {
    fail('invalid_argument', 'internal: missing default file name for the capture output', { details: { reason: 'no_file_name' } });
  }

  if (out === undefined || out === null) {
    return join(root, ...OUTPUT_SUBDIR, fileName);
  }
  if (typeof out !== 'string') {
    fail('invalid_argument', 'out must be a string relative path', { details: { reason: 'out_not_string' }, hint: 'omit out to use output/capture/<uuid>.png' });
  }
  if (out.trim() === '') {
    fail('invalid_argument', 'out must not be empty', { details: { reason: 'out_empty' }, hint: 'omit out to use output/capture/<uuid>.png' });
  }
  if (out.includes('\0')) {
    fail('invalid_argument', 'out contains a NUL byte', { details: { reason: 'out_invalid' } });
  }
  if (/^[a-zA-Z]:/.test(out) || isAbsolute(out) || out.startsWith('\\\\') || out.startsWith('//')) {
    fail('invalid_argument', 'out must be relative to the workspace root, not absolute', {
      details: { reason: 'out_absolute' },
      hint: 'pass a path like "output/capture/demo.png"',
    });
  }

  const unified = out.replace(/[\\/]+/g, '/');
  const ext = extname(unified);
  let relativePath = unified;
  if (ext === '') relativePath = unified + '.png';
  else if (ext.toLowerCase() !== '.png') {
    fail('invalid_argument', 'only PNG output is supported, so out must end with .png', {
      details: { reason: 'out_not_png', ext },
      hint: 'use a .png extension',
    });
  }

  const target = resolve(root, relativePath);
  if (!isInside(root, target)) {
    fail('invalid_argument', 'out escapes the workspace root after normalization', {
      details: { reason: 'out_escape', root },
      hint: 'do not use ".." to climb out of the workspace',
    });
  }

  // 符号链接 / junction 复核：已存在的祖先目录 realpath 后仍必须在 root 内
  const ancestor = nearestExistingAncestor(dirname(target));
  if (ancestor) {
    const realRoot = realpathOrSelf(root);
    const realAncestor = realpathOrSelf(ancestor);
    if (!isInside(realRoot, realAncestor) && realAncestor !== realRoot) {
      fail('invalid_argument', 'out resolves through a symlink that leaves the workspace root', {
        details: { reason: 'out_symlink_escape', ancestor: realAncestor },
      });
    }
  }

  const parent = dirname(target);
  try {
    mkdirSync(parent, { recursive: true });
  } catch (e) {
    fail('invalid_output', 'the parent directory for out cannot be created', {
      details: { reason: 'out_not_writable', dir: parent, error: shortError(e) },
    });
  }
  const writeProbe = join(parent, '.probe-' + randomUUID());
  try {
    const fd = openSync(writeProbe, 'w');
    try {
      writeSync(fd, Buffer.alloc(0));
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    rmSync(writeProbe, { force: true });
    fail('invalid_output', 'the parent directory for out is not writable', {
      details: { reason: 'out_not_writable', dir: parent, error: shortError(e) },
    });
  }
  rmSync(writeProbe, { force: true });

  return target;
}

/**
 * 原子写入（契约 §7.3）：同目录临时文件 → fsync → rename。
 * 目标已存在时不覆盖：改写 <stem>-<短uuid>.png。
 *
 * @returns {Promise<{ path: string, renamed: boolean }>}
 */
export async function writeAtomicEx(dir, fileName, bytes) {
  let finalPath = join(dir, fileName);
  let renamed = false;
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    fail('invalid_output', 'cannot create the output directory', {
      details: { reason: 'out_not_writable', dir, error: shortError(e) },
    });
  }

  if (existsSync(finalPath)) {
    const ext = extname(finalPath);
    const stem = finalPath.slice(0, finalPath.length - ext.length);
    finalPath = stem + '-' + randomUUID().slice(0, 8) + ext;
    renamed = true;
  }

  const tmpPath = join(dir, '.tmp-' + randomUUID() + '.png');
  try {
    const fd = openSync(tmpPath, 'w');
    try {
      writeSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, finalPath);
  } catch (e) {
    rmSync(tmpPath, { force: true });
    fail('invalid_output', 'failed to write the PNG atomically', {
      details: { reason: 'write_failed', dir, error: shortError(e) },
    });
  } finally {
    rmSync(tmpPath, { force: true });
  }

  // 落盘后确认非空（尺寸/结构校验由调用方的 png.inspectPng 负责）
  try {
    const info = statSync(finalPath);
    if (!info.isFile() || info.size === 0) {
      fail('invalid_output', 'the written PNG is missing or empty', { details: { reason: 'empty_file', path: finalPath } });
    }
  } catch (e) {
    if (e && e.failure) throw e;
    fail('invalid_output', 'the written PNG cannot be inspected', {
      details: { reason: 'stat_failed', path: finalPath, error: shortError(e) },
    });
  }

  return { path: finalPath, renamed };
}

/** 契约签名版本：只返回最终绝对路径。 */
export async function writeAtomic(dir, fileName, bytes) {
  const result = await writeAtomicEx(dir, fileName, bytes);
  return result.path;
}
