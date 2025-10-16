# AI generated - Claude

param(
  [int]$fps,
  [int]$x,
  [int]$y,
  [int]$start_index
)

$ErrorActionPreference = "Stop"

# Resolve base/out folder (../../ relative to script)
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$outDir    = Resolve-Path (Join-Path $scriptDir "..\..")
$gifOut    = Join-Path $outDir "animated-X$x-Y$y.gif"
$webmOut   = Join-Path $outDir "animated-transparent-X$x-Y$y.webm"
$mp4Out    = Join-Path $outDir "animated-solid-X$x-Y$y.mp4"

# Input sequence paths
$seqNumbered = Join-Path $outDir "%d-X$x-Y$y.png"
$seqGlobFwd  = (Join-Path $outDir "*-X$x-Y$y.png").Replace('\','/')

# 1) GIF via gifski
& "C:\Users\jazza\Documents\Apps\gifski-1.32.0\win\gifski.exe" `
  --fps $fps --width 20000 --quality 70 -o $gifOut (Join-Path $outDir "*-X*-Y*.png")

# 2) Transparent video (keeps alpha) – VP9 WebM
$useGlob = $false
if ($useGlob) {
  $argsWebm = @(
    "-framerate", $fps,
    "-pattern_type", "glob", "-i", $seqGlobFwd,
    "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
    "-c:v", "libvpx-vp9",
    "-pix_fmt", "yuva420p",
    "-auto-alt-ref", "0",
    "-row-mt", "1",
    $webmOut
  )
} else {
  $argsWebm = @(
    "-framerate", $fps,
    "-start_number", $start_index, "-i", $seqNumbered,
    "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
    "-c:v", "libvpx-vp9",
    "-pix_fmt", "yuva420p",
    "-auto-alt-ref", "0",
    "-row-mt", "1",
    $webmOut
  )
}
& ffmpeg @argsWebm

# 3) Solid background MP4 – overlay sequence on a black canvas
# Auto-detect frame size from first frame or use default
$firstFrame = Get-ChildItem -Path $outDir -Filter "*-X$x-Y$y.png" | Select-Object -First 1
if ($firstFrame) {
  # Probe the first frame to get dimensions
  $probeOutput = & ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 $firstFrame.FullName
  if ($probeOutput -match '(\d+),(\d+)') {
    $bgSize = "$($matches[1])x$($matches[2])"
    Write-Host "Detected frame size: $bgSize"
  } else {
    $bgSize = "1920x1080"
    Write-Host "Could not detect size, using default: $bgSize"
  }
} else {
  $bgSize = "1920x1080"
  Write-Host "No frames found, using default size: $bgSize"
}

$argsMp4 = @(
  "-f", "lavfi", "-i", "color=c=#9ebdff:s=${bgSize}:rate=$fps",
  "-framerate", $fps, "-start_number", $start_index, "-i", $seqNumbered,
  "-filter_complex",
  "[1:v]format=rgba,scale=ceil(iw/2)*2:ceil(ih/2)*2[fg];[0:v]scale=ceil(iw/2)*2:ceil(ih/2)*2[bg];[bg][fg]overlay=shortest=1,format=yuv420p",
  "-c:v", "libx265", "-x265-params", "bframes=0", "-threads", "1",
  $mp4Out
)
& ffmpeg @argsMp4

Write-Host "`nOutputs created:"
Write-Host "  GIF:  $gifOut"
Write-Host "  WebM: $webmOut"
Write-Host "  MP4:  $mp4Out"