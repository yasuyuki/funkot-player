# Launch the built Windows app, wait until its window has drawn, and keep a picture of it.
#
#   -Exe  the built funkot-player.exe
#   -Out  directory that receives window.png, playlist-picker.png, history.png and result.json
#
# It opens the playlist picker by its button's name, keeps a picture of it and records
# where the panel and its search field sit in the window. It then selects the History
# tab by its accessible name and checks that the history is shown. Exits 1 when no
# window appears, the picture stays blank, the picker does not open, or the tab cannot
# be found and selected by name. It runs on a desktop session such as a GitHub-hosted
# Windows runner; it does not need a sound device.
param(
    [Parameter(Mandatory)][string]$Exe,
    [Parameter(Mandatory)][string]$Out
)

$ErrorActionPreference = 'Stop'
$WindowSeconds = 60
$DrawSeconds = 30
$TreeSeconds = 30
# Colours are counted inside the page only. The title bar, the window frame and a
# taskbar that overlaps the bottom edge are drawn before the page is.
$TitleBar = 40
$Frame = 16
$Taskbar = 56
# A drawn page samples about seventy colours there; an undrawn one is a single fill.
$DrawnColors = 16

New-Item -ItemType Directory -Force $Out | Out-Null
Add-Type -AssemblyName System.Drawing, System.Windows.Forms, UIAutomationClient, UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FunkotWindow {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
'@

$result = [ordered]@{ exe = (Get-FileHash $Exe).Hash; window = $false; drawn = $false; picker_shown = $false; history_shown = $false }
function Save-Result { $result | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $Out 'result.json') }

function Save-Picture($area, [string]$name = 'window.png') {
    $bitmap = New-Object System.Drawing.Bitmap $area.Width, $area.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($area.X, $area.Y, 0, 0, $bitmap.Size)
        $bitmap.Save((Join-Path $Out $name), [System.Drawing.Imaging.ImageFormat]::Png)
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

function Find-Name($root, [string]$name) {
    $condition = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::NameProperty), $name
    return $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}

function Invoke-Element($element) {
    $pattern = $null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $pattern.Invoke(); return }
    if ($element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) { $pattern.Expand(); return }
    throw "'$($element.Current.Name)' cannot be pressed through the accessibility tree"
}

# Where an element sits, in pixels from the window's top-left corner.
function Get-Place($element, $window) {
    $box = $element.Current.BoundingRectangle
    return [ordered]@{ x = [int]($box.X - $window.Left); y = [int]($box.Y - $window.Top); width = [int]$box.Width; height = [int]$box.Height }
}

function Find-Named($root, [string]$name, $type) {
    $condition = New-Object System.Windows.Automation.AndCondition @(
        (New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::NameProperty), $name),
        (New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), $type))
    return $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
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

    # Operate the page by name and role, as assistive technology does. WebView2 builds
    # the page's tree only after the first query, so the first answers are empty.
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    $clock.Restart()
    $tab = $null
    while (-not $tab -and $clock.Elapsed.TotalSeconds -lt $TreeSeconds) {
        Start-Sleep -Milliseconds 500
        $tab = Find-Named $root 'History' ([System.Windows.Automation.ControlType]::TabItem)
    }
    $result.seconds_to_tree = [math]::Round($clock.Elapsed.TotalSeconds, 1)
    if (-not $tab) { throw "no History tab in the accessibility tree within $TreeSeconds seconds" }

    # The playlist picker opens from the button named after what plays next, Queue by default.
    $choose = Find-Named $root 'Queue' ([System.Windows.Automation.ControlType]::Button)
    if (-not $choose) { throw 'no playlist picker button named Queue in the accessibility tree' }
    Invoke-Element $choose
    $clock.Restart()
    $picker = $null
    while (-not $picker -and $clock.Elapsed.TotalSeconds -lt $TreeSeconds) {
        Start-Sleep -Milliseconds 500
        $picker = Find-Name $root 'Choose what plays next'
    }
    if (-not $picker) { throw 'pressing the Queue button did not open the playlist picker' }
    $search = Find-Name $picker 'Search playlists'
    $result.picker_shown = $true
    $result.picker = Get-Place $picker $rect
    if ($search) { $result.picker_search = Get-Place $search $rect }
    Start-Sleep -Milliseconds 500
    Save-Picture $area 'playlist-picker.png' | Out-Null
    $close = Find-Named $picker 'Close' ([System.Windows.Automation.ControlType]::Button)
    if (-not $close) { throw 'the playlist picker has no Close button' }
    Invoke-Element $close
    $selection = $null
    if (-not $tab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)) {
        throw 'the History tab cannot be selected through the accessibility tree'
    }
    $selection.Select()
    $clock.Restart()
    $empty = $null
    while (-not $empty -and $clock.Elapsed.TotalSeconds -lt $TreeSeconds) {
        Start-Sleep -Milliseconds 500
        $empty = Find-Named $root 'Nothing played yet' ([System.Windows.Automation.ControlType]::Text)
    }
    $result.history_shown = [bool]$empty
    Save-Picture $area 'history.png' | Out-Null
    if (-not $empty) { throw 'selecting the History tab did not show the history' }
} catch {
    $result.error = $_.Exception.Message
    throw
} finally {
    Save-Result
    Get-Content (Join-Path $Out 'result.json')
    if (-not $app.HasExited) { Stop-Process -Id $app.Id -Force }
}
