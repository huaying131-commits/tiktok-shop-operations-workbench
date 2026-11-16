param(
    [string]$StatePath = (Join-Path $env:USERPROFILE '.fastmoss-mcp/state.json')
)
$ErrorActionPreference = 'Stop'
# A Windows PowerShell child must load its own core modules, rather than
# inheriting incompatible PowerShell 7 module paths.
foreach ($fmModule in @('Microsoft.PowerShell.Security','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Management')) {
    Import-Module (Join-Path $PSHOME ('Modules/' + $fmModule + '/' + $fmModule + '.psd1')) -ErrorAction Stop
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$fmWindow = New-Object System.Windows.Forms.Form
$fmWindow.Text = 'FastMoss 本机授权'
$fmWindow.Size = New-Object System.Drawing.Size(620,290)
$fmWindow.StartPosition = 'CenterScreen'
$fmWindow.FormBorderStyle = 'FixedDialog'
$fmWindow.MaximizeBox = $false
$fmWindow.TopMost = $true
$fmIntro = New-Object System.Windows.Forms.Label
$fmIntro.Text = '粘贴合作方提供的 MCP/CLI API Key。仅保存到官方 CLI 的本机配置，并限制为当前 Windows 用户可读；不会写入聊天、命令参数或 Codex MCP 配置。此窗口只保存授权，不充值、不查询。'
$fmIntro.Location = New-Object System.Drawing.Point(20,16)
$fmIntro.Size = New-Object System.Drawing.Size(565,72)
$fmWindow.Controls.Add($fmIntro)
$fmLabel = New-Object System.Windows.Forms.Label
$fmLabel.Text = 'API Key'
$fmLabel.Location = New-Object System.Drawing.Point(20,103)
$fmWindow.Controls.Add($fmLabel)
$fmInput = New-Object System.Windows.Forms.TextBox
$fmInput.Location = New-Object System.Drawing.Point(115,100)
$fmInput.Size = New-Object System.Drawing.Size(465,25)
$fmInput.UseSystemPasswordChar = $true
$fmWindow.Controls.Add($fmInput)
$fmMessage = New-Object System.Windows.Forms.Label
$fmMessage.Location = New-Object System.Drawing.Point(20,142)
$fmMessage.Size = New-Object System.Drawing.Size(560,32)
$fmWindow.Controls.Add($fmMessage)
$fmSave = New-Object System.Windows.Forms.Button
$fmSave.Text = '保存到本机'
$fmSave.Location = New-Object System.Drawing.Point(370,190)
$fmSave.Size = New-Object System.Drawing.Size(120,32)
$fmWindow.Controls.Add($fmSave)
$fmCancel = New-Object System.Windows.Forms.Button
$fmCancel.Text = '取消'
$fmCancel.Location = New-Object System.Drawing.Point(505,190)
$fmCancel.Size = New-Object System.Drawing.Size(75,32)
$fmCancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$fmWindow.Controls.Add($fmCancel)
$fmWindow.CancelButton = $fmCancel

function Set-FmPrivateFile([string]$Path) {
    $fmIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $fmAcl = New-Object System.Security.AccessControl.FileSecurity
    $fmAcl.SetAccessRuleProtection($true,$false)
    $fmAcl.SetOwner($fmIdentity)
    $fmAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($fmIdentity,'FullControl','Allow')))
    Set-Acl -LiteralPath $Path -AclObject $fmAcl
}

$fmSave.Add_Click({
    try {
        $fmValue = $fmInput.Text.Trim()
        if ($fmValue.Length -lt 8 -or $fmValue -match '\s') {
            $fmMessage.Text = '请粘贴完整的 API Key，不要填写账号、网址或空白字符。'
            return
        }
        $fmFolder = Split-Path -Parent $StatePath
        New-Item -ItemType Directory -Path $fmFolder -Force | Out-Null
        if (Test-Path -LiteralPath $StatePath) {
            $fmState = Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
        } else {
            $fmState = [pscustomobject]@{ api_key=''; language='zh-CN'; oauth_expires_at='' }
            [System.IO.File]::WriteAllText($StatePath,'{}',(New-Object System.Text.UTF8Encoding($false)))
        }
        Set-FmPrivateFile $StatePath
        $fmState | Add-Member -NotePropertyName api_key -NotePropertyValue $fmValue -Force
        [System.IO.File]::WriteAllText($StatePath,($fmState | ConvertTo-Json -Depth 10 -Compress),(New-Object System.Text.UTF8Encoding($false)))
        $fmReadback = Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($fmReadback.api_key -cne $fmValue) { throw 'LOCAL_SAVE_CHECK_FAILED' }
        $fmValue = $null
        $fmReadback = $null
        $fmState = $null
        $fmInput.Clear()
        $fmWindow.DialogResult = [System.Windows.Forms.DialogResult]::OK
        $fmWindow.Close()
    } catch {
        $fmMessage.Text = '本机保存失败。没有发出网络请求；请把这个提示告诉我。'
    }
})
$fmResult = $fmWindow.ShowDialog()
$fmWindow.Dispose()
if ($fmResult -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output 'FastMoss authorization saved locally; network verification pending.'
} else { exit 2 }
