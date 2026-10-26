<#
  rec.ps1 - 原生分辨率录屏 / native-resolution screen recording (Windows)

  两个关键点：
  1) 分辨率：始终按"物理像素"录制（以 probe 的 SCREEN_PHYSICAL 为准，例如 3072x1920），需要 1080p 时用 Lanczos
     一次到位地缩到 1920x1080，而不是录 1080p 再放大。
  2) 帧率：gdigrab 在 3K 分辨率上实测只有 ~19fps（CPU BitBlt），画面一定发顿；
     ddagrab（Desktop Duplication，GPU 导出）在同一台机器上实测 ~57fps。
     所以默认优先 ddagrab，失败自动回退 gdigrab。

  用法 / usage:
    powershell -File rec.ps1 -Out a.mp4 -Seconds 20
    ... -Region 0,0,1920,1080        # 区域（物理像素）
    ... -To1080p                     # 直接输出 1920x1080（Lanczos）
    ... -Fps 60 -Crf 14
    ... -Backend dda|gdi|auto
#>
[CmdletBinding()]
param(
  [string]$Out = '',
  [int]$Seconds = 0,
  [int]$Fps = 60,
  [int]$Crf = 14,
  [string]$Preset = 'veryfast',
  [string]$Region = '',
  [switch]$To1080p,
  [switch]$DrawMouse,
  [ValidateSet('auto','dda','gdi')] [string]$Backend = 'auto',
  [string]$Ffmpeg = 'ffmpeg'
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command $Ffmpeg -ErrorAction SilentlyContinue)) {
  throw "ffmpeg not found (looked for '$Ffmpeg'). Screen recording needs it: winget install Gyan.FFmpeg  /  brew install ffmpeg  /  apt install ffmpeg. Screenshots still work without it."
}

if (-not ("NativeRec" -as [type])) {
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class NativeRec {
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
  public static bool MakeDpiAware() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero) return true; } catch {}
    try { if (SetProcessDpiAwareness(2) == 0) return true; } catch {}
    try { return SetProcessDPIAware(); } catch {}
    return false;
  }
}
"@
}
[void][NativeRec]::MakeDpiAware()
Add-Type -AssemblyName System.Windows.Forms
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$srcSize = "$($vs.Width)x$($vs.Height)"
$offset = '0,0'

if ($Region) {
  $p = $Region.Split(',')
  if ($p.Count -ne 4) { throw "-Region must be x,y,w,h in physical px" }
  $offset = "$($p[0]),$($p[1])"
  $srcSize = "$($p[2])x$($p[3])"
}

if (-not $Out) {
  $dir = Join-Path $env:TEMP 'dsh-recs'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $Out = Join-Path $dir ("rec-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".mp4")
}
$outDir = Split-Path -Parent $Out
if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }

$mouse = if ($DrawMouse) { '1' } else { '0' }

function Build-Dda {
  $bag = "ddagrab=0:framerate=" + $Fps + ":draw_mouse=" + $mouse
  $vf = @('hwdownload','format=bgra')
  if ($Region) {
    $pp = $Region.Split(',')
    $vf += ("crop=" + $pp[2] + ":" + $pp[3] + ":" + $pp[0] + ":" + $pp[1])
  }
  if ($To1080p) { $vf += 'scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos' }
  $a = @('-hide_banner','-y','-loglevel','warning',
         '-f','lavfi','-i',$bag,'-vf',($vf -join ','),
         '-c:v','libx264','-preset',$Preset,'-crf',"$Crf",'-pix_fmt','yuv420p','-movflags','+faststart')
  if ($Seconds -gt 0) { $a += @('-t',"$Seconds") }
  return $a + $Out
}

function Build-Gdi {
  $a = @('-hide_banner','-y','-loglevel','warning',
         '-f','gdigrab','-framerate',"$Fps",
         '-offset_x',($offset.Split(',')[0]),'-offset_y',($offset.Split(',')[1]),
         '-video_size',$srcSize,'-draw_mouse',$mouse,'-i','desktop',
         '-c:v','libx264','-preset',$Preset,'-crf',"$Crf",'-pix_fmt','yuv420p','-movflags','+faststart')
  if ($To1080p) { $a += @('-vf','scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos','-sws_flags','lanczos') }
  if ($Seconds -gt 0) { $a += @('-t',"$Seconds") }
  return $a + $Out
}

$used = $null
if ($Backend -ne 'gdi') {
  Write-Output ("backend=ddagrab screen=" + $srcSize + " fps=" + $Fps + " crf=" + $Crf + " out=" + $Out)
  & $Ffmpeg @(Build-Dda)
  if ($LASTEXITCODE -eq 0 -and (Test-Path $Out)) { $used = 'ddagrab' }
  else {
    Write-Output 'ddagrab unavailable, falling back to gdigrab (expect ~20fps at 3K)'
    if (Test-Path $Out) { Remove-Item $Out -Force }
  }
}
if (-not $used) {
  if ($Backend -eq 'dda') { throw 'ddagrab failed and -Backend dda was forced' }
  Write-Output ("backend=gdigrab screen=" + $srcSize + " fps=" + $Fps + " crf=" + $Crf + " out=" + $Out)
  & $Ffmpeg @(Build-Gdi)
  if ($LASTEXITCODE -ne 0) { throw 'ffmpeg gdigrab failed' }
  $used = 'gdigrab'
}

$probe = & ffprobe -v error -select_streams v:0 -show_entries 'stream=width,height,avg_frame_rate,nb_frames' -of 'default=nw=1' $Out 2>$null
Write-Output ("done backend=" + $used + " " + [math]::Round((Get-Item $Out).Length / 1MB, 2) + " MB")
Write-Output (($probe -join ' '))
