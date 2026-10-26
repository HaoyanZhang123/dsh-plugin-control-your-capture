#!/usr/bin/env node
/**
 * page.mjs - rasterize a web page at a true device scale factor (default 2x).
 * Cross-platform: finds Chrome / Edge / Chromium and drives it in headless mode.
 *
 *   node page.mjs --url <url|path> --out page.png [--width 960] [--height 540]
 *                 [--target-width 1920] [--scale 2] [--browser <path>] [--timeout 4000] [--gpu]
 *
 * Scale is derived, not fixed: scale = 目标像素宽 / CSS 宽。
 *   --target-width 1920 with a 960-wide viewport -> scale 2
 *   --target-width 3840 with a 960-wide viewport -> scale 4
 * --scale overrides the derivation; with neither flag, 2 is used and reported as "default".
 *
 * Why: a 1x rasterization of a page on a high-DPI screen is as soft as a 1x screen grab.
 * 960x540 CSS at --scale 2 becomes 1920x1080 real pixels.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath, isAbsolute, join } from 'node:path';
import { platform } from 'node:os';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}

const url = arg('url');
const out = arg('out');
const width = Number(arg('width', 960));
const height = Number(arg('height', 540));
const scaleFlag = arg('scale', null);
const targetWidth = Number(arg('target-width', 0));
let scale = (scaleFlag === null || scaleFlag === true) ? null : Number(scaleFlag);
let scaleWhy = 'explicit --scale';
if (scale === null) {
  if (targetWidth > 0) { scale = targetWidth / width; scaleWhy = 'target ' + targetWidth + '/css ' + width; }
  else { scale = 2; scaleWhy = 'default 2 (no --scale / --target-width)'; }
}
if (!(scale > 0) || !isFinite(scale)) { console.error('page.mjs: scale must be a positive number'); process.exit(2); }
scale = Math.round(scale * 100) / 100;
const timeoutMs = Number(arg('timeout', 4000));
const explicitBrowser = arg('browser');
const useGpu = Boolean(arg('gpu', false));

if (!url || !out) {
  console.error('usage: node page.mjs --url <url|path> --out <file.png> [--width 960] [--height 540] [--target-width 1920 | --scale 2]');
  process.exit(2);
}

function candidates() {
  const p = platform();
  const list = [];
  if (explicitBrowser) { list.push(explicitBrowser); return list; }
  if (process.env.CHROME_PATH) list.push(process.env.CHROME_PATH);
  if (p === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    list.push(
      join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
      join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
      local ? join(local, 'Google\\Chrome\\Application\\chrome.exe') : '',
      join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
      join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
    );
  } else if (p === 'darwin') {
    list.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    list.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
      '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium');
  }
  return list.filter(Boolean);
}

const browser = candidates().find((c) => c && existsSync(c));
if (!browser) {
  console.error('page.mjs: no Chrome/Edge/Chromium found. Pass --browser <path> or set CHROME_PATH.');
  process.exit(3);
}

let target = url;
if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) {
  target = 'file:///' + resolvePath(url).replace(/\\/g, '/');
  if (!isAbsolute(url)) target = 'file:///' + target.replace(/^file:\/\/\/\/?/, '');
}

const outDir = dirname(resolvePath(out));
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const args = [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--force-device-scale-factor=' + scale,
  '--window-size=' + width + ',' + height,
  '--screenshot=' + resolvePath(out),
  '--virtual-time-budget=' + timeoutMs,
];
if (!useGpu) args.unshift('--disable-gpu');
args.push(target);

const run = spawnSync(browser, args, { encoding: 'utf8', timeout: timeoutMs + 30000 });
const ok = existsSync(out) && statSync(out).size > 0;
if (!ok) {
  const tail = String(run.stderr || '').split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
  console.error('page.mjs: screenshot not produced (exit ' + run.status + ') ' + tail);
  process.exit(4);
}

const buf = readFileSync(out);
const w = buf.readUInt32BE(16);
const h = buf.readUInt32BE(20);
const expect = Math.round(width * scale) + 'x' + Math.round(height * scale);
console.log('page scale=' + scale + ' (' + scaleWhy + ') css=' + width + 'x' + height + ' expect=' + expect +
  ' output=' + w + 'x' + h + ' path=' + resolvePath(out));
