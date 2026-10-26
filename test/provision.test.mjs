import { mkdtempSync, existsSync, writeFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { provisionSkill, resolveSkillRoot } from '../lib/index.js';

const ok = (cond, msg) => console.log((cond ? 'PASS ' : 'FAIL ') + msg);
const base = mkdtempSync(join(tmpdir(), 'cap-prov-'));
const skills = join(base, 'skills');

// 1) 首次安装
let r = provisionSkill(skills);
ok(r === 'installed', 'first install -> ' + r);
ok(existsSync(join(skills, 'capture-sharp', 'SKILL.md')), 'SKILL.md installed');
ok(existsSync(join(skills, 'capture-sharp', 'scripts', 'shot.ps1')), 'shot.ps1 installed');
ok(existsSync(join(skills, 'capture-sharp', 'scripts', 'capture.sh')), 'capture.sh installed');
ok(existsSync(join(skills, 'capture-sharp', '.installed-by-dsh-plugin-control-your-capture.json')), 'marker written');

// 2) 幂等
r = provisionSkill(skills);
ok(r === 'up-to-date', 'second install -> ' + r);

// 3) 版本变化 -> 整目录替换（旧的残留文件必须消失）
const stale = join(skills, 'capture-sharp', 'scripts', 'STALE.ps1');
writeFileSync(stale, 'old');
const markerPath = join(skills, 'capture-sharp', '.installed-by-dsh-plugin-control-your-capture.json');
writeFileSync(markerPath, JSON.stringify({ plugin: 'dsh-plugin-control-your-capture', version: '0.0.0' }));
r = provisionSkill(skills);
ok(r === 'updated', 'version bump -> ' + r);
ok(!existsSync(stale), 'stale file removed on update');

// 4) 用户自己放的同名技能 -> 不动
const userSkills = join(base, 'user-skills');
mkdirSync(join(userSkills, 'capture-sharp'), { recursive: true });
writeFileSync(join(userSkills, 'capture-sharp', 'MINE.md'), 'mine');
r = provisionSkill(userSkills);
ok(r === 'kept-user-copy', 'user copy kept -> ' + r);
ok(!existsSync(join(userSkills, 'capture-sharp', 'SKILL.md')), 'did not overwrite user copy');

// 5) resolveSkillRoot 优先级
process.env.DSH_CAPTURE_SKILL_ROOT = join(base, 'env-root');
ok(resolveSkillRoot({}) === join(base, 'env-root'), 'env override wins');
ok(resolveSkillRoot({ skillRoot: join(base, 'cfg-root') }) === join(base, 'cfg-root'), 'config wins over env');
delete process.env.DSH_CAPTURE_SKILL_ROOT;

console.log('installed tree:', readdirSync(join(skills, 'capture-sharp')).sort().join(','));
rmSync(base, { recursive: true, force: true });
