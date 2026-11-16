param(
    [string]$CredentialPath = (Join-Path $env:LOCALAPPDATA 'DaleiShopOps/haohuolai-api.dpapi.json')
)
$ErrorActionPreference = 'Stop'
# Start-Process may inherit PowerShell 7 module locations when launching Windows
# PowerShell 5. Load the core modules belonging to this process explicitly.
foreach ($stockComponentName in @('Microsoft.PowerShell.Security','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Management')) {
    Import-Module (Join-Path $PSHOME ('Modules/' + $stockComponentName + '/' + $stockComponentName + '.psd1')) -ErrorAction Stop
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (Test-Path -LiteralPath $CredentialPath) {
    throw '本机已有好货来授权文件。请先使用已有文件，不自动覆盖。'
}
$stockAuthForm = New-Object System.Windows.Forms.Form
$stockAuthForm.Text = '好货来本机授权'
$stockAuthForm.Size = New-Object System.Drawing.Size(550,330)
$stockAuthForm.StartPosition = 'CenterScreen'
$stockAuthForm.FormBorderStyle = 'FixedDialog'
$stockAuthForm.MaximizeBox = $false
$stockAuthForm.MinimizeBox = $false

$stockIntro = New-Object System.Windows.Forms.Label
$stockIntro.Text = '从好货来「授权管理 → 系统授权码」复制 AppKey 和 AppSecret。保存时仅在本机加密，不上传、不写聊天。此窗口不提交备货或发货。'
$stockIntro.Location = New-Object System.Drawing.Point(20,15)
$stockIntro.Size = New-Object System.Drawing.Size(490,55)
$stockAuthForm.Controls.Add($stockIntro)

$stockKeyLabel = New-Object System.Windows.Forms.Label
$stockKeyLabel.Text = 'AppKey'
$stockKeyLabel.Location = New-Object System.Drawing.Point(20,85)
$stockAuthForm.Controls.Add($stockKeyLabel)
$stockKeyInput = New-Object System.Windows.Forms.TextBox
$stockKeyInput.Location = New-Object System.Drawing.Point(120,82)
$stockKeyInput.Size = New-Object System.Drawing.Size(385,25)
$stockKeyInput.UseSystemPasswordChar = $true
$stockAuthForm.Controls.Add($stockKeyInput)

$stockSecretLabel = New-Object System.Windows.Forms.Label
$stockSecretLabel.Text = 'AppSecret'
$stockSecretLabel.Location = New-Object System.Drawing.Point(20,135)
$stockAuthForm.Controls.Add($stockSecretLabel)
$stockSecretInput = New-Object System.Windows.Forms.TextBox
$stockSecretInput.Location = New-Object System.Drawing.Point(120,132)
$stockSecretInput.Size = New-Object System.Drawing.Size(385,25)
$stockSecretInput.UseSystemPasswordChar = $true
$stockAuthForm.Controls.Add($stockSecretInput)

$stockMessage = New-Object System.Windows.Forms.Label
$stockMessage.Location = New-Object System.Drawing.Point(20,175)
$stockMessage.Size = New-Object System.Drawing.Size(490,35)
$stockAuthForm.Controls.Add($stockMessage)
$stockSave = New-Object System.Windows.Forms.Button
$stockSave.Text = '加密保存到本机'
$stockSave.Location = New-Object System.Drawing.Point(285,230)
$stockSave.Size = New-Object System.Drawing.Size(135,30)
$stockAuthForm.Controls.Add($stockSave)
$stockCancel = New-Object System.Windows.Forms.Button
$stockCancel.Text = '取消'
$stockCancel.Location = New-Object System.Drawing.Point(430,230)
$stockCancel.Size = New-Object System.Drawing.Size(75,30)
$stockCancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$stockAuthForm.Controls.Add($stockCancel)
$stockAuthForm.CancelButton = $stockCancel

$stockSave.Add_Click({
    $stockSaveStage = 'validate_input'
    try {
        if ([string]::IsNullOrWhiteSpace($stockKeyInput.Text) -or [string]::IsNullOrWhiteSpace($stockSecretInput.Text)) {
            $stockMessage.Text = '请填写 AppKey 和 AppSecret，不能填系统授权码。'
            return
        }
        $stockSaveStage = 'encrypt_appkey'
        $stockKeyProtected = ConvertFrom-SecureString (ConvertTo-SecureString $stockKeyInput.Text.Trim() -AsPlainText -Force)
        $stockSaveStage = 'encrypt_appsecret'
        $stockSecretProtected = ConvertFrom-SecureString (ConvertTo-SecureString $stockSecretInput.Text.Trim() -AsPlainText -Force)
        $stockSaveStage = 'create_directory'
        $stockCredentialDir = Split-Path -Parent $CredentialPath
        New-Item -ItemType Directory -Force -Path $stockCredentialDir | Out-Null
        $stockCredential = [ordered]@{version=1;origin='https://haohuolai.huoxiaoyi.com';appKeyProtected=$stockKeyProtected;appSecretProtected=$stockSecretProtected}
        $stockSaveStage = 'write_encrypted_file'
        [System.IO.File]::WriteAllText($CredentialPath, ($stockCredential | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
        $stockSaveStage = 'protect_file_permissions'
        $stockAcl = New-Object System.Security.AccessControl.FileSecurity
        $stockAcl.SetAccessRuleProtection($true,$false)
        $stockIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $stockAcl.SetOwner($stockIdentity)
        $stockAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($stockIdentity,'FullControl','Allow')))
        Set-Acl -LiteralPath $CredentialPath -AclObject $stockAcl
        $stockKeyInput.Clear()
        $stockSecretInput.Clear()
        $stockAuthForm.DialogResult = [System.Windows.Forms.DialogResult]::OK
        $stockAuthForm.Close()
    } catch {
        # Log only a fixed stage and error codes; no inputs, raw exception messages,
        # authentication material, request headers or unencrypted values.
        $stockSafeSaveFailure = [ordered]@{
            stage = $stockSaveStage
            errorType = $_.Exception.GetType().FullName
            errorId = $_.FullyQualifiedErrorId
            hResult = $_.Exception.HResult
            line = $_.InvocationInfo.ScriptLineNumber
            credentialPathPresent = ![string]::IsNullOrWhiteSpace($CredentialPath)
        }
        try {
            $stockSafeFailurePath = Join-Path $env:LOCALAPPDATA 'DaleiShopOps/auth-save-diagnostic.json'
            [System.IO.File]::WriteAllText($stockSafeFailurePath, ($stockSafeSaveFailure | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
        } catch { }
        $stockMessage.Text = '保存未完成。出错步骤：' + $stockSaveStage + '。错误代码已记录，不含密钥。'
    }
})
$stockAuthResult = $stockAuthForm.ShowDialog()
$stockAuthForm.Dispose()
if ($stockAuthResult -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output '本机加密授权文件已保存，尚未联网核验。'
} else {
    Write-Output '授权已取消，尚未联网。'
    exit 2
}
