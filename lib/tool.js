// tool.js — capture_screenshot / capture_probe 的工具定义（contract.md §3 / §4 / §5）。
//
// 只做三件事：给出完成态 JSON Schema 字面量、把 execute 原样转发给 service、
// 把成功值映射成 [text, image] 两块 content。**不执行采集**、不改错误码、不吞异常。
//
// 运行时约束（api-preflight §3）：schema 只接受 type/oneOf/properties/required/
// additionalProperties/items/enum/const + description/title/default/examples，
// 没有 minimum/maximum/pattern，所以范围校验全部在 service 的参数规范化里做。
// `default` 只是注解、运行时不填，缺省值由 service 补。

/** 契约 §3 字面量（逐字照抄；改它必须先改契约）。 */
const SCREENSHOT_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    target: {
      type: 'string',
      enum: ['display', 'window', 'region'],
      description: 'What to capture. Default: "display". "region" requires the region object and is measured in PHYSICAL pixels relative to the chosen display\'s top-left corner.',
    },
    display: {
      type: 'string',
      description: 'Opaque display id exactly as returned by capture_probe (never an array index; ids are not stable across restarts). Default: the display holding the active window, else the primary display (a warning is returned when it had to fall back).',
    },
    window: {
      type: 'string',
      description: 'Backend-resolvable window id. Only meaningful when target="window". Default: the current foreground window. A missing window fails with window_not_found; it never degrades into a full-screen capture.',
    },
    region: {
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y', 'width', 'height'],
      properties: {
        x: { type: 'integer', description: 'Non-negative physical-pixel x offset from the display top-left corner.' },
        y: { type: 'integer', description: 'Non-negative physical-pixel y offset from the display top-left corner.' },
        width: { type: 'integer', description: 'Positive physical-pixel width. Must stay inside the display; cross-display regions are rejected.' },
        height: { type: 'integer', description: 'Positive physical-pixel height. Must stay inside the display; cross-display regions are rejected.' },
      },
    },
    out: {
      type: 'string',
      description: 'Relative path inside the calling agent\'s workspace root; must end in .png and must not escape the root. Default: output/capture/<uuid>.png.',
    },
    maxWidth: {
      type: 'integer',
      description: 'Positive integer. When smaller than the native width, the image is downscaled exactly once. When greater than or equal to the native width the native image is returned unchanged: this tool never upscales.',
    },
  },
};

/** 契约 §4：模型可见的附件引用。 */
const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
  properties: {
    attachmentId: { type: 'string', description: 'Durable attachment id (sha256:<hex>) of the normalized copy the model actually sees.' },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    bytes: { type: 'integer', description: 'Encoded byte length of the normalized copy.' },
    width: { type: 'integer', description: 'Width of the normalized copy in pixels.' },
    height: { type: 'integer', description: 'Height of the normalized copy in pixels.' },
    name: { type: 'string' },
    originalDimensions: {
      type: 'object',
      additionalProperties: false,
      required: ['width', 'height'],
      properties: { width: { type: 'integer' }, height: { type: 'integer' } },
    },
  },
};

/** 契约 §4：成功结果。 */
const SCREENSHOT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'path', 'width', 'height', 'platform', 'backend', 'target', 'display', 'scaled', 'upscaled', 'warnings', 'image'],
  properties: {
    ok: { type: 'boolean', const: true },
    path: { type: 'string', description: 'Absolute path of the PNG written to disk (native capture resolution, IHDR-verified).' },
    width: { type: 'integer', description: 'IHDR width of the PNG at `path`.' },
    height: { type: 'integer', description: 'IHDR height of the PNG at `path`.' },
    nativeWidth: { type: 'integer', description: 'Capture size reported by the backend. Omitted when it cannot be proven; a quality_unverified warning is then present.' },
    nativeHeight: { type: 'integer' },
    platform: { type: 'string', enum: ['win32', 'darwin', 'linux'] },
    backend: { type: 'string', description: 'Real backend that produced the bytes, e.g. windows-gdi, macos-screencapture, x11-maim, wayland-portal.' },
    target: { type: 'string', enum: ['display', 'window', 'region'] },
    display: { type: 'string', description: 'Opaque display id that was captured (window/region report the display they resolve onto).' },
    scaled: { type: 'boolean', description: 'True only when maxWidth caused exactly one downscale.' },
    upscaled: { type: 'boolean', const: false },
    warnings: { type: 'array', items: { type: 'string' } },
    image: IMAGE_VALUE_SCHEMA,
  },
};

/** 契约 §5.1：probe 无参数。 */
const PROBE_PARAMETERS = { type: 'object', additionalProperties: false, properties: {} };

/** 契约 §5.2：probe 结果。 */
const PROBE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'platform', 'architecture', 'sessionType', 'headless', 'displays', 'backends', 'permissions', 'outputRoot', 'toolRegistered', 'skillStatus', 'targets', 'warnings'],
  properties: {
    ok: { type: 'boolean', const: true },
    platform: { type: 'string', enum: ['win32', 'darwin', 'linux'] },
    architecture: { type: 'string' },
    sessionType: { type: 'string', enum: ['console', 'rdp', 'wayland', 'x11', 'headless', 'unknown'] },
    headless: { type: 'boolean' },
    displays: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'x', 'y', 'width', 'height', 'primary'],
        properties: {
          id: { type: 'string' },
          x: { type: 'integer' },
          y: { type: 'integer' },
          width: { type: 'integer', description: 'Physical pixels.' },
          height: { type: 'integer' },
          scaleFactor: { type: 'number', description: 'Only when the backend can report it.' },
          primary: { type: 'boolean' },
        },
      },
    },
    backends: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'available'],
        properties: {
          name: { type: 'string' },
          available: { type: 'boolean' },
          missing: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    permissions: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'note'],
      properties: {
        status: { type: 'string', enum: ['granted', 'denied', 'unknown', 'not_applicable'] },
        note: { type: 'string' },
      },
    },
    outputRoot: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'writable'],
      properties: {
        path: { type: 'string' },
        writable: { type: 'boolean' },
        reason: { type: 'string' },
      },
    },
    toolRegistered: { type: 'boolean' },
    skillStatus: { type: 'string', enum: ['installed', 'updated', 'up-to-date', 'kept-user-copy', 'shadowed', 'skipped:no-target', 'skipped:no-source', 'failed', 'disabled'] },
    skillPath: { type: 'string' },
    skillVersion: { type: 'string' },
    skillHash: { type: 'string' },
    targets: {
      type: 'object',
      additionalProperties: false,
      required: ['display', 'window', 'region'],
      properties: {
        display: { type: 'string', enum: ['stable', 'beta', 'experimental', 'unsupported'] },
        window: { type: 'string', enum: ['stable', 'beta', 'experimental', 'unsupported'] },
        region: { type: 'string', enum: ['stable', 'beta', 'experimental', 'unsupported'] },
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
  },
};

const SCREENSHOT_DESCRIPTION = [
  'Capture the screen as a PNG the model can actually see: one display, one window, or a physical-pixel region.',
  'Use this instead of shelling out to a screenshot tool. Defaults: target "display", native physical pixels, no scaling.',
  'Returns the absolute PNG path (native resolution) plus a normalized image the model sees; `width`/`height` are the FILE size and `image.width`/`image.height` are what the model actually sees (the attachment store may downscale and re-encode).',
  'Fine detail (small text, 1px lines) is best captured with target "region": a full-screen capture is downscaled for the model.',
  'Only display / window / region exist - there is no multi-display "all" capture. maxWidth only ever shrinks (one downscale); this tool never upscales.',
  'If a call fails with unsupported_target, backend_unavailable, permission_required, no_display or window_not_found, run capture_probe to see displays, backends, permissions and per-target grades.',
].join(' ');

const PROBE_DESCRIPTION = [
  'Diagnose screen capture without taking a screenshot: platform, architecture, session type, headless state, displays with opaque ids and physical bounds, available backends and their missing tools, permission status, output root writability, guidance-skill status, and the support grade of each target.',
  'Call this when capture_screenshot failed (to read the real reason instead of guessing), when you need a display id, or when the user asks whether screenshots work on this machine. It never captures or writes an image.',
].join(' ');

/**
 * 契约 §4.2 的唯一 content 通道。
 * 文本必须同时给出「文件尺寸」与「模型可见尺寸」，否则模型会误判清晰度。
 */
function renderScreenshot(_args, value) {
  const sized = value.nativeWidth !== undefined && (value.nativeWidth !== value.width || value.nativeHeight !== value.height)
    ? ` (backend reported ${value.nativeWidth}x${value.nativeHeight})`
    : '';
  const scaled = value.scaled ? ', downscaled once to honor maxWidth' : '';
  const seen = value.image.originalDimensions
    ? `${value.image.width}x${value.image.height} ${value.image.mediaType} (attachment store normalized from ${value.image.originalDimensions.width}x${value.image.originalDimensions.height})`
    : `${value.image.width}x${value.image.height} ${value.image.mediaType}`;
  return [
    {
      type: 'text',
      text:
        `Captured ${value.target} on ${value.display} via ${value.backend} (${value.platform}).\n` +
        `file: ${value.path} — ${value.width}x${value.height}${sized}${scaled}\n` +
        `model image: ${seen}\n` +
        (value.warnings.length ? `warnings: ${value.warnings.join(', ')}\n` : '') +
        'Fine detail is best inspected on a region capture; a full-screen capture is downscaled for the model.',
    },
    { type: 'image', attachment: value.image },
  ];
}

function renderProbe(_args, value) {
  const displays = value.displays.length
    ? value.displays
        .map((d) => `- ${d.id} ${d.width}x${d.height}${d.scaleFactor ? ' @' + d.scaleFactor + 'x' : ''}${d.primary ? ' primary' : ''}`)
        .join('\n')
    : '- (none)';
  const backends = value.backends.map((b) => `${b.name}:${b.available ? 'yes' : 'no' + (b.missing && b.missing.length ? '(' + b.missing.join(',') + ')' : '')}`).join(', ');
  const lines = [
    `capture_probe on ${value.platform}/${value.architecture} — session ${value.sessionType}${value.headless ? ' (headless)' : ''}.`,
    'displays:',
    displays,
    `backends: ${backends}`,
    `permissions: ${value.permissions.status}${value.permissions.note ? ' — ' + value.permissions.note : ''}`,
    `output root: ${value.outputRoot.path || '(unavailable)'} writable=${value.outputRoot.writable}${value.outputRoot.reason ? ' reason=' + value.outputRoot.reason : ''}`,
    `targets: display=${value.targets.display}, window=${value.targets.window}, region=${value.targets.region}`,
    `skill: ${value.skillStatus}${value.skillVersion ? ' v' + value.skillVersion : ''}${value.skillPath ? ' at ' + value.skillPath : ''}`,
    value.warnings.length ? `warnings: ${value.warnings.join(', ')}` : 'warnings: none',
  ];
  return [{ type: 'text', text: lines.join('\n') }];
}

/**
 * 创建两个工具定义（顺序 = [capture_screenshot, capture_probe]，契约 §1.1）。
 *
 * @param {{ screenshot: Function, probe: Function }} service
 * @returns {[object, object]}
 */
export function createCaptureTools(service) {
  if (!service || typeof service.screenshot !== 'function' || typeof service.probe !== 'function') {
    throw new TypeError('createCaptureTools(service): service must expose screenshot(args, exec) and probe(args, exec)');
  }

  const screenshotTool = {
    name: 'capture_screenshot',
    description: SCREENSHOT_DESCRIPTION,
    parameters: SCREENSHOT_PARAMETERS,
    output: {
      schema: SCREENSHOT_OUTPUT_SCHEMA,
      render: renderScreenshot,
    },
    async execute(args, exec) {
      // 失败必须原样 throw：message 首行已是 `capture_screenshot failed [<code>]: ...`
      return await service.screenshot(args, exec);
    },
  };

  const probeTool = {
    name: 'capture_probe',
    description: PROBE_DESCRIPTION,
    parameters: PROBE_PARAMETERS,
    output: {
      schema: PROBE_OUTPUT_SCHEMA,
      render: renderProbe,
    },
    async execute(args, exec) {
      return await service.probe(args, exec);
    },
  };

  return [screenshotTool, probeTool];
}
