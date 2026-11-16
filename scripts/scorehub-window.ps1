param([Parameter(Mandatory=$true)][int]$CaptureProcessId,[switch]$Show)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class ScoreHubWindow {
 public delegate bool Callback(IntPtr h, IntPtr arg);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Callback cb, IntPtr arg);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder text,int count);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int cmd);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int cx,int cy,uint flags);
 public static IntPtr[] Find(uint requested) {
  var list=new List<IntPtr>();
  EnumWindows((h,arg)=>{uint pid;GetWindowThreadProcessId(h,out pid);if(pid==requested)list.Add(h);return true;},IntPtr.Zero);
  return list.ToArray();
 }
}
'@
$capture = Get-Process -Id $CaptureProcessId -ErrorAction Stop
if ($capture.ProcessName -ne 'powershell') { throw 'Unexpected capture process' }
$result = @()
foreach ($handle in [ScoreHubWindow]::Find([uint32]$CaptureProcessId)) {
    $title = New-Object Text.StringBuilder(512)
    [void][ScoreHubWindow]::GetWindowText($handle,$title,$title.Capacity)
    # Only inspect or display the credential form created by this task. No field reads.
    if (-not $title.ToString().StartsWith('ScoreHub ')) { continue }
    $before = [ScoreHubWindow]::IsWindowVisible($handle)
    $foreground = $false
    if ($Show) {
        [void][ScoreHubWindow]::ShowWindow($handle,9)
        [void][ScoreHubWindow]::SetWindowPos($handle,[IntPtr](-1),0,0,0,0,0x0043)
        $foreground = [ScoreHubWindow]::SetForegroundWindow($handle)
    }
    $result += [pscustomobject]@{process_id=$CaptureProcessId;title=$title.ToString();handle=$handle.ToInt64();visible_before=$before;visible_after=[ScoreHubWindow]::IsWindowVisible($handle);foreground_requested=$foreground;fields_read=$false}
}
ConvertTo-Json -InputObject @($result) -Compress
