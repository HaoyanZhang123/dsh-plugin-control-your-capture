// recording-tool.js — capture_recording 的工具定义（0.3.0 录屏契约 §3 / §3.3）。
//
// 只做三件事：给出参数/输出 JSON Schema、把 execute 原样转发给 recording service、
// 把四种 action 的状态结果渲染成模型可读文本。**不启动进程、不做参数补全、不吞异常。**
//
// Schema 有意宽松（见交接 01 §3.1）：
//   - `action` / `target` 只声明 type:"string"，不写 enum；
//   - `fps` 只声明 type:"integer"，不写 30/60 enum；
//   - region 的 x/y/width/height 只声明 type:"number"。
// 这样未知 action、window/all、浮点 region 都会穿过 Schema 到达 service，
// 由 service 按固定错误码（invalid_argument / unsupported_target / invalid_region）分类。
// **不要为了“更严格”把 enum/minimum/maximum/pattern/if/then/oneOf 加回来**：
// 当前 DSH 工具 Schema 只支持有限关键字，且提前报 Schema 错误会破坏契约错误形态。

const RECORDING_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      description: 'Required. One of "start", "status", "stop", "cancel". Unknown values are rejected by the recording service with invalid_argument.',
    },
    recordingId: {
      type: 'string',
      description: 'Required for status/stop/cancel; must not be supplied to start. The opaque capability returned by a successful start.',
    },
    target: {
      type: 'string',
      description: 'Start only. "display" (default) or "region"; both are physical-pixel targets. "window" and "all" are unsupported in P0 and are rejected by the service with unsupported_target.',
    },
    display: {
      type: 'string',
      description: 'Start only. Opaque display id exactly as returned by capture_probe (never an array index; ids are not stable across restarts). Default: the only supported display. Multi-display is unsupported in P0.',
    },
    region: {
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y', 'width', 'height'],
      properties: {
        x: { type: 'number', description: 'Integer physical-pixel x offset from the display top-left corner. Non-integer values are rejected with invalid_region.' },
        y: { type: 'number', description: 'Integer physical-pixel y offset from the display top-left corner. Non-integer values are rejected with invalid_region.' },
        width: { type: 'number', description: 'Positive even integer physical-pixel width, fully inside the display. Odd values are rejected with invalid_region; this tool never pads or scales.' },
        height: { type: 'number', description: 'Positive even integer physical-pixel height, fully inside the display. Odd values are rejected with invalid_region; this tool never pads or scales.' },
      },
    },
    out: {
      type: 'string',
      description: 'Start only. Relative path inside the calling agent\'s workspace root; must end in .mp4 and must not escape the root or overwrite an existing file. Default: output/capture/<uuid>.mp4.',
    },
    fps: {
      type: 'integer',
      description: 'Start only. Requested capture frame rate: 30 or 60 (default 60). Other values are rejected by the service with invalid_argument.',
    },
    drawMouse: {
      type: 'boolean',
      description: 'Start only. Draw the mouse cursor into the recording. Default: true.',
    },
  },
};

/**
 * 四种 action 共用的宽松结果 Schema（交接 01 §3.3）。
 * 公共必填只有 ok/action/state/recordingId/warnings；其余字段按状态可选。
 * `path` 只允许出现在 completed；start/recording/stopping/failed/cancelled 不得携带成品路径。
 */
const RECORDING_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'action', 'state', 'recordingId', 'warnings'],
  properties: {
    ok: { type: 'boolean', const: true },
    action: { type: 'string', description: 'Echo of the requested action: start/status/stop/cancel.' },
    state: {
      type: 'string',
      enum: ['starting', 'recording', 'stopping', 'completed', 'failed', 'cancelled'],
      description: 'Fixed lifecycle vocabulary. Only completed may carry `path`.',
    },
    recordingId: { type: 'string', description: 'Opaque random capability for this recording session.' },
    warnings: { type: 'array', items: { type: 'string' } },
    target: { type: 'string', description: 'Resolved capture target: display or region.' },
    display: { type: 'string', description: 'Opaque display id that is being recorded.' },
    nativeWidth: { type: 'integer', description: 'Physical width of the recorded display.' },
    nativeHeight: { type: 'integer', description: 'Physical height of the recorded display.' },
    requestedFps: { type: 'integer', description: 'Requested capture frame rate (30 or 60).' },
    backend: { type: 'string', description: 'Recording backend, e.g. windows-ddagrab.' },
    encoder: { type: 'string', description: 'Video encoder, e.g. libx264.' },
    drawMouse: { type: 'boolean', description: 'Echo of the requested cursor drawing (start/status/stop snapshots).' },
    upscaled: { type: 'boolean', description: 'Must be false: this backend never upscales.' },
    scaled: { type: 'boolean', description: 'Must be false for display; region is an exact crop, never a scale.' },
    path: {
      type: 'string',
      description: 'Present only when state is completed: the validated, published MP4. Never present for starting/recording/stopping/failed/cancelled.',
    },
    width: { type: 'integer', description: 'Measured output width in pixels (completed only).' },
    height: { type: 'integer', description: 'Measured output height in pixels (completed only).' },
    actualFps: { type: 'number', description: 'Measured frame rate (completed only).' },
    actualFpsSource: { type: 'string', description: 'How actualFps was derived, e.g. nb_read_frames/duration.' },
    durationSec: { type: 'number', description: 'Measured duration in seconds (completed only).' },
    durationSource: { type: 'string', description: 'How durationSec was derived.' },
    frameCount: { type: 'integer', description: 'Measured frame count (completed only).' },
    frameCountSource: { type: 'string', description: 'How frameCount was derived.' },
    bytes: { type: 'integer', description: 'Published file size in bytes (completed only).' },
    pixelFormat: { type: 'string', description: 'Measured pixel format, e.g. yuv420p.' },
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message'],
      properties: {
        code: { type: 'string', description: 'Top-level contract error code, e.g. capture_failed.' },
        message: { type: 'string' },
      },
      description: 'Structured failure (failed only). No deliverable path accompanies it.',
    },
  },
};

const RECORDING_DESCRIPTION = [
  'Record the screen to an MP4 the agent can hand to the user: one display or a physical-pixel region on Windows single-display console sessions.',
  'Four actions: "start" (returns a recordingId and never a deliverable path), "status" (poll the same recordingId), "stop" (finalize, validate and publish the MP4), "cancel" (discard the recording and deliver nothing).',
  'Supported start arguments: target "display" (default) or "region" with integer physical-pixel x/y/width/height relative to the display top-left corner (width and height must be even); fps 30 or 60 (default 60); drawMouse boolean (default true); optional workspace-relative .mp4 out path.',
  'Not supported in P0: target "window" or "all", multi-display/RDP/HDR, audio, macOS/Linux recording, and any gdigrab or low-resolution fallback. "path" appears only in a completed result; never treat a starting/recording/stopping/failed/cancelled result as a file.',
  'If recording is unavailable, run capture_probe and read its recording object (available/backend/grade/targets/missing/reason).',
].join(' ');

const STATE_HINTS = {
  starting: 'The capture is starting; no video file is delivered yet. Use status/stop with this recordingId.',
  recording: 'Recording is in progress; no video file is delivered yet. Use status to poll and stop to finalize.',
  stopping: 'Stopping and validating; no video file is delivered yet. Call status (or stop again) to wait for the final result.',
};

/**
 * 契约 §3.3 的渲染：path / 实测 fps / 尺寸 / 时长只在 completed 出现。
 * starting/recording/stopping/failed/cancelled 即使误带 path 也绝不输出。
 */
function renderRecording(_args, value) {
  const lines = [`capture_recording ${value.action}: ${value.state} (recordingId ${value.recordingId})`];

  const capture = [];
  if (value.target) capture.push(`target=${value.target}`);
  if (value.display) capture.push(`display=${value.display}`);
  if (typeof value.nativeWidth === 'number' && typeof value.nativeHeight === 'number') {
    capture.push(`${value.nativeWidth}x${value.nativeHeight}`);
  }
  if (typeof value.requestedFps === 'number') capture.push(`requestedFps=${value.requestedFps}`);
  if (value.backend) capture.push(`backend=${value.backend}`);
  if (value.encoder) capture.push(`encoder=${value.encoder}`);
  if (capture.length) lines.push(`capture: ${capture.join(', ')}`);

  if (value.state === 'completed') {
    if (typeof value.path === 'string' && value.path) {
      const size = typeof value.width === 'number' && typeof value.height === 'number'
        ? `${value.width}x${value.height}`
        : 'size unavailable';
      const fps = typeof value.actualFps === 'number'
        ? `${value.actualFps} fps${value.actualFpsSource ? ` (${value.actualFpsSource})` : ''}`
        : 'measured fps unavailable';
      const duration = typeof value.durationSec === 'number' ? `${value.durationSec}s` : 'duration unavailable';
      const frames = typeof value.frameCount === 'number' ? `, ${value.frameCount} frames` : '';
      const pixelFormat = value.pixelFormat ? `, ${value.pixelFormat}` : '';
      lines.push(`file: ${value.path}`);
      lines.push(`measured: ${size}, ${fps}, ${duration}${frames}${pixelFormat}`);
      if (value.scaled === true || value.upscaled === true) {
        lines.push('quality: the service reported scaling/upscaling; treat this file as suspect.');
      }
    } else {
      lines.push('file: completed without a path (contract violation); do not treat this as a deliverable.');
    }
  } else if (value.state === 'failed') {
    const error = value.error || {};
    lines.push(`error: ${error.code || 'unknown'} — ${error.message || 'no message'}`);
    lines.push('No video file was delivered.');
  } else if (value.state === 'cancelled') {
    lines.push('cancelled; no video file was delivered.');
  } else if (STATE_HINTS[value.state]) {
    lines.push(STATE_HINTS[value.state]);
  } else {
    lines.push('unknown state; do not treat any file as a deliverable.');
  }

  if (Array.isArray(value.warnings) && value.warnings.length) lines.push(`warnings: ${value.warnings.join(', ')}`);
  return [{ type: 'text', text: lines.join('\n') }];
}

/**
 * 创建唯一的 capture_recording 工具定义。
 *
 * @param {{ execute: Function }} recordingService createRecordingService(...) 的返回值
 * @returns {{ name: string, description: string, parameters: object, output: { schema: object, render: Function }, execute: Function }}
 */
export function createRecordingTool(recordingService) {
  if (!recordingService || typeof recordingService.execute !== 'function') {
    throw new TypeError('createRecordingTool(recordingService): recordingService must expose execute(args, exec)');
  }

  return {
    name: 'capture_recording',
    description: RECORDING_DESCRIPTION,
    parameters: RECORDING_PARAMETERS,
    output: {
      schema: RECORDING_OUTPUT_SCHEMA,
      render: renderRecording,
    },
    async execute(args, exec) {
      // 原样转发：失败必须原样 throw（message 首行已是 `capture_recording failed [<code>]: ...`）。
      return await recordingService.execute(args, exec);
    },
  };
}
