#!/usr/bin/env bash
# capture.sh - probe / shot / rec for macOS and Linux.
# Windows uses shot.ps1 / rec.ps1 instead (see SKILL.md).
#
#   ./capture.sh probe
#   ./capture.sh shot --out f.png [--region x,y,w,h] [--scale 0.5] [--display N]
#   ./capture.sh rec  --out f.mp4 [--seconds 20] [--fps 60] [--crf 14] [--region x,y,w,h] [--to1080p] [--index 1]
set -euo pipefail

die() { echo "capture.sh: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
need() { have "$1" || die "missing '$1'. $2"; }

arg() { # arg <name> <default> <args...>
  local want="--$1" def="$2"
  shift 2
  while [ $# -gt 0 ]; do
    if [ "$1" = "$want" ]; then
      shift
      if [ $# -gt 0 ]; then echo "$1"; else echo "true"; fi
      return 0
    fi
    shift
  done
  echo "$def"
}

has_flag() { # has_flag <flag-without-dashes> <args...>
  local want="--$1"
  shift
  while [ $# -gt 0 ]; do
    [ "$1" = "$want" ] && return 0
    shift
  done
  return 1
}

os() { uname -s; }
is_macos() { [ "$(os)" = "Darwin" ]; }
is_linux() { [ "$(os)" = "Linux" ]; }

ffprobe_dims() {
  if have ffprobe; then
    ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x "$1" 2>/dev/null || echo unknown
  elif have file; then
    file -b "$1" | sed -n "s/.*, \([0-9][0-9]*\) x \([0-9][0-9]*\),.*/\1x\2/p"
  else
    echo unknown
  fi
}

crop_filter() {
  local r="$1"
  local x y w h
  x=$(echo "$r" | cut -d, -f1); y=$(echo "$r" | cut -d, -f2)
  w=$(echo "$r" | cut -d, -f3); h=$(echo "$r" | cut -d, -f4)
  echo "crop=$w:$h:$x:$y"
}

cmd_probe() {
  echo "OS=$(os)"
  echo "ARCH=$(uname -m)"
  if have ffmpeg; then echo "VIDEO_BACKEND=ffmpeg"; else echo "VIDEO_BACKEND=none"; fi
  if is_macos; then
    echo "PLATFORM=macos"
    echo "MACOS_VERSION=$(sw_vers -productVersion 2>/dev/null || echo unknown)"
    have screencapture && echo "SCREENCAPTURE=yes" || echo "SCREENCAPTURE=no"
    have sips && echo "SIPS=yes" || echo "SIPS=no"
    have ffmpeg && echo "FFMPEG=yes" || echo "FFMPEG=no"
    if have ffmpeg; then
      ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1 \
        | grep -i "capture screen" | sed 's/^[[:space:]]*/SCREEN_DEVICE=/' || true
      echo "NOTE=screen recording needs Screen Recording permission for the terminal app"
    fi
  elif is_linux; then
    echo "PLATFORM=linux"
    echo "SESSION_TYPE=${XDG_SESSION_TYPE:-unknown}"
    echo "DISPLAY=${DISPLAY:-}"
    echo "WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-}"
    for t in grim gnome-screenshot spectacle scrot import ffmpeg xrandr; do
      if have "$t"; then echo "TOOL_$t=yes"; else echo "TOOL_$t=no"; fi
    done
    have ffmpeg && echo "FFMPEG_VERSION=$(ffmpeg -hide_banner -version 2>/dev/null | head -1)"
  else
    echo "PLATFORM=unsupported"
    echo "NOTE=this script covers macOS and Linux; on Windows use shot.ps1 / rec.ps1"
    return 1
  fi
}

cmd_shot() {
  local out scale region display
  out=$(arg out "" "$@")
  scale=$(arg scale "0" "$@")
  region=$(arg region "" "$@")
  display=$(arg display "1" "$@")
  [ -n "$out" ] || die "shot needs --out file.png"
  mkdir -p "$(dirname "$out")"

  if is_macos; then
    need screencapture "it ships with macOS"
    if [ -n "$region" ]; then
      local rx ry rw rh
      IFS=, read -r rx ry rw rh <<< "$region"
      screencapture -x -R "$rx,$ry,$rw,$rh" "$out"
    else
      screencapture -x -D "$display" "$out"
    fi
  elif is_linux; then
    if [ "${XDG_SESSION_TYPE:-}" = "wayland" ] && have grim; then
      if [ -n "$region" ]; then
        local rx ry rw rh
        IFS=, read -r rx ry rw rh <<< "$region"
        grim -g "$rx,$ry $rwx$rh" "$out"
      else
        grim "$out"
      fi
    elif have gnome-screenshot; then
      gnome-screenshot -f "$out"
    elif have import; then
      import -window root "$out"
    elif have ffmpeg; then
      local size
      size=$(xrandr 2>/dev/null | awk '/\*/ {print $1; exit}')
      [ -n "$size" ] || die "cannot detect screen size; install grim / gnome-screenshot / imagemagick"
      ffmpeg -hide_banner -loglevel error -f x11grab -video_size "$size" -i "${DISPLAY:-:0.0}" -frames:v 1 "$out" -y
    else
      die "no screenshot tool found. Install grim (wayland), gnome-screenshot, imagemagick or ffmpeg"
    fi
  else
    die "unsupported platform $(os); on Windows use shot.ps1"
  fi

  if [ "$scale" != "0" ] && [ "$scale" != "1" ]; then
    if is_macos && have sips; then
      local wpx tw
      wpx=$(sips -g pixelWidth "$out" | awk '/pixelWidth/ {print $2}')
      tw=$(awk -v w="$wpx" -v s="$scale" 'BEGIN {printf "%d", w*s}')
      sips --resampleWidth "$tw" "$out" >/dev/null
    elif have magick; then
      local pct
      pct=$(awk -v s="$scale" 'BEGIN {printf "%d", s*100}')
      magick "$out" -filter Lanczos -resize "$pct%" "$out"
    elif have ffmpeg; then
      local wpx hpx tw th tmp
      wpx=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$out")
      hpx=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$out")
      tw=$(awk -v w="$wpx" -v s="$scale" 'BEGIN {printf "%d", w*s}')
      th=$(awk -v h="$hpx" -v s="$scale" 'BEGIN {printf "%d", h*s}')
      tmp="$out.scaled.png"
      ffmpeg -hide_banner -loglevel error -i "$out" -vf "scale=$tw:$th:flags=lanczos" "$tmp" -y
      mv "$tmp" "$out"
    else
      die "--scale needs sips (macOS) or imagemagick / ffmpeg"
    fi
  fi

  echo "shot platform=$(if is_macos; then echo macos; else echo linux; fi) output=$(ffprobe_dims "$out") path=$out"
}

cmd_rec() {
  local out seconds fps crf region to1080 index display vf=""
  out=$(arg out "" "$@")
  seconds=$(arg seconds "0" "$@")
  fps=$(arg fps "60" "$@")
  crf=$(arg crf "14" "$@")
  region=$(arg region "" "$@")
  index=$(arg index "1" "$@")
  display=$(arg display "${DISPLAY:-:0.0}" "$@")
  to1080=$(arg to1080p "" "$@")
  [ -n "$out" ] || die "rec needs --out file.mp4"
  need ffmpeg "brew install ffmpeg  /  apt install ffmpeg"
  mkdir -p "$(dirname "$out")"

  [ -n "$region" ] && vf=$(crop_filter "$region")
  if [ "$to1080" = "true" ] || has_flag to1080p "$@"; then
    if [ -n "$vf" ]; then vf="$vf,scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos";
    else vf="scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos"; fi
  fi

  local enc=(-c:v libx264 -preset veryfast -crf "$crf" -pix_fmt yuv420p -movflags +faststart)
  local dur=()
  [ "$seconds" != "0" ] && dur=(-t "$seconds")
  local vfa=()
  [ -n "$vf" ] && vfa=(-vf "$vf")

  if is_macos; then
    echo "rec platform=macos device=avfoundation:$index:none fps=$fps out=$out"
    echo "NOTE=first run may prompt for Screen Recording permission"
    ffmpeg -hide_banner -y -loglevel warning -f avfoundation -framerate "$fps" -capture_cursor 1 \
      -i "$index:none" "${dur[@]}" "${vfa[@]}" "${enc[@]}" "$out"
  elif is_linux; then
    local size xy=""
    if [ -n "$region" ]; then
      size=$(echo "$region" | cut -d, -f3,4 | tr ',' 'x')
      xy="+$(echo "$region" | cut -d, -f1,2)"
    else
      size=$(xrandr 2>/dev/null | awk '/\*/ {print $1; exit}')
      [ -n "$size" ] || die "cannot detect screen size; pass --region x,y,w,h"
    fi
    echo "rec platform=linux device=x11grab:$display$xy size=$size fps=$fps out=$out"
    ffmpeg -hide_banner -y -loglevel warning -f x11grab -framerate "$fps" -video_size "$size" \
      -i "$display$xy" "${dur[@]}" "${vfa[@]}" "${enc[@]}" "$out"
  else
    die "unsupported platform $(os); on Windows use rec.ps1"
  fi

  echo "rec done $(ffprobe_dims "$out") $(du -h "$out" | cut -f1) $out"
}

main() {
  local sub="${1:-}"
  [ $# -gt 0 ] && shift
  case "$sub" in
    probe) cmd_probe ;;
    shot) cmd_shot "$@" ;;
    rec) cmd_rec "$@" ;;
    -h|--help|'') sed -n '2,9p' "$0" ;;
    *) die "unknown action '$sub' (probe|shot|rec)" ;;
  esac
}
main "$@"
