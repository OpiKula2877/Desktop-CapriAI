# Desktop CapriAI – Windows helper.
# Long-running process: reads one JSON command per line on stdin, writes one JSON reply per line.
# Coordinates are physical pixels (process is DPI aware).

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Runtime.WindowsRuntime

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class CapriWin {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);

  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr p);

  // First visible top-level window with this class (tool windows included, e.g. the on-screen keyboard).
  public static object[] FindClass(string cls) {
    object[] found = null;
    EnumWindows((h, p) => {
      if (IsWindowVisible(h) && ClassOf(h) == cls) { found = Info(h); return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  // The text control inside a window (Notepad: RichEditD2DPT on Windows 11, Edit on older builds).
  public static IntPtr EditChild(IntPtr top) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(top, (h, p) => {
      string c = ClassOf(h);
      if (c == "RichEditD2DPT" || c == "Edit" || c.StartsWith("RichEdit")) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  // Post characters straight to that control (WM_CHAR). Nothing goes through the global input queue,
  // so the text can only ever land in this one window.
  public static bool CharsInto(long hwnd, string text) {
    var edit = EditChild(new IntPtr(hwnd));
    if (edit == IntPtr.Zero) return false;
    foreach (char ch in text) PostMessage(edit, 0x0102, new IntPtr(ch == (char)10 ? 13 : ch), new IntPtr(1));
    return true;
  }

  public static bool Close(long hwnd) { return PostMessage(new IntPtr(hwnd), 0x0010, IntPtr.Zero, IntPtr.Zero); }

  public static string ClassOf(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }

  public static object[] Info(IntPtr h) {
    int len = GetWindowTextLength(h);
    var sb = new StringBuilder(len + 1);
    GetWindowText(h, sb, sb.Capacity);
    RECT r; GetWindowRect(h, out r);
    uint pid; GetWindowThreadProcessId(h, out pid);
    return new object[] { h.ToInt64(), sb.ToString(), (int)pid, r.L, r.T, r.R - r.L, r.B - r.T, IsIconic(h), ClassOf(h) };
  }

  public static object[] Foreground() {
    var h = GetForegroundWindow();
    return h == IntPtr.Zero ? null : Info(h);
  }

  public static List<object[]> List() {
    var res = new List<object[]>();
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      if (GetWindow(h, 4) != IntPtr.Zero) return true; // owned windows
      int ex = GetWindowLong(h, -20);
      if ((ex & 0x80) != 0) return true; // tool windows
      int cloaked; DwmGetWindowAttribute(h, 14, out cloaked, 4);
      if (cloaked != 0) return true;
      if (GetWindowTextLength(h) == 0) return true;
      res.Add(Info(h));
      return true;
    }, IntPtr.Zero);
    return res;
  }

  public static bool Focus(long hwnd) {
    var h = new IntPtr(hwnd);
    if (IsIconic(h)) ShowWindow(h, 9);
    keybd_event(0x12, 0, 0, IntPtr.Zero); // ALT down/up unlocks SetForegroundWindow
    keybd_event(0x12, 0, 2, IntPtr.Zero);
    return SetForegroundWindow(h);
  }

  public static void Click(int x, int y, bool right, bool dbl) {
    SetCursorPos(x, y);
    uint down = right ? 0x0008u : 0x0002u, up = right ? 0x0010u : 0x0004u;
    int n = dbl ? 2 : 1;
    for (int i = 0; i < n; i++) { mouse_event(down, 0, 0, 0, IntPtr.Zero); mouse_event(up, 0, 0, 0, IntPtr.Zero); }
  }
}
"@

[CapriWin]::SetProcessDPIAware() | Out-Null

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($op, $type) {
  $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $t.Wait(3000) | Out-Null
  $t.Result
}

$script:mediaMgr = $null
function Get-NowPlaying {
  try {
    if (-not $script:mediaMgr) {
      [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
      $script:mediaMgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    }
    $s = $script:mediaMgr.GetCurrentSession()
    if (-not $s) { return $null }
    $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    return @{
      title   = [string]$p.Title
      artist  = [string]$p.Artist
      playing = ($s.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Playing')
      app     = [string]$s.SourceAppUserModelId
    }
  } catch { return $null }
}

function Escape-SendKeys([string]$t) {
  return ($t -replace '([+^%~(){}\[\]])', '{$1}') -replace "`r?`n", '{ENTER}'
}

function Reply($id, $ok, $data) {
  $o = @{ id = $id; ok = $ok }
  if ($ok) { $o.result = $data } else { $o.error = [string]$data }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}

Reply 0 $true 'ready'

while ($null -ne ($line = [Console]::In.ReadLine())) {
  if (-not $line.Trim()) { continue }
  $id = 0
  try {
    $c = $line | ConvertFrom-Json
    $id = $c.id
    switch ($c.cmd) {
      'windows' {
        $procs = @{}
        Get-Process | ForEach-Object { $procs[$_.Id] = $_.ProcessName }
        $list = [CapriWin]::List() | ForEach-Object {
          @{ hwnd = $_[0]; title = $_[1]; process = $procs[[int]$_[2]]; x = $_[3]; y = $_[4]; w = $_[5]; h = $_[6]; minimized = $_[7]; cls = $_[8] }
        }
        Reply $id $true @($list)
      }
      'foreground' {
        $f = [CapriWin]::Foreground()
        if ($f) { Reply $id $true @{ hwnd = $f[0]; title = $f[1]; x = $f[3]; y = $f[4]; w = $f[5]; h = $f[6]; minimized = $f[7]; cls = $f[8] } }
        else { Reply $id $true $null }
      }
      'focus' { Reply $id $true ([CapriWin]::Focus([long]$c.hwnd)) }
      'click' { [CapriWin]::Click([int]$c.x, [int]$c.y, [bool]$c.right, [bool]$c.double); Reply $id $true $true }
      'type' { [System.Windows.Forms.SendKeys]::SendWait((Escape-SendKeys ([string]$c.text))); Reply $id $true $true }
      'cursor' { $p = New-Object CapriWin+POINT; [CapriWin]::GetCursorPos([ref]$p) | Out-Null; Reply $id $true @{ x = $p.X; y = $p.Y } }
      'media' { Reply $id $true (Get-NowPlaying) }
      'findClass' {
        $f = [CapriWin]::FindClass([string]$c.cls)
        if ($f) { Reply $id $true @{ hwnd = $f[0]; title = $f[1]; pid = $f[2]; x = $f[3]; y = $f[4]; w = $f[5]; h = $f[6]; minimized = $f[7]; cls = $f[8] } }
        else { Reply $id $true $null }
      }
      'charsInto' { Reply $id $true ([CapriWin]::CharsInto([long]$c.hwnd, [string]$c.text)) }
      'close' { Reply $id $true ([CapriWin]::Close([long]$c.hwnd)) }
      'explorerWindows' {
        # Open File Explorer windows (hwnd + current folder) via the Shell COM object.
        $shell = New-Object -ComObject Shell.Application
        $list = foreach ($w in $shell.Windows()) {
          try { if ($w.FullName -like '*explorer.exe') { @{ hwnd = [long]$w.HWND; path = [string]$w.Document.Folder.Self.Path } } } catch {}
        }
        Reply $id $true @($list)
      }
      'explorerNavigate' {
        $shell = New-Object -ComObject Shell.Application
        $ok = $false
        foreach ($w in $shell.Windows()) {
          try { if ([long]$w.HWND -eq [long]$c.hwnd) { $w.Navigate2([string]$c.path); $ok = $true } } catch {}
        }
        Reply $id $true $ok
      }
      'folderNames' {
        # Names only (no file contents) of sub-folders in a neutral system folder she browses.
        $names = Get-ChildItem -LiteralPath ([string]$c.path) -Directory -ErrorAction SilentlyContinue | Select-Object -First 30 -ExpandProperty Name
        Reply $id $true @($names)
      }
      default { Reply $id $false "unknown command $($c.cmd)" }
    }
  } catch {
    Reply $id $false $_.Exception.Message
  }
}
