param([switch]$Check)
$ErrorActionPreference = 'Stop'
foreach ($component in @('Microsoft.PowerShell.Security','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Management')) {
    Import-Module (Join-Path $PSHOME ('Modules/' + $component + '/' + $component + '.psd1')) -ErrorAction Stop
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class ScoreHubCaptureVisibility {
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int cmd);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
'@
$credentialDir = Join-Path $env:LOCALAPPDATA 'DaleiShopOps/ScoreHub'
$statusPath = Join-Path $credentialDir 'capture-status.json'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Protect-LocalPath([string]$Path, [bool]$Directory) {
    if ($Directory) { $info = New-Object System.IO.DirectoryInfo($Path) }
    else { $info = New-Object System.IO.FileInfo($Path) }
    # Persist only access rules. Set-Acl on a fresh descriptor attempted privileged
    # audit-security persistence on this machine and prevented the dialog opening.
    $acl = $info.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access)
    $acl.SetAccessRuleProtection($true,$false)
    if ($Directory) {
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    } else { $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity,'FullControl','Allow') }
    $acl.AddAccessRule($rule)
    $info.SetAccessControl($acl)
}
function Save-Status([string]$State, [string[]]$Markets) {
    $record = [ordered]@{state=$State;markets=$Markets;login_submitted=$false;capture_process_id=$PID;updated_at=[DateTimeOffset]::Now.ToString('o')}
    if ($form -and $form.IsHandleCreated) {
        $record.window_handle = $form.Handle.ToInt64()
        $record.window_visible = [ScoreHubCaptureVisibility]::IsWindowVisible($form.Handle)
    }
    [IO.File]::WriteAllText($statusPath,($record | ConvertTo-Json -Compress),$utf8)
    Protect-LocalPath $statusPath $false
}
if ($Check) {
    $probe = ConvertFrom-SecureString (ConvertTo-SecureString 'scorehub-local-check' -AsPlainText -Force)
    $secure = ConvertTo-SecureString $probe
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { if ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) -ne 'scorehub-local-check') { throw 'Roundtrip failed' } }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secure.Dispose() }
    $probeDirectory = Join-Path $env:TEMP ('scorehub-acl-check-' + [Guid]::NewGuid().ToString('N'))
    $probeFile = Join-Path $probeDirectory 'probe.txt'
    try {
        [IO.Directory]::CreateDirectory($probeDirectory) | Out-Null
        Protect-LocalPath $probeDirectory $true
        [IO.File]::WriteAllText($probeFile,'public ACL probe',$utf8)
        Protect-LocalPath $probeFile $false
        $probeAcl = (New-Object System.IO.FileInfo($probeFile)).GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access)
        $probeRules = @($probeAcl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))
        if ($probeRules.Count -ne 1 -or $probeRules[0].IdentityReference.Value -ne $identity.Value -or -not $probeAcl.AreAccessRulesProtected) { throw 'Access rules check failed' }
    } finally {
        if ([IO.File]::Exists($probeFile)) { [IO.File]::Delete($probeFile) }
        if ([IO.Directory]::Exists($probeDirectory)) { [IO.Directory]::Delete($probeDirectory,$false) }
    }
    Write-Output 'CHECK_OK: CurrentUser encryption, directory/file access rules and form assemblies; no credentials read or written.'
    exit 0
}
New-Item -ItemType Directory -Force -Path $credentialDir | Out-Null
Protect-LocalPath $credentialDir $true
Save-Status 'opening' @()
$form = New-Object System.Windows.Forms.Form
$form.Text = 'ScoreHub 本机保密输入（马来西亚 / 越南）'
$form.Size = New-Object System.Drawing.Size(620,440)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei',10)
$intro = New-Object System.Windows.Forms.Label
$intro.Text = "账号密码仅在本机用当前 Windows 用户加密保存，不进入聊天或运营日志。`r`n保存不会自动登录。之后按你的指示选择国家并登录。越南可暂留空。"
$intro.SetBounds(20,15,570,65)
$form.Controls.Add($intro)
$fields = @{}
$y = 90
foreach ($market in @('MY','VN')) {
    $group = New-Object System.Windows.Forms.GroupBox
    if ($market -eq 'MY') { $group.Text = '马来西亚 MY（本轮使用）' } else { $group.Text = '越南 VN（单独保存，可选）' }
    $group.SetBounds(20,$y,570,110)
    $accountLabel = New-Object System.Windows.Forms.Label
    $accountLabel.Text = '手机号 / 邮箱'; $accountLabel.SetBounds(12,27,130,25)
    $passwordLabel = New-Object System.Windows.Forms.Label
    $passwordLabel.Text = '密码'; $passwordLabel.SetBounds(12,68,130,25)
    $account = New-Object System.Windows.Forms.TextBox
    $account.SetBounds(150,25,395,28)
    $password = New-Object System.Windows.Forms.TextBox
    $password.SetBounds(150,65,395,28); $password.UseSystemPasswordChar = $true
    $group.Controls.AddRange(@($accountLabel,$passwordLabel,$account,$password))
    $form.Controls.Add($group)
    $fields[$market] = @{account=$account;password=$password}
    $y += 120
}
$message = New-Object System.Windows.Forms.Label
$message.SetBounds(20,330,570,25); $form.Controls.Add($message)
$save = New-Object System.Windows.Forms.Button
$save.Text = '加密保存（不登录）'; $save.SetBounds(310,360,185,32); $form.Controls.Add($save)
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = '取消'; $cancel.SetBounds(505,360,85,32)
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($cancel); $form.CancelButton = $cancel
$save.Add_Click({
    $stage = 'validate'
    try {
        if ([string]::IsNullOrWhiteSpace($fields.MY.account.Text) -or $fields.MY.password.Text.Length -eq 0) {
            $message.Text = '请填写本轮马来西亚的账号和密码。'; return
        }
        $pending = @()
        foreach ($market in @('MY','VN')) {
            $a = $fields[$market].account.Text.Trim(); $p = $fields[$market].password.Text
            if ($a.Length -eq 0 -and $p.Length -eq 0) { continue }
            if ($a.Length -eq 0 -or $p.Length -eq 0) { $message.Text = '每个国家需同时填写账号和密码，或同时留空。'; return }
            $path = Join-Path $credentialDir ($market + '.dpapi.json')
            if (Test-Path -LiteralPath $path) { $message.Text = $market + ' 已有加密账号，本窗口不覆盖。'; return }
            $stage = 'encrypt'
            $payload = [ordered]@{version=1;service='ScoreHub';market=$market;account=$a;password=$p}
            $protected = ConvertFrom-SecureString (ConvertTo-SecureString ($payload | ConvertTo-Json -Compress) -AsPlainText -Force)
            $pending += @{market=$market;path=$path;encrypted=$protected}
            $payload = $null; $a = $null; $p = $null
        }
        $stage = 'save'
        foreach ($item in $pending) {
            $record = [ordered]@{version=1;service='ScoreHub';market=$item.market;protection='Windows CurrentUser DPAPI';protected=$item.encrypted;require_user_instruction_for_login=$true}
            [IO.File]::WriteAllText($item.path,($record | ConvertTo-Json -Compress),$utf8)
            Protect-LocalPath $item.path $false
        }
        Save-Status 'saved' @($pending | ForEach-Object {$_.market})
        foreach ($field in $fields.Values) { $field.account.Clear(); $field.password.Clear() }
        $form.DialogResult = [System.Windows.Forms.DialogResult]::OK; $form.Close()
    } catch { $message.Text = '未完成，步骤：' + $stage + '。账号密码未输出。请勿在聊天中粘贴密码。' }
})
$form.Add_Shown({
    [void][ScoreHubCaptureVisibility]::ShowWindow($form.Handle,9)
    $form.TopMost = $true
    $form.Activate()
    [void][ScoreHubCaptureVisibility]::SetForegroundWindow($form.Handle)
    [void]$fields.MY.account.Focus()
    if ([ScoreHubCaptureVisibility]::IsWindowVisible($form.Handle)) { Save-Status 'awaiting_input' @() }
    else { Save-Status 'window_not_visible' @() }
})
$result = $form.ShowDialog()
$form.Dispose()
if ($result -ne [System.Windows.Forms.DialogResult]::OK) { Save-Status 'cancelled' @(); exit 2 }
Write-Output 'SAVED: country-separated encrypted credentials; no login submitted.'
