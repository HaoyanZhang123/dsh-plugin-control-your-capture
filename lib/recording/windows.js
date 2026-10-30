// recording/windows.js — Windows 单屏 DDA 录屏的纯函数层。
//
// 只做四件事：
//   1. FFmpeg / FFprobe / 完整解码的 argv 计划（不 spawn、不决定工作区落点）；
//   2. FFmpeg / FFprobe / DDA filter / libx264 encoder 能力探测（通过注入的 findExe/run）；
//   3. console + 单屏 + DPI 的启动前支持判断；
//   4. FFprobe JSON 的质量判定（容器、流布局、尺寸、pix_fmt、帧数/时长/实测帧率）。
//
// 进程执行、进程树清理与最终路径全部归 service.js / recording-service.js 所有；
// 本文件零 I/O、零 spawn，便于离线正反测试。

export const BACKEND_NAME = 'windows-ddagrab';
export const ENCODER = 'libx264';

/** 等级：T3 真机证据（windows-e2e.md PASS）只支持 Windows 单屏 console 的 display/region → beta；其它平台/多屏/HDR/RDP/window 不借此次升级。 */
export const GRADE = 'beta';

/** P0 只支持这两个目标（window/all/多屏不在本后端）。 */
export const GRADES = Object.freeze({ display: GRADE, region: GRADE });
export const UNSUPPORTED_TARGETS = Object.freeze({ display: 'unsupported', region: 'unsupported' });

/** 请求帧率 → 实测允许区间（第一层 §8）。 */
const FPS_RANGES = Object.freeze({
  60: Object.freeze({ min: 55, max: 63 }),
  30: Object.freeze({ min: 27, max: 31.5 }),
});

function failure(code, message, details, hint) {
  return {
    code,
    message,
    ...(details && typeof details === 'object' ? { details } : {}),
    ...(hint ? { hint: String(hint) } : {}),
  };
}

function invalidOutput(reason, message, details) {
  return { ok: false, failure: failure('invalid_output', message, { reason, ...(details || {}) }) };
}

// ---------------------------------------------------------------------------
// argv 计划
// ---------------------------------------------------------------------------

/**
 * 录屏 FFmpeg 参数模板（固定编码契约，不暴露额外旋钮）。
 *
 * 采集：DDA `ddagrab`（output_idx=0，framerate 在输入端，draw_mouse 映射鼠标）；
 * 转换：`hwdownload,format=bgra`；region 再用精确 `crop=w:h:x:y`（裁剪不是缩放）；
 * 编码：libx264 / veryfast / CRF14 / yuv420p / +faststart；无音频输入输出。
 * 不加 `-y`，并显式 `-n`；临时文件名本身唯一，双保险防覆盖。
 *
 * @param {{ tempPath:string, target:'display'|'region', region?:{x:number,y:number,width:number,height:number}, fps:number, drawMouse:boolean }} plan
 * @returns {string[]}
 */
export function buildFfmpegArgs(plan) {
  const { tempPath, target, region, fps, drawMouse } = plan || {};
  if (typeof tempPath !== 'string' || tempPath.trim() === '') {
    throw new TypeError('buildFfmpegArgs requires a temporary output path');
  }
  if (fps !== 30 && fps !== 60) throw new TypeError('buildFfmpegArgs supports fps 30 or 60 only');
  const ddagrab = 'ddagrab=output_idx=0:framerate=' + fps + ':draw_mouse=' + (drawMouse === false ? '0' : '1');
  const filters = ['hwdownload', 'format=bgra'];
  if (target === 'region') {
    if (!region || ![region.x, region.y, region.width, region.height].every((n) => Number.isInteger(n))) {
      throw new TypeError('buildFfmpegArgs region target requires integer x/y/width/height');
    }
    filters.push('crop=' + region.width + ':' + region.height + ':' + region.x + ':' + region.y);
  }
  return [
    '-hide_banner',
    '-nostats',
    '-loglevel',
    'warning',
    '-n',
    '-f',
    'lavfi',
    '-i',
    ddagrab,
    '-vf',
    filters.join(','),
    '-an',
    '-c:v',
    ENCODER,
    '-preset',
    'veryfast',
    '-crf',
    '14',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    tempPath,
  ];
}

/** FFprobe：必须显式 count_frames，并查询完整 streams + format。 */
export function buildFfprobeArgs(filePath) {
  return [
    '-hide_banner',
    '-v',
    'error',
    '-count_frames',
    '-print_format',
    'json',
    '-show_streams',
    '-show_format',
    String(filePath),
  ];
}

/** 完整解码：无输出解码 + -xerror；exit 0 且 error stderr 为空才算过。 */
export function buildDecodeArgs(filePath) {
  return ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-i', String(filePath), '-f', 'null', '-'];
}

// ---------------------------------------------------------------------------
// 能力探测
// ---------------------------------------------------------------------------

/**
 * 真实查找 ffmpeg/ffprobe 并验证 ddagrab filter 与 libx264 encoder。
 * PATH 找不到或命令不支持都不能标 available；缺失逐项进 missing。
 *
 * @param {{ platform:string, findExe:(name:string)=>string|null, run:Function, env:object, timeoutMs?:number }} io
 * @returns {Promise<{ available:boolean, missing:string[], ffmpegPath:string|null, ffprobePath:string|null,
 *   ddagrab:boolean, libx264:boolean }>}
 */
export async function probeCapabilities(io) {
  const platform = io && io.platform ? io.platform : 'win32';
  const findExe = io && typeof io.findExe === 'function' ? io.findExe : () => null;
  const run = io && typeof io.run === 'function' ? io.run : null;
  const env = (io && io.env) || process.env;
  const timeoutMs = io && Number.isInteger(io.timeoutMs) && io.timeoutMs > 0 ? io.timeoutMs : 10000;

  if (platform !== 'win32') {
    return { available: false, missing: ['windows'], ffmpegPath: null, ffprobePath: null, ddagrab: false, libx264: false };
  }

  const missing = [];
  const ffmpegPath = findExe('ffmpeg');
  const ffprobePath = findExe('ffprobe');
  if (!ffmpegPath) missing.push('ffmpeg');
  if (!ffprobePath) missing.push('ffprobe');

  let ddagrab = false;
  let libx264 = false;
  if (ffmpegPath && run) {
    const filter = await run(ffmpegPath, ['-hide_banner', '-h', 'filter=ddagrab'], { timeoutMs, env });
    ddagrab = Boolean(filter && filter.ok && String(filter.stdout || '').includes('ddagrab'));
    if (!ddagrab) missing.push('ddagrab');

    const encoder = await run(ffmpegPath, ['-hide_banner', '-h', 'encoder=libx264'], { timeoutMs, env });
    libx264 = Boolean(encoder && encoder.ok && String(encoder.stdout || '').includes('libx264'));
    if (!libx264) missing.push(ENCODER);
  } else if (!ffmpegPath) {
    // 没有 ffmpeg 就无从证实 filter/encoder，逐项列出而不是默认存在。
    missing.push('ddagrab', ENCODER);
  }

  return {
    available: missing.length === 0,
    missing,
    ffmpegPath: ffmpegPath || null,
    ffprobePath: ffprobePath || null,
    ddagrab,
    libx264,
  };
}

// ---------------------------------------------------------------------------
// 启动前支持判断
// ---------------------------------------------------------------------------

/**
 * P0 只接受：win32 + console + 非 headless + 恰好一个显示器 + dpiAware=true。
 * 显示器本身产生奇数宽/高时 yuv420p 路径明确拒绝（不得隐式补边）。
 *
 * @param {{ platform:string, sessionType?:string, headless?:boolean, dpiAware?:boolean,
 *   displays?:Array<{id:string,x:number,y:number,width:number,height:number}> }} env
 * @returns {{ ok:true, display:object } | { ok:false, failure:object }}
 */
export function judgeEnvironment(env) {
  const platform = env && env.platform ? env.platform : process.platform;
  if (platform !== 'win32') {
    return {
      ok: false,
      failure: failure('unsupported_target', 'recording is implemented on Windows only in 0.3.0', {
        reason: 'platform_unsupported',
        platform,
        supported: ['win32'],
      }),
    };
  }
  if (env && env.headless === true) {
    return {
      ok: false,
      failure: failure('no_display', 'recording needs an interactive desktop session', { reason: 'no_display' }),
    };
  }
  if (!env || env.sessionType !== 'console') {
    return {
      ok: false,
      failure: failure('unsupported_target', 'recording only supports an interactive console session in 0.3.0', {
        reason: 'session_unsupported',
        sessionType: env && env.sessionType ? env.sessionType : 'unknown',
        supported: ['console'],
      }),
    };
  }
  const displays = env && Array.isArray(env.displays) ? env.displays.filter(Boolean) : [];
  if (displays.length === 0) {
    return {
      ok: false,
      failure: failure('no_display', 'no display is attached to this Windows session', { reason: 'no_display' }),
    };
  }
  if (displays.length > 1) {
    return {
      ok: false,
      failure: failure('unsupported_target', 'recording supports exactly one display in 0.3.0', {
        reason: 'multiple_displays',
        displays: displays.length,
      }),
    };
  }
  if (env.dpiAware !== true) {
    return {
      ok: false,
      failure: failure('backend_unavailable', 'the native helper could not verify DPI awareness, so physical pixel bounds are unreliable', {
        reason: 'dpi_awareness_unverified',
      }),
    };
  }
  const display = displays[0];
  const width = Number(display.width);
  const height = Number(display.height);
  const id = typeof display.id === 'string' ? display.id : '';
  if (!id || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return {
      ok: false,
      failure: failure('backend_unavailable', 'the native helper did not report usable physical display bounds', {
        reason: 'display_geometry_unverified',
      }),
    };
  }
  if (width % 2 !== 0 || height % 2 !== 0) {
    return {
      ok: false,
      failure: failure('unsupported_target', 'this display has odd physical dimensions, which the yuv420p contract cannot encode without padding', {
        reason: 'odd_display_dimensions',
        width,
        height,
      }),
    };
  }
  return { ok: true, display: { id, x: Number(display.x), y: Number(display.y), width, height, scaleFactor: display.scaleFactor, primary: display.primary === true } };
}

// ---------------------------------------------------------------------------
// 质量判定（FFprobe JSON）
// ---------------------------------------------------------------------------

function parsePositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseFrameCount(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseRate(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d+)\/(\d+)$/.exec(value.trim());
  if (!match) return null;
  const num = Number(match[1]);
  const den = Number(match[2]);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num <= 0) return null;
  return num / den;
}

/**
 * 判定 FFprobe（-count_frames，完整 streams+format）输出是否满足契约。
 *
 * @param {object} raw FFprobe JSON
 * @param {{ requestedFps:number, expectedWidth:number, expectedHeight:number }} expected
 * @returns {{ ok:true, width:number, height:number, pixelFormat:string, durationSec:number, durationSource:string,
 *   frameCount:number, frameCountSource:string, actualFps:number, actualFpsSource:string } | { ok:false, failure:object }}
 */
export function judgeProbeJson(raw, expected) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return invalidOutput('ffprobe_not_object', 'FFprobe did not return a JSON object');
  }
  const streams = Array.isArray(raw.streams) ? raw.streams.filter(Boolean) : [];
  const videos = streams.filter((stream) => stream && stream.codec_type === 'video');
  const audioCount = streams.filter((stream) => stream && stream.codec_type === 'audio').length;
  if (audioCount > 0) {
    return invalidOutput('audio_stream_present', 'the recording contains an audio stream; P0 recordings must be video-only', {
      audioCount,
    });
  }
  if (streams.length !== 1 || videos.length !== 1) {
    return invalidOutput('stream_layout_invalid', 'the recording must contain exactly one video stream and no other streams', {
      streamCount: streams.length,
      videoCount: videos.length,
    });
  }
  const video = videos[0];
  const format = raw.format && typeof raw.format === 'object' ? raw.format : {};
  const formatName = String(format.format_name || '').toLowerCase();
  if (!formatName.includes('mp4')) {
    return invalidOutput('container_not_mp4', 'the recording container is not MP4', { formatName });
  }
  if (String(video.codec_name || '').toLowerCase() !== 'h264') {
    return invalidOutput('codec_mismatch', 'the recording codec is not the contracted H.264/libx264', {
      codecName: String(video.codec_name || ''),
    });
  }

  const width = Number(video.width);
  const height = Number(video.height);
  const expectedWidth = Number(expected && expected.expectedWidth);
  const expectedHeight = Number(expected && expected.expectedHeight);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return invalidOutput('dimensions_invalid', 'FFprobe reported unusable video dimensions', { width: video.width, height: video.height });
  }
  if (width !== expectedWidth || height !== expectedHeight) {
    return invalidOutput('size_mismatch', 'the recorded size does not equal the physical capture size (no scaling is allowed)', {
      expected: { width: expectedWidth, height: expectedHeight },
      actual: { width, height },
    });
  }
  if (String(video.pix_fmt || '') !== 'yuv420p') {
    return invalidOutput('pixel_format_mismatch', 'the recording pixel format is not yuv420p', { pixelFormat: String(video.pix_fmt || '') });
  }

  let durationSec = parsePositiveNumber(video.duration);
  let durationSource = 'video.duration';
  if (!durationSec) {
    durationSec = parsePositiveNumber(format.duration);
    durationSource = 'format.duration';
  }
  if (!durationSec) {
    return invalidOutput('duration_invalid', 'the recording has no positive duration');
  }

  const readFrames = parseFrameCount(video.nb_read_frames);
  const declaredFrames = parseFrameCount(video.nb_frames);
  const frameCount = readFrames || declaredFrames;
  const frameCountSource = readFrames ? 'nb_read_frames' : 'nb_frames';
  if (!frameCount) {
    return invalidOutput('frame_count_invalid', 'the recording contains no countable video frames');
  }

  let actualFps;
  let actualFpsSource;
  if (readFrames) {
    actualFps = readFrames / durationSec;
    actualFpsSource = 'nb_read_frames/duration';
  } else {
    const avg = parseRate(video.avg_frame_rate);
    if (!avg) {
      return invalidOutput('frame_rate_unavailable', 'neither nb_read_frames/duration nor avg_frame_rate could establish the measured frame rate');
    }
    actualFps = avg;
    actualFpsSource = 'avg_frame_rate';
  }

  const requestedFps = Number(expected && expected.requestedFps);
  const range = FPS_RANGES[requestedFps];
  if (!range) {
    return invalidOutput('fps_request_invalid', 'internal: unsupported requested frame rate', { requestedFps });
  }
  if (!Number.isFinite(actualFps) || actualFps < range.min || actualFps > range.max) {
    return invalidOutput('fps_out_of_range', 'the measured frame rate is outside the contracted range for the requested fps', {
      requestedFps,
      actualFps,
      min: range.min,
      max: range.max,
      actualFpsSource,
    });
  }

  return {
    ok: true,
    width,
    height,
    pixelFormat: String(video.pix_fmt),
    durationSec,
    durationSource,
    frameCount,
    frameCountSource,
    actualFps,
    actualFpsSource,
  };
}
