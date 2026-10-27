// provision-skill.js — 引导 skill 的安装 / hash / 健康状态 / 清理（contract.md §11.3）。
//
// 边界：只做文件系统操作，不注册工具、不截图、不 spawn。
//
// 决策表（§11.3）：
//   目标目录不存在              → 复制 + 写 marker                     → installed
//   marker 且 version+hash 一致 → 不动                                 → up-to-date
//   marker 且 version/hash 不一致 → 先复制到临时目录并校验完整，再整体替换 → updated
//   无 marker（用户副本）        → 不动，**永不删除**                    → shadowed
//   配置禁用                    → 不动                                  → disabled
//   源目录缺失                  → 不动                                  → skipped:no-source
//   任何 IO 异常                → 保留现场，记 message                  → failed
//
// `skillStatus()` 只读；`removeProvisionedSkill()` 只删“本插件装且 hash 未变”的目录。
//
// 注意：返回的 status 必须落在 contract §5.2 的 skillStatus 枚举内，否则 capture_probe
// 的 output schema 会拒收整个结果。因此“目录还不存在”映射为 `skipped:no-target`
// （契约 §5.2 没有 `missing` 这一取值，已向 lead 报告）。

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const SKILL_NAME = 'capture-sharp';
export const MARKER_NAME = '.installed-by-dsh-plugin-control-your-capture.json';

const SOURCE_SEGMENTS = ['skill', SKILL_NAME];

/** skill 根：config.skillRoot → $DSH_HOME/skills → ~/.dsh/skills（与 0.1.x 一致，§11.2）。 */
export function resolveSkillRoot(config = {}) {
  if (config && typeof config.skillRoot === 'string' && config.skillRoot.trim() !== '') {
    return config.skillRoot.trim();
  }
  if (process.env.DSH_HOME) return join(process.env.DSH_HOME, 'skills');
  return join(homedir(), '.dsh', 'skills');
}

function sourceDir(pkgRoot) {
  return join(pkgRoot, ...SOURCE_SEGMENTS);
}

function targetDir(config, pkgRoot) {
  void pkgRoot;
  const root = resolveSkillRoot(config);
  return root ? join(root, SKILL_NAME) : null;
}

function listFiles(dir, ignore = new Set()) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (ignore.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(dir);
  out.sort();
  return out;
}

/**
 * 对一棵目录做稳定摘要：按相对路径排序，逐文件把
 * `<posix 相对路径>\0<字节>` 喂给 sha256。返回 64 位 hex（不带前缀）。
 * `ignore` 用于排除本插件自己的 marker（它不属于被供给的内容）。
 */
export function hashTree(dir, ignore = []) {
  const skip = new Set(ignore);
  const hash = createHash('sha256');
  for (const file of listFiles(dir, skip)) {
    const rel = relative(dir, file).split(sep).join('/');
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function pkgVersion(pkgRoot) {
  try {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function readMarker(dest) {
  try {
    const raw = JSON.parse(readFileSync(join(dest, MARKER_NAME), 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return {
      plugin: typeof raw.plugin === 'string' ? raw.plugin : null,
      version: typeof raw.version === 'string' ? raw.version : null,
      contentHash: typeof raw.contentHash === 'string' ? raw.contentHash : null,
      installedAt: typeof raw.installedAt === 'string' ? raw.installedAt : null,
    };
  } catch {
    return null;
  }
}

function writeMarker(dest, version, contentHash) {
  writeFileSync(
    join(dest, MARKER_NAME),
    JSON.stringify(
      {
        plugin: 'dsh-plugin-control-your-capture',
        version,
        contentHash,
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
}

function belongsToUs(marker) {
  return Boolean(marker && marker.plugin === 'dsh-plugin-control-your-capture');
}

/** Windows 上杀毒/文件监听器会短暂占用刚写出的目录，rename 会偶发 EPERM/EBUSY。 */
const TRANSIENT_FS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY', 'EEXIST']);

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* 极端环境不支持也无妨，退化为不等待 */
  }
}

function renameWithRetry(from, to, attempts = 8) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      last = error;
      if (!TRANSIENT_FS_CODES.has(error && error.code)) throw error;
      sleepSync(40 * (attempt + 1));
    }
  }
  throw last;
}

/**
 * 复制到临时目录并校验完整，校验通过后再整体替换目标。
 *
 * 两条硬约束（2026-10-27 装机实测后补）：
 *  - **不先删旧副本**：旧目录先 rename 成 `*.bak-*`，新目录就位成功后才删；
 *    替换失败时把旧目录 rename 回来。原实现"先 rmSync(dest) 再 rename"在 Windows 上
 *    一旦 rename 偶发 EPERM，就会把用户可用的技能目录变成"没了"。
 *  - **rename 带退避重试**：刚写出的目录可能被杀毒/监听器短暂占用。
 */
function replaceWithVerifiedCopy(src, dest, version, srcHash) {
  const stamp = createHash('sha1').update(String(Date.now()) + Math.random()).digest('hex').slice(0, 12);
  const temp = dest + '.tmp-' + stamp;
  const backup = dest + '.bak-' + stamp;
  let movedAside = false;
  try {
    cpSync(src, temp, { recursive: true });
    const copiedHash = hashTree(temp);
    if (copiedHash !== srcHash) {
      throw new Error('copied skill tree hash mismatch (' + copiedHash + ' != ' + srcHash + ')');
    }
    if (existsSync(dest)) {
      renameWithRetry(dest, backup);
      movedAside = true;
    }
    try {
      renameWithRetry(temp, dest);
    } catch (error) {
      if (movedAside && !existsSync(dest)) {
        try {
          renameWithRetry(backup, dest);
          movedAside = false;
        } catch {
          /* 恢复失败也要把原始错误抛出去 */
        }
      }
      throw error;
    }
    writeMarker(dest, version, srcHash);
  } finally {
    rmSync(temp, { recursive: true, force: true });
    if (movedAside) rmSync(backup, { recursive: true, force: true });
  }
}

/**
 * 安装/更新引导 skill。
 *
 * @param {{ skillRoot?: string, skillInstall?: boolean }} config
 * @param {string} pkgRoot 插件包根目录（含 package.json 与 skill/capture-sharp）
 * @param {(message: string) => void} [log]
 * @returns {{ status: string, path: string|null, version: string|null, contentHash: string|null, message: string }}
 */
export function provisionSkill(config = {}, pkgRoot, log = () => {}) {
  const src = sourceDir(pkgRoot);
  const version = pkgVersion(pkgRoot);
  const say = (message) => {
    try {
      log(message);
    } catch {
      /* 日志失败不影响供给 */
    }
  };

  if (config && config.skillInstall === false) {
    return { status: 'disabled', path: null, version, contentHash: null, message: 'skillInstall is false' };
  }
  if (!existsSync(src)) {
    return { status: 'skipped:no-source', path: null, version, contentHash: null, message: 'package has no skill/' + SKILL_NAME };
  }

  let dest;
  try {
    dest = targetDir(config, pkgRoot);
  } catch (e) {
    return { status: 'failed', path: null, version, contentHash: null, message: String((e && e.message) || e) };
  }
  if (!dest) {
    return { status: 'skipped:no-target', path: null, version, contentHash: null, message: 'no skill root could be resolved' };
  }

  try {
    const srcHash = hashTree(src);

    if (!existsSync(dest)) {
      mkdirSync(resolveSkillRoot(config), { recursive: true });
      replaceWithVerifiedCopy(src, dest, version, srcHash);
      say('installed ' + SKILL_NAME + ' v' + (version || 'unknown') + ' -> ' + dest);
      return { status: 'installed', path: dest, version, contentHash: hashTree(dest, [MARKER_NAME]), message: '' };
    }

    const marker = readMarker(dest);
    if (!belongsToUs(marker)) {
      say('kept existing user copy at ' + dest + ' (no marker from this plugin)');
      return {
        status: 'shadowed',
        path: dest,
        version,
        contentHash: hashTree(dest, [MARKER_NAME]),
        message: 'an existing skill directory without this plugin marker is left untouched',
      };
    }

    // §16.9：marker.contentHash 记录的是**安装副本**的哈希，因此
    //   - src 变了（srcHash !== marker.contentHash），或
    //   - 副本被改过（destHash !== srcHash）
    // 任一成立都要更新；两者都一致才算 up-to-date。
    const destHash = hashTree(dest, [MARKER_NAME]);
    if (marker.version === version && marker.contentHash === srcHash && destHash === srcHash) {
      return { status: 'up-to-date', path: dest, version, contentHash: destHash, message: '' };
    }

    replaceWithVerifiedCopy(src, dest, version, srcHash);
    say('updated ' + SKILL_NAME + ' ' + (marker.version || '?') + ' -> ' + (version || 'unknown') + ' at ' + dest);
    return { status: 'updated', path: dest, version, contentHash: hashTree(dest, [MARKER_NAME]), message: '' };
  } catch (e) {
    return { status: 'failed', path: dest, version, contentHash: null, message: String((e && e.message) || e) };
  }
}

/**
 * 只读健康状态（不写盘、不复制）。返回值落在 contract §5.2 的 skillStatus 枚举内。
 *
 * @returns {{ status: string, path: string|null, version: string|null, contentHash: string|null, message: string }}
 */
export function skillStatus(config = {}, pkgRoot) {
  const src = sourceDir(pkgRoot);
  const version = pkgVersion(pkgRoot);

  if (config && config.skillInstall === false) {
    return { status: 'disabled', path: null, version: null, contentHash: null, message: 'skillInstall is false' };
  }
  if (!existsSync(src)) {
    return { status: 'skipped:no-source', path: null, version, contentHash: null, message: 'package has no skill/' + SKILL_NAME };
  }

  let dest;
  try {
    dest = targetDir(config, pkgRoot);
  } catch (e) {
    return { status: 'failed', path: null, version, contentHash: null, message: String((e && e.message) || e) };
  }
  if (!dest) {
    return { status: 'skipped:no-target', path: null, version, contentHash: null, message: 'no skill root could be resolved' };
  }

  try {
    if (!existsSync(dest)) {
      // 契约 §5.2 的枚举没有 "missing"，用 skipped:no-target 表示“尚未安装”；
      // §16.9：dest 不存在时 contentHash 必须是 null（不得拿源哈希顶替）。
      return { status: 'skipped:no-target', path: dest, version, contentHash: null, message: 'skill is not installed in this profile yet' };
    }
    // §16.9：任何分支都只返回**当前安装副本（dest）**的哈希，不在分支间切换语义。
    const destHash = hashTree(dest, [MARKER_NAME]);
    const marker = readMarker(dest);
    if (!belongsToUs(marker)) {
      return { status: 'shadowed', path: dest, version, contentHash: destHash, message: 'a user copy shadows the provisioned skill' };
    }
    const srcHash = hashTree(src);
    if (marker.version === version && marker.contentHash === srcHash && destHash === srcHash) {
      return { status: 'up-to-date', path: dest, version, contentHash: destHash, message: '' };
    }
    return {
      status: 'installed',
      path: dest,
      version: marker.version || version,
      contentHash: destHash,
      message: 'provisioned copy is stale; the next apply will update it',
    };
  } catch (e) {
    return { status: 'failed', path: dest, version, contentHash: null, message: String((e && e.message) || e) };
  }
}

/**
 * 只删“本插件装且内容未变”的目录；用户改过或不是本插件装的目录一律不动。
 *
 * @returns {{ removed: boolean, reason: string }}
 */
export function removeProvisionedSkill(config = {}, pkgRoot) {
  if (config && config.skillInstall === false) return { removed: false, reason: 'disabled' };

  let dest;
  try {
    dest = targetDir(config, pkgRoot);
  } catch {
    return { removed: false, reason: 'no-target' };
  }
  if (!dest || !existsSync(dest)) return { removed: false, reason: 'not-installed' };

  const marker = readMarker(dest);
  if (!belongsToUs(marker)) return { removed: false, reason: 'not-ours' };

  // 判据是“**目标副本**是否仍与本插件写入时一致”，不是“源包是否升级”：
  // 用户改过的目录必须保留；源包升级但副本未被用户改过时，仍可安全删除。
  let destHash;
  try {
    destHash = hashTree(dest, [MARKER_NAME]);
  } catch {
    return { removed: false, reason: 'dest-unreadable' };
  }
  if (!marker.contentHash || marker.contentHash !== destHash) return { removed: false, reason: 'modified-by-user' };

  try {
    rmSync(dest, { recursive: true, force: true });
    return { removed: true, reason: 'removed' };
  } catch (e) {
    return { removed: false, reason: 'remove-failed: ' + String((e && e.message) || e) };
  }
}

/** 供诊断/测试：目标目录的绝对路径（不创建）。 */
export function skillTargetPath(config = {}) {
  const root = resolveSkillRoot(config);
  return root && isAbsolute(root) ? join(root, SKILL_NAME) : null;
}

/** 供诊断/测试：当前包内 skill 源目录是否存在且可读。 */
export function skillSourceInfo(pkgRoot) {
  const src = sourceDir(pkgRoot);
  if (!existsSync(src)) return { exists: false, path: src, files: 0, bytes: 0 };
  try {
    const files = listFiles(src);
    let bytes = 0;
    for (const file of files) bytes += statSync(file).size;
    return { exists: true, path: src, files: files.length, bytes };
  } catch {
    return { exists: true, path: src, files: 0, bytes: 0 };
  }
}
