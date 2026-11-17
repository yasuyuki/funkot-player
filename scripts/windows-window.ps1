# Launch the built Windows app, wait until its window has drawn, and keep a picture of it.
#
#   -Exe  the built funkot-player.exe
#   -Out  directory that receives window.png and result.json
#
# Exits 1 when no window appears or the picture stays blank. It runs on a desktop
# session such as a GitHub-hosted Windows runner; it does not need a sound device.
param(
    [Parameter(Mandatory)][string]$Exe,
    [Parameter(Mandatory)][string]$Out
)

$ErrorActionPreference = 'Stop'
$WindowSeconds = 60
$DrawSeconds = 30
# Colours are counted inside the page only. The title bar, the window frame and a
# taskbar that overlaps the bottom edge are drawn before the page is.
$TitleBar = 40
$Frame = 16
$Taskbar = 56
# A drawn page samples about seventy colours there; an undrawn one is a single fill.
$DrawnColors = 16

New-Item -ItemType Directory -Force $Out | Out-Null
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FunkotWindow {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
'@

$result = [ordered]@{ exe = (Get-FileHash $Exe).Hash; window = $false; drawn = $false }
function Save-Result { $result | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $Out 'result.json') }

function Save-Picture($area) {
    $bitmap = New-Object System.Drawing.Bitmap $area.Width, $area.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($area.X, $area.Y, 0, 0, $bitmap.Size)
        $bitmap.Save((Join-Path $Out 'window.png'), [System.Drawing.Imaging.ImageFormat]::Png)
        $colors = @{}
        for ($x = $Frame; $x -lt $bitmap.Width - $Frame; $x += 8) {
            for ($y = $TitleBar; $y -lt $bitmap.Height - $Taskbar; $y += 8) { $colors[$bitmap.GetPixel($x, $y).ToArgb()] = 1 }
        }
        return $colors.Count
    } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

$clock = [Diagnostics.Stopwatch]::StartNew()
$app = Start-Process (Resolve-Path $Exe) -PassThru
try {
    $handle = [IntPtr]::Zero
    while ($clock.Elapsed.TotalSeconds -lt $WindowSeconds -and $handle -eq [IntPtr]::Zero) {
        Start-Sleep -Milliseconds 250
        $app.Refresh()
        if ($app.HasExited) { throw "the app exited with code $($app.ExitCode) before it showed a window" }
        $handle = $app.MainWindowHandle
    }
    if ($handle -eq [IntPtr]::Zero) { throw "no window within $WindowSeconds seconds" }
    $result.window = $true
    $result.title = $app.MainWindowTitle
    $result.seconds_to_window = [math]::Round($clock.Elapsed.TotalSeconds, 1)
    [FunkotWindow]::SetForegroundWindow($handle) | Out-Null

    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $clock.Restart()
    do {
        Start-Sleep -Milliseconds 500
        $rect = New-Object FunkotWindow+RECT
        [FunkotWindow]::GetWindowRect($handle, [ref]$rect) | Out-Null
        $left = [math]::Max($rect.Left, 0)
        $top = [math]::Max($rect.Top, 0)
        $area = New-Object System.Drawing.Rectangle $left, $top, ([math]::Min($rect.Right, $screen.Width) - $left), ([math]::Min($rect.Bottom, $screen.Height) - $top)
        $result.sampled_colors = Save-Picture $area
        $result.drawn = $result.sampled_colors -ge $DrawnColors
    } until ($result.drawn -or $clock.Elapsed.TotalSeconds -ge $DrawSeconds)
    $result.seconds_to_draw = [math]::Round($clock.Elapsed.TotalSeconds, 1)
    if ($result.drawn) {
        # The first drawn frame can be partial; keep the picture of the settled page.
        Start-Sleep -Seconds 2
        $result.sampled_colors = Save-Picture $area
    }
    $result.picture = "$($area.Width)x$($area.Height)"
    if (-not $result.drawn) { throw "the window stayed blank for $DrawSeconds seconds" }
} catch {
    $result.error = $_.Exception.Message
    throw
} finally {
    Save-Result
    Get-Content (Join-Path $Out 'result.json')
    if (-not $app.HasExited) { Stop-Process -Id $app.Id -Force }
}
