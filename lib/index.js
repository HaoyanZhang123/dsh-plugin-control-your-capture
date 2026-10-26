// dsh-plugin-control-your-capture 宿主侧入口。
//
// 职责只有一个：把包内自带的 skill（skill/capture-sharp）装到 DSH 的全局 skill 目录，
// 让任何工作区、任何会话都能用上"按物理像素抓屏"的那套脚本。
//
// 设计取舍：
//  - 零运行时依赖（不引 schemastery），装完即用，跨平台只依赖 node:fs / node:path / node:os；
//  - 不注册第二个 skill provider，避免与官方 skill-filesystem 抢 providerName；
//  - 覆盖策略保守：只覆盖"本插件装的"副本（带 marker），用户自己放的同名 skill 一律不动。
import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILL_NAME = 'capture-sharp';
const MARKER = '.installed-by-dsh-plugin-control-your-capture.json';

/** 插件在 profile 里的行 id（cordis.patch.yml 的 insert.id）。 */
export const name = 'capture-sharp';

/** 硬依赖为空：本插件不改任何服务，只落一个 skill 目录。 */
export const inject = [];

function pkgVersion() {
  try {
    return JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** 目标 skill 根：显式配置 > 环境变量 > $DSH_HOME/skills > ~/.dsh/skills（与 DSH 自身解析一致）。 */
export function resolveSkillRoot(config) {
  const fromConfig = config && typeof config.skillRoot === 'string' ? config.skillRoot.trim() : '';
  if (fromConfig) return fromConfig;
  const fromEnv = process.env.DSH_CAPTURE_SKILL_ROOT;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  if (process.env.DSH_HOME) return join(process.env.DSH_HOME, 'skills');
  return join(homedir(), '.dsh', 'skills');
}

function readMarker(markerPath) {
  try { return JSON.parse(readFileSync(markerPath, 'utf8')); } catch { return null; }
}

function writeMarker(markerPath, version) {
  writeFileSync(markerPath, JSON.stringify({
    plugin: 'dsh-plugin-control-your-capture',
    version,
    installedAt: new Date().toISOString(),
  }, null, 2) + '\n');
}

/**
 * 把包内 skill 装到全局 skill 目录。
 * 返回：installed | updated | up-to-date | kept-user-copy | skipped:no-target | skipped:no-source
 */
export function provisionSkill(skillRoot, log = () => {}) {
  const src = join(PKG, 'skill', SKILL_NAME);
  if (!skillRoot) return 'skipped:no-target';
  if (!existsSync(src)) return 'skipped:no-source';

  const dest = join(skillRoot, SKILL_NAME);
  const markerPath = join(dest, MARKER);
  const version = pkgVersion();

  if (!existsSync(dest)) {
    mkdirSync(skillRoot, { recursive: true });
    cpSync(src, dest, { recursive: true });
    writeMarker(markerPath, version);
    log('已安装 ' + SKILL_NAME + ' v' + version + ' → ' + dest);
    return 'installed';
  }

  const marker = readMarker(markerPath);
  if (!marker) {
    log('已存在 ' + dest + ' 但不是本插件装的，保留不动（要接管请先自行移走该目录）');
    return 'kept-user-copy';
  }
  if (marker.version === version) return 'up-to-date';

  // 版本变化：整目录替换，避免旧脚本残留
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });
  writeMarker(markerPath, version);
  log('已更新 ' + SKILL_NAME + ' v' + marker.version + ' → v' + version);
  return 'updated';
}

export function apply(ctx, config) {
  try {
    const root = resolveSkillRoot(config);
    const result = provisionSkill(root, (m) => console.log('[capture-sharp] ' + m));
    if (result !== 'up-to-date') {
      try { ctx && ctx.logger && ctx.logger.debug && ctx.logger.debug('[capture-sharp] provision: ' + result + ' @ ' + root); } catch { /* 日志端口可有可无 */ }
    }
  } catch (e) {
    console.warn('[capture-sharp] 安装配套 skill 失败：' + ((e && e.message) || e));
  }
}
