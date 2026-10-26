<#
  shot.ps1 - probe / capture. Windows, high-DPI safe.

  Mode:
    probe   report screen size, DPI, ffmpeg, browser, ddagrab availability (KEY=VALUE lines)
    full    whole virtual desktop at PHYSICAL pixels
    window  a window (title regex); brings it forward unless -NoFocus
    region  X/Y/W/H in PHYSICAL pixels

  The capture path always declares per-monitor DPI awareness itself, so it does not matter
  which shell launches it (git-bash -> powershell.exe is the usual failure case).

  Usage:
    powershell -File shot.ps1 -Mode probe
    powershell -File shot.ps1 -Out shots\full.png
    powershell -File shot.ps1 -Mode window -Title "Notepad" -Out shots\win.png
    powershell -File shot.ps1 -Mode window -Title "Notepad" -Client -Out shots\client.png
    powershell -File shot.ps1 -Mode region -X 600 -Y 200 -W 1600 -H 900 -Out shots\crop.png
    powershell -File shot.ps1 -Scale 0.5 -Out shots\half.png
#>
[CmdletBinding()]
param(
  [ValidateSet('full','window','region','probe')] [string]$Mode = 'full',
  [string]$Title = '',
  [string]$Out = '',
  [int]$X = 0, [int]$Y = 0, [int]$W = 0, [int]$H = 0,
  [double]$Scale = 0,
  [switch]$Client,
  [switch]$NoFocus,
  [switch]$SkipDda
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms

if (-not ("NativeCapture" -as [type])) {
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class NativeCapture {
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
  [DllImport("user32.dll")] public static extern int GetDpiForSystem();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public static bool MakeDpiAware() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero) return true; } catch {}
    try { if (SetProcessDpiAwareness(2) == 0) return true; } catch {}
    try { return SetProcessDPIAware(); } catch {}
    return false;
  }
}
"@
}
$aware = [NativeCapture]::MakeDpiAware()
Start-Sleep -Milliseconds 80

$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen

if ($Mode -eq 'probe') {
  $dpi = [NativeCapture]::GetDpiForSystem()
  Write-Output "OS=windows"
  Write-Output "DPI_AWARE=$aware"
  Write-Output "SYSTEM_DPI=$dpi"
  Write-Output "SCALE_PERCENT=$([int][Math]::Round(100.0 * $dpi / 96))"
  Write-Output "SCREEN_PHYSICAL=$($vs.Width)x$($vs.Height)"
  Write-Output "SCREEN_LOGICAL=$([int][Math]::Round($vs.Width * 96.0 / $dpi))x$([int][Math]::Round($vs.Height * 96.0 / $dpi))"
  foreach ($sc in [System.Windows.Forms.Screen]::AllScreens) {
    Write-Output ("MONITOR=" + $sc.DeviceName + " " + $sc.Bounds.Width + "x" + $sc.Bounds.Height + " primary=" + $sc.Primary)
  }
  $ff = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if ($ff) {
    Write-Output "FFMPEG=$($ff.Source)"
    $ver = (& ffmpeg -hide_banner -version 2>$null | Select-Object -First 1)
    Write-Output ("FFMPEG_VERSION=" + ($ver -replace '^ffmpeg version ', ''))
  } else {
    Write-Output "FFMPEG="
  }
  if ($ff) { Write-Output "VIDEO_BACKEND=ffmpeg" } else {
    Write-Output "VIDEO_BACKEND=none"
    Write-Output "NOTE=no ffmpeg: screenshots and page capture still work; screen recording needs ffmpeg"
  }
  $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  $cands = New-Object System.Collections.ArrayList
  [void]$cands.Add((Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'))
  if ($pf86) { [void]$cands.Add((Join-Path $pf86 'Google\Chrome\Application\chrome.exe')) }
  [void]$cands.Add((Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'))
  [void]$cands.Add((Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'))
  if ($pf86) { [void]$cands.Add((Join-Path $pf86 'Microsoft\Edge\Application\msedge.exe')) }
  $browser = $cands | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  Write-Output ("BROWSER=" + $(if ($browser) { $browser } else { '' }))
  if (-not $SkipDda -and $ff) {
    $tmp = Join-Path $env:TEMP ("dda-probe-" + [guid]::NewGuid().ToString('N') + ".mp4")
    & ffmpeg -hide_banner -loglevel error -f lavfi -i "ddagrab=0:framerate=30:draw_mouse=0" -vf "hwdownload,format=bgra" -frames:v 2 -c:v libx264 -preset ultrafast -pix_fmt yuv420p $tmp -y 2>$null
    $ok = (Test-Path $tmp) -and ((Get-Item $tmp).Length -gt 0)
    if (Test-Path $tmp) { Remove-Item $tmp -Force }
    Write-Output "DDAGRAB=$ok"
  } else {
    Write-Output "DDAGRAB=unknown"
  }
  return
}

$srcRect = New-Object System.Drawing.Rectangle $vs.X, $vs.Y, $vs.Width, $vs.Height
$target = $null

if ($Mode -eq 'window') {
  if (-not $Title) { throw "-Mode window needs -Title" }
  $proc = Get-Process | Where-Object {
      $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -and ($_.MainWindowTitle -match $Title)
  } | Select-Object -First 1
  if (-not $proc) { throw "no window title matches '$Title'" }
  $h = $proc.MainWindowHandle
  if (-not $NoFocus) {
    if ([NativeCapture]::IsIconic($h)) { [void][NativeCapture]::ShowWindow($h, 9) }
    [void][NativeCapture]::ShowWindow($h, 5)
    [void][NativeCapture]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 400
  }
  if ($Client) {
    $cr = New-Object NativeCapture+RECT
    [void][NativeCapture]::GetClientRect($h, [ref]$cr)
    $pt = New-Object NativeCapture+POINT
    [void][NativeCapture]::ClientToScreen($h, [ref]$pt)
    $target = New-Object System.Drawing.Rectangle $pt.X, $pt.Y, ($cr.Right - $cr.Left), ($cr.Bottom - $cr.Top)
  } else {
    $wr = New-Object NativeCapture+RECT
    [void][NativeCapture]::GetWindowRect($h, [ref]$wr)
    $target = New-Object System.Drawing.Rectangle $wr.Left, $wr.Top, ($wr.Right - $wr.Left), ($wr.Bottom - $wr.Top)
  }
}
elseif ($Mode -eq 'region') {
  if ($W -le 0 -or $H -le 0) { throw "-Mode region needs -W and -H (physical px)" }
  $target = New-Object System.Drawing.Rectangle $X, $Y, $W, $H
}

$full = New-Object System.Drawing.Bitmap $srcRect.Width, $srcRect.Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($full)
$g.CopyFromScreen($srcRect.X, $srcRect.Y, 0, 0, $full.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
$g.Dispose()

if ($target) {
  $rel = New-Object System.Drawing.Rectangle ($target.X - $srcRect.X), ($target.Y - $srcRect.Y), $target.Width, $target.Height
  $rel.Intersect((New-Object System.Drawing.Rectangle 0, 0, $full.Width, $full.Height))
  $img = $full.Clone($rel, $full.PixelFormat)
  $full.Dispose()
} else { $img = $full }

if ($Scale -gt 0 -and $Scale -ne 1) {
  $nw = [int][Math]::Max(1, [Math]::Round($img.Width * $Scale))
  $nh = [int][Math]::Max(1, [Math]::Round($img.Height * $Scale))
  $sc = New-Object System.Drawing.Bitmap $nw, $nh, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g2 = [System.Drawing.Graphics]::FromImage($sc)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g2.DrawImage($img, 0, 0, $nw, $nh)
  $g2.Dispose(); $img.Dispose(); $img = $sc
}

if (-not $Out) {
  $dir = Join-Path $env:TEMP 'dsh-shots'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $Out = Join-Path $dir ("shot-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".png")
}
$outDir = Split-Path -Parent $Out
if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
$img.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$info = "dpiAware=$aware screen=$($vs.Width)x$($vs.Height) mode=$Mode output=$($img.Width)x$($img.Height) path=$Out"
$img.Dispose()
Write-Output $info
