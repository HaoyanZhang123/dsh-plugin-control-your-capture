<#
  windows-shot.ps1 — Windows 原生截图辅助（收窄版 v2）

  只由 plugin/lib/service.js 经由 adapters/windows.js 调用，不作为用户命令行的第二入口。

  模式（-Mode）：
    probe    只报告显示器/缩放/会话信息，<b>绝不截图、不写文件</b>
    display  抓一块显示器（-DisplayId 缺省 = 前台窗口所在显示器，退主屏并给警告）
    window   抓窗口（-Window 缺省 = 前台窗口；最小化/不可见/不存在 → window_not_found）
    region   抓显示器内区域（-X -Y -W -H，相对所选显示器左上角，物理像素）

  输出：stdout <b>恰好一行</b> JSON（ConvertTo-Json -Compress），字段：
    ok/code/message/retryable/hint/path/width/height/nativeWidth/nativeHeight/display/warnings
    probe 额外带 platform/sessionType/dpiAware/displays/foreground/capabilities

  规则：
    - 进程自己声明 per-monitor DPI awareness，跟谁启动它无关（git-bash → powershell.exe 的典型坑）；
    - 默认原生像素，唯一一次缩放是 -MaxWidth 触发的 HighQualityBicubic 缩小，<b>永不放大</b>；
    - 不输出窗口标题、屏幕文字或像素内容；只报尺寸、路径与状态；
    - JSON 里的 message 保持 ASCII（避免 PS 5.1 重定向编码差异），给人看的措辞由 service.js 统一生成；
    - 结构化失败也 exit 0（真正的判定看 JSON 的 ok 字段），避免 Node 侧把退出码当唯一信号。

  PS 5.1 兼容：不用三元运算、不用 ??、不用 -Parallel。含中文注释，文件必须保持 UTF-8 BOM。
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
  [ValidateSet('probe', 'display', 'window', 'region')] [string]$Mode = 'probe',
  [string]$DisplayId = '',
  [string]$Window = '',
  [int]$X = 0,
  [int]$Y = 0,
  [int]$W = 0,
  [int]$H = 0,
  [int]$MaxWidth = 0,
  [string]$Out = ''
)

$ErrorActionPreference = 'Stop'

# 重定向到管道时，显式用无 BOM 的 UTF-8，避免 Node 侧按 UTF-8 解码出现乱码。
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }

$script:Warnings = New-Object System.Collections.ArrayList

function Add-Warning {
  param([string]$text)
  if ($text -and -not $script:Warnings.Contains($text)) { [void]$script:Warnings.Add($text) }
}

function Get-WarningArray {
  $arr = New-Object System.Collections.ArrayList
  foreach ($w in $script:Warnings) { [void]$arr.Add([string]$w) }
  # 前置逗号阻止 PowerShell 把单元素数组展开成标量
  return , ([object[]]$arr.ToArray())
}

function Emit-Json {
  param($payload)
  # -Compress 保证单行；Node 侧只认这一行 JSON。
  $payload | ConvertTo-Json -Compress -Depth 8 | Write-Output
}

function Emit-Failure {
  param(
    [string]$code,
    [string]$message,
    [bool]$retryable = $false,
    [string]$hint = '',
    $details = $null
  )
  $payload = @{
    ok           = $false
    code         = $code
    message      = $message
    retryable    = $retryable
    hint         = $hint
    path         = $null
    width        = 0
    height       = 0
    nativeWidth  = 0
    nativeHeight = 0
    display      = $null
    warnings     = (Get-WarningArray)
  }
  if ($null -ne $details) { $payload['details'] = $details }
  Emit-Json $payload
  exit 0
}

# ---------------------------------------------------------------------------
# 原生互操作（P/Invoke）
# ---------------------------------------------------------------------------

if (-not ('CaptureNative' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class CaptureNative {
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
  [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hmon, int dpiType, out uint dpiX, out uint dpiY);
  [DllImport("user32.dll")] public static extern int GetDpiForSystem();

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT r);

  public static bool MakePerMonitorAware() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero) { return true; } } catch {}
    try { if (SetProcessDpiAwareness(2) == 0) { return true; } } catch {}
    try { return SetProcessDPIAware(); } catch {}
    return false;
  }

  public static bool TryGetWindowRect(IntPtr hWnd, out int x, out int y, out int w, out int h) {
    x = 0; y = 0; w = 0; h = 0;
    RECT r;
    if (!GetWindowRect(hWnd, out r)) { return false; }
    x = r.Left; y = r.Top; w = r.Right - r.Left; h = r.Bottom - r.Top;
    return true;
  }

  public static bool TryGetMonitorDpi(int x, int y, out uint dpi) {
    dpi = 0;
    try {
      POINT p;
      p.X = x; p.Y = y;
      IntPtr mon = MonitorFromPoint(p, 2);
      if (mon == IntPtr.Zero) { return false; }
      uint dx = 0; uint dy = 0;
      int hr = GetDpiForMonitor(mon, 0, out dx, out dy);
      if (hr != 0 || dx == 0) { return false; }
      dpi = dx;
      return true;
    } catch { return false; }
  }
}
'@
}

# 必须在读取任何屏幕尺寸之前完成：否则 200% 缩放下只能拿到逻辑像素。
$script:DpiAware = $false
try { $script:DpiAware = [CaptureNative]::MakePerMonitorAware() } catch { $script:DpiAware = $false }
Start-Sleep -Milliseconds 60

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

# ---------------------------------------------------------------------------
# 显示器
# ---------------------------------------------------------------------------

function Get-ShortHash {
  param([string]$text)
  # 32 位 FNV-1a 正反各算一次 → 12 位十六进制；不透明但跨重启稳定。
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
  $h1 = [uint64]2166136261
  $h2 = [uint64]2166136261
  foreach ($b in $bytes) {
    $h1 = ((([uint64]$h1 -bxor [uint64]$b) * [uint64]16777619) -band [uint64]4294967295)
  }
  for ($i = $bytes.Length - 1; $i -ge 0; $i--) {
    $h2 = ((([uint64]$h2 -bxor [uint64]$bytes[$i]) * [uint64]16777619) -band [uint64]4294967295)
  }
  return ('{0:x8}{1:x4}' -f $h1, ([uint64]$h2 -band [uint64]65535))
}

function New-DisplayRecord {
  param($screen)
  $b = $screen.Bounds
  $device = [string]$screen.DeviceName
  $id = Get-ShortHash ($device + '|' + $b.X + ',' + $b.Y + ',' + $b.Width + ',' + $b.Height)
  $scale = $null
  $dpi = [uint32]0
  $cx = $b.X + [int]($b.Width / 2)
  $cy = $b.Y + [int]($b.Height / 2)
  if ([CaptureNative]::TryGetMonitorDpi($cx, $cy, [ref]$dpi)) {
    $scale = [Math]::Round(([double]$dpi / 96.0), 3)
  }
  return @{
    id      = $id
    device  = $device
    primary = [bool]$screen.Primary
    bounds  = @{ x = [int]$b.X; y = [int]$b.Y; width = [int]$b.Width; height = [int]$b.Height }
    scale   = $scale
  }
}

function Get-AllDisplays {
  $list = New-Object System.Collections.ArrayList
  foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    [void]$list.Add((New-DisplayRecord $s))
  }
  return , ([object[]]$list.ToArray())
}

function Find-DisplayByRecordId {
  param([string]$id)
  foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    $rec = New-DisplayRecord $s
    if ([string]$rec.id -eq $id) { return @{ screen = $s; record = $rec } }
  }
  return $null
}

function Get-WindowHandleFromText {
  param([string]$text)
  $t = ([string]$text).Trim()
  if (-not $t) { return [IntPtr]::Zero }
  if ($t -match '^0x([0-9a-fA-F]{1,16})$') {
    try { return [IntPtr]([int64][System.Convert]::ToInt64($Matches[1], 16)) } catch { return [IntPtr]::Zero }
  }
  if ($t -match '^[0-9]{1,19}$') {
    try { return [IntPtr]([int64]$t) } catch { return [IntPtr]::Zero }
  }
  return [IntPtr]::Zero
}

function Get-DisplayForWindow {
  param([IntPtr]$handle)
  $x = 0; $y = 0; $w = 0; $h = 0
  if ($handle -eq [IntPtr]::Zero) { return $null }
  if (-not ([CaptureNative]::TryGetWindowRect($handle, [ref]$x, [ref]$y, [ref]$w, [ref]$h))) { return $null }
  if ($w -le 0 -or $h -le 0) { return $null }
  $pt = New-Object System.Drawing.Point ($x + [int]($w / 2)), ($y + [int]($h / 2))
  $screen = [System.Windows.Forms.Screen]::FromPoint($pt)
  if ($null -eq $screen) { return $null }
  return @{ screen = $screen; record = (New-DisplayRecord $screen) }
}

function Get-ActiveDisplay {
  $handle = [CaptureNative]::GetForegroundWindow()
  $found = Get-DisplayForWindow $handle
  if ($null -ne $found) { return @{ screen = $found.screen; record = $found.record; active = $true } }
  $primary = [System.Windows.Forms.Screen]::PrimaryScreen
  if ($null -ne $primary) {
    Add-Warning 'active_display_unavailable'
    return @{ screen = $primary; record = (New-DisplayRecord $primary); active = $false }
  }
  return $null
}

# ---------------------------------------------------------------------------
# 采集
# ---------------------------------------------------------------------------

function New-ScreenBitmap {
  param([int]$srcX, [int]$srcY, [int]$width, [int]$height)
  $bmp = New-Object System.Drawing.Bitmap $width, $height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $size = New-Object System.Drawing.Size $width, $height
    $g.CopyFromScreen($srcX, $srcY, 0, 0, $size, [System.Drawing.CopyPixelOperation]::SourceCopy)
  } finally {
    $g.Dispose()
  }
  return $bmp
}

function New-WindowBitmap {
  # 首选 PrintWindow(PW_RENDERFULLCONTENT)：不抢焦点、被遮挡也能拿到内容。
  param([IntPtr]$handle, [int]$width, [int]$height)
  $bmp = New-Object System.Drawing.Bitmap $width, $height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $printed = $false
  $hdc = [IntPtr]::Zero
  try {
    $hdc = $g.GetHdc()
    $printed = [CaptureNative]::PrintWindow($handle, $hdc, 2)
  } catch {
    $printed = $false
  } finally {
    try { if ($hdc -ne [IntPtr]::Zero) { $g.ReleaseHdc($hdc) } } catch { }
    $g.Dispose()
  }
  if ($printed) { return $bmp }
  $bmp.Dispose()
  return $null
}

function Test-UniformContent {
  # 粗采样判断“整张图是不是同一颜色”，用于发现黑图/未渲染的假成功。
  param($bitmap)
  if ($bitmap.Width -lt 2 -or $bitmap.Height -lt 2) { return $true }
  $stepX = [Math]::Max(1, [int]($bitmap.Width / 24))
  $stepY = [Math]::Max(1, [int]($bitmap.Height / 24))
  $first = $null
  for ($py = 0; $py -lt $bitmap.Height; $py += $stepY) {
    for ($px = 0; $px -lt $bitmap.Width; $px += $stepX) {
      $c = $bitmap.GetPixel($px, $py).ToArgb()
      if ($null -eq $first) { $first = $c }
      elseif ($c -ne $first) { return $false }
    }
  }
  return $true
}

function Resize-BitmapToWidth {
  param($bitmap, [int]$targetWidth)
  if ($targetWidth -le 0 -or $targetWidth -ge $bitmap.Width) { return $bitmap }
  $nh = [int][Math]::Max(1, [Math]::Round(([double]$bitmap.Height * $targetWidth) / [double]$bitmap.Width))
  $scaled = New-Object System.Drawing.Bitmap $targetWidth, $nh, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($scaled)
  try {
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.DrawImage($bitmap, 0, 0, $targetWidth, $nh)
  } finally {
    $g.Dispose()
  }
  $bitmap.Dispose()
  return $scaled
}

function Save-PngBitmap {
  param($bitmap, [string]$path)
  $dir = Split-Path -Parent $path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
}

function Get-SessionType {
  $raw = [string][Environment]::GetEnvironmentVariable('SESSIONNAME')
  if (-not $raw) { return 'unknown' }
  if ($raw -match '(?i)^rdp') { return 'rdp' }
  if ($raw -match '(?i)^console$') { return 'console' }
  return $raw.ToLowerInvariant()
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

try {
  $displays = Get-AllDisplays

  if ($Mode -eq 'probe') {
    if ($displays.Count -eq 0) {
      Emit-Failure 'no_display' 'no display attached to this Windows session' $false 'unexpected: headless/service session'
    }
    $foreground = $null
    $fgHandle = [CaptureNative]::GetForegroundWindow()
    if ($fgHandle -ne [IntPtr]::Zero) {
      $fgDisplay = Get-DisplayForWindow $fgHandle
      $fgId = $null
      if ($null -ne $fgDisplay) { $fgId = [string]$fgDisplay.record.id }
      $foreground = @{ hwnd = ([string]([int64]$fgHandle)); displayId = $fgId }
    }
    $payload = @{
      ok           = $true
      code         = $null
      message      = ''
      retryable    = $false
      hint         = ''
      path         = $null
      width        = 0
      height       = 0
      nativeWidth  = 0
      nativeHeight = 0
      display      = $null
      warnings     = (Get-WarningArray)
      platform     = 'win32'
      sessionType  = (Get-SessionType)
      dpiAware     = [bool]$script:DpiAware
      headless     = $false
      systemDpi    = [int]([CaptureNative]::GetDpiForSystem())
      displays     = $displays
      foreground   = $foreground
      capabilities = @{ display = $true; window = $true; region = $true; all = $false }
    }
    Emit-Json $payload
    exit 0
  }

  # ---- 以下模式都会写文件，必须先拿到 Out ----
  if (-not $Out) {
    Emit-Failure 'invalid_argument' 'capture mode requires -Out (temporary file path)'
  }
  if ($MaxWidth -lt 0) {
    Emit-Failure 'invalid_argument' '-MaxWidth must not be negative'
  }
  if ($displays.Count -eq 0) {
    Emit-Failure 'no_display' 'no display attached to this Windows session' $false 'unexpected: headless/service session'
  }

  $selected = $null
  $bitmap = $null
  $fallbackCopy = $false

  if ($Mode -eq 'window') {
    # §16.8：显式给了 window id 就绝不再回退前台窗口；只有缺省时才抓前台窗口。
    $handle = [IntPtr]::Zero
    if ($Window) {
      $handle = Get-WindowHandleFromText $Window
      if ($handle -eq [IntPtr]::Zero) {
        Emit-Failure 'window_not_found' 'the window id could not be parsed as a window handle' $true 'pass a decimal or 0x-prefixed handle, or omit window to capture the foreground window' @{ reason = 'window_id_invalid'; window = $Window }
      }
    } else {
      $handle = [CaptureNative]::GetForegroundWindow()
    }
    if ($handle -eq [IntPtr]::Zero) {
      Emit-Failure 'window_not_found' 'no foreground window to capture; pass an explicit window id' $true 'pass a window handle (decimal or 0x hex)' @{ reason = 'no_foreground_window' }
    }
    if (-not ([CaptureNative]::IsWindow($handle))) {
      Emit-Failure 'window_not_found' 'the given window handle does not exist' $false 'capture the foreground window or pass a live handle' @{ reason = 'window_missing'; window = $Window }
    }
    if ([CaptureNative]::IsIconic($handle)) {
      Emit-Failure 'window_not_found' 'window is minimized; not falling back to full screen' $true 'restore the window first' @{ reason = 'window_minimized'; window = $Window }
    }
    if (-not ([CaptureNative]::IsWindowVisible($handle))) {
      Emit-Failure 'window_not_found' 'window is not visible' $false 'restore/show the window first' @{ reason = 'window_invisible'; window = $Window }
    }
    $wx = 0; $wy = 0; $ww = 0; $wh = 0
    if (-not ([CaptureNative]::TryGetWindowRect($handle, [ref]$wx, [ref]$wy, [ref]$ww, [ref]$wh))) {
      Emit-Failure 'window_not_found' 'window rectangle is unavailable (destroyed?)' $false 'capture the foreground window instead' @{ reason = 'window_rect_unavailable'; window = $Window }
    }
    if ($ww -le 0 -or $wh -le 0) {
      Emit-Failure 'window_not_found' 'window rectangle is empty' $false 'restore the window first' @{ reason = 'window_rect_empty'; window = $Window }
    }

    $found = Get-DisplayForWindow $handle
    if ($null -ne $found) {
      $selected = $found
    } else {
      $primary = [System.Windows.Forms.Screen]::PrimaryScreen
      Add-Warning 'active_display_unavailable'
      $selected = @{ screen = $primary; record = (New-DisplayRecord $primary) }
    }

    $bitmap = New-WindowBitmap $handle $ww $wh
    if ($null -eq $bitmap) {
      # PrintWindow 对少数 GPU 合成窗口返回 0：退到“置前 + 屏幕拷贝”，并明确告知改动了前台。
      $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
      $left = [Math]::Max($wx, $vs.Left)
      $top = [Math]::Max($wy, $vs.Top)
      $right = [Math]::Min($wx + $ww, $vs.Right)
      $bottom = [Math]::Min($wy + $wh, $vs.Bottom)
      if (($right - $left) -le 0 -or ($bottom - $top) -le 0) {
        Emit-Failure 'window_not_found' 'window is completely outside the visible desktop'
      }
      # 窗口激活是副作用，不是质量信号：不产出 warning（§16.11）；激活失败也不阻断取图。
      if ([CaptureNative]::SetForegroundWindow($handle)) {
        Start-Sleep -Milliseconds 250
      }
      $fallbackCopy = $true
      $bitmap = New-ScreenBitmap $left $top ($right - $left) ($bottom - $top)
    }
  }
  elseif ($Mode -eq 'region') {
    if ($W -le 0 -or $H -le 0) {
      Emit-Failure 'invalid_argument' 'region needs positive -W and -H in physical pixels' $false 'use width >= 1 and height >= 1' @{ reason = 'region_non_positive_size'; region = @{ x = $X; y = $Y; width = $W; height = $H } }
    }
    if ($X -lt 0 -or $Y -lt 0) {
      Emit-Failure 'invalid_region' 'region x/y must not be negative (origin is the display top-left)' $false 'use x >= 0 and y >= 0' @{ reason = 'region_negative_origin'; region = @{ x = $X; y = $Y; width = $W; height = $H } }
    }
    if ($DisplayId) {
      $selected = Find-DisplayByRecordId $DisplayId
      if ($null -eq $selected) {
        Emit-Failure 'invalid_argument' 'display id does not match any current display' $false 'call capture_probe to get the current display ids' @{ reason = 'display_unknown'; display = $DisplayId }
      }
    } else {
      $selected = Get-ActiveDisplay
      if ($null -eq $selected) { Emit-Failure 'no_display' 'no display available' }
    }
    $b = $selected.record.bounds
    $absLeft = [int]$b.x + $X
    $absTop = [int]$b.y + $Y
    $crossed = $false
    foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
      $sb = $s.Bounds
      if (([string]$s.DeviceName) -eq ([string]$selected.record.device)) { continue }
      if (([int]$sb.Width) -le 0 -or ([int]$sb.Height) -le 0) { continue }
      if ($absLeft -lt ($sb.X + $sb.Width) -and ($absLeft + $W) -gt $sb.X -and $absTop -lt ($sb.Y + $sb.Height) -and ($absTop + $H) -gt $sb.Y) {
        $crossed = $true
      }
    }
    if ($crossed) {
      Emit-Failure 'invalid_region' 'region spans more than one display; capture one display at a time' $false 'use a region fully inside the selected display' @{
        reason = 'region_crosses_displays'; region = @{ x = $X; y = $Y; width = $W; height = $H }; display = $selected.record.id; bounds = $b
      }
    }
    if (($X + $W) -gt [int]$b.width -or ($Y + $H) -gt [int]$b.height) {
      Emit-Failure 'invalid_region' 'region exceeds the selected display bounds (cross-display is not supported)' $false 'capture each display separately' @{
        reason = 'region_out_of_bounds'; region = @{ x = $X; y = $Y; width = $W; height = $H }; display = $selected.record.id; bounds = $b
      }
    }
    $bitmap = New-ScreenBitmap $absLeft $absTop $W $H
  }
  else {
    # display
    if ($DisplayId) {
      $selected = Find-DisplayByRecordId $DisplayId
      if ($null -eq $selected) {
        Emit-Failure 'invalid_argument' 'display id does not match any current display' $false 'call capture_probe to get the current display ids' @{ reason = 'display_unknown'; display = $DisplayId }
      }
    } else {
      $selected = Get-ActiveDisplay
      if ($null -eq $selected) { Emit-Failure 'no_display' 'no display available' }
    }
    $b = $selected.record.bounds
    if ([int]$b.width -le 0 -or [int]$b.height -le 0) {
      Emit-Failure 'no_display' 'selected display has an invalid size'
    }
    $bitmap = New-ScreenBitmap ([int]$b.x) ([int]$b.y) ([int]$b.width) ([int]$b.height)
  }

  if ($null -eq $bitmap) {
    Emit-Failure 'capture_failed' 'capture produced no bitmap' $true
  }

  $nativeWidth = [int]$bitmap.Width
  $nativeHeight = [int]$bitmap.Height
  if ($nativeWidth -le 0 -or $nativeHeight -le 0) {
    $bitmap.Dispose()
    Emit-Failure 'capture_failed' 'captured bitmap has zero size'
  }

  $uniform = Test-UniformContent $bitmap
  if ($uniform) { Add-Warning 'content_uniform' }

  $bitmap = Resize-BitmapToWidth $bitmap $MaxWidth
  $width = [int]$bitmap.Width
  $height = [int]$bitmap.Height

  try {
    Save-PngBitmap $bitmap $Out
  } catch {
    $bitmap.Dispose()
    Emit-Failure 'capture_failed' ('failed to save PNG: ' + $_.Exception.Message) $true
  }
  $bitmap.Dispose()

  if (-not (Test-Path -LiteralPath $Out)) {
    Emit-Failure 'invalid_output' 'output file missing after save'
  }
  $length = (Get-Item -LiteralPath $Out).Length
  if ($length -le 0) {
    Emit-Failure 'invalid_output' 'output file is empty after save'
  }

  $displayPayload = $null
  if ($null -ne $selected) { $displayPayload = $selected.record }

  $copyMode = 'native'
  if ($fallbackCopy) { $copyMode = 'screen-copy' }

  $payload = @{
    ok           = $true
    code         = $null
    message      = ''
    retryable    = $false
    hint         = ''
    path         = $Out
    width        = $width
    height       = $height
    nativeWidth  = $nativeWidth
    nativeHeight = $nativeHeight
    display      = $displayPayload
    warnings     = (Get-WarningArray)
    target       = $Mode
    backend      = 'gdi+'
    bytes        = [int64]$length
    copyMode     = $copyMode
  }
  Emit-Json $payload
  exit 0
}
catch {
  $msg = $_.Exception.Message
  if (-not $msg) { $msg = 'unknown native failure' }
  Emit-Failure 'capture_failed' ('native helper exception: ' + $msg) $false
}
