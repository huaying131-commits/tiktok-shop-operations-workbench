param([string]$CredentialPath=(Join-Path $env:LOCALAPPDATA 'DaleiShopOps/warehouse-web-accounts.dpapi.json'))
$ErrorActionPreference='Stop'
foreach($component in @('Microsoft.PowerShell.Security','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Management')) {
    Import-Module (Join-Path $PSHOME ('Modules/'+$component+'/'+$component+'.psd1'))
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if(Test-Path -LiteralPath $CredentialPath){throw '本机已有仓库网页授权，请复用，不自动覆盖。'}
$webForm=New-Object Windows.Forms.Form
$webForm.Text='仓库网页账号｜本机保密保存'
$webForm.Size=New-Object Drawing.Size(660,640)
$webForm.StartPosition='CenterScreen';$webForm.TopMost=$true;$webForm.ShowInTaskbar=$true
$webForm.FormBorderStyle='FixedDialog';$webForm.MaximizeBox=$false
$intro=New-Object Windows.Forms.Label
$intro.Text='填写各仓网页登录账号（手机号/邮箱/用户名）与密码。仅在本机加密保存，用于仓库专用Chrome登录；不会发到聊天。不填的仓库暂时跳过。验证码仍由你完成。'
$intro.Location=New-Object Drawing.Point(20,15);$intro.Size=New-Object Drawing.Size(610,55)
$webForm.Controls.Add($intro)
$configs=@(
    @{slug='shenniu';name='神牛仓';origin='https://shenniu.topwms.com'},
    @{slug='zhanma';name='战马仓';origin='https://zsb.topwms.com'},
    @{slug='yatai';name='亚泰仓';origin='https://yataiyun.topwms.com'},
    @{slug='haohuolai';name='好货来';origin='https://haohuolai.huoxiaoyi.com'}
)
$webFields=@()
for($index=0;$index -lt $configs.Count;$index++) {
    $config=$configs[$index];$top=75+105*$index
    $group=New-Object Windows.Forms.GroupBox
    $group.Text=$config.name+'  '+$config.origin
    $group.Location=New-Object Drawing.Point(20,$top);$group.Size=New-Object Drawing.Size(610,98)
    foreach($spec in @(@{caption='登录账号';y=23},@{caption='登录密码';y=58})) {
        $label=New-Object Windows.Forms.Label;$label.Text=$spec.caption
        $label.Location=New-Object Drawing.Point(12,($spec.y+3));$label.Size=New-Object Drawing.Size(85,25)
        $input=New-Object Windows.Forms.TextBox
        $input.Location=New-Object Drawing.Point(105,$spec.y);$input.Size=New-Object Drawing.Size(485,25)
        $input.UseSystemPasswordChar=$true
        $group.Controls.Add($label);$group.Controls.Add($input)
        if($spec.caption -eq '登录账号'){$accountInput=$input}else{$passwordInput=$input}
    }
    $webForm.Controls.Add($group)
    $webFields+=@{config=$config;account=$accountInput;password=$passwordInput}
}
$message=New-Object Windows.Forms.Label
$message.Location=New-Object Drawing.Point(20,500);$message.Size=New-Object Drawing.Size(610,38)
$webForm.Controls.Add($message)
$save=New-Object Windows.Forms.Button;$save.Text='加密保存填写的仓库'
$save.Location=New-Object Drawing.Point(365,550);$save.Size=New-Object Drawing.Size(175,32)
$webForm.Controls.Add($save)
$cancel=New-Object Windows.Forms.Button;$cancel.Text='取消'
$cancel.Location=New-Object Drawing.Point(550,550);$cancel.Size=New-Object Drawing.Size(80,32)
$cancel.DialogResult=[Windows.Forms.DialogResult]::Cancel
$webForm.Controls.Add($cancel);$webForm.CancelButton=$cancel
$save.Add_Click({
    try {
        $accounts=[ordered]@{}
        foreach($entry in $webFields) {
            $username=$entry.account.Text.Trim();$password=$entry.password.Text
            if(!$username -and !$password){continue}
            if(!$username -or !$password){$message.Text='请将所填仓库的账号和密码填写完整；不接入的仓库留空。';return}
            $accounts[$entry.config.slug]=[ordered]@{
                origin=$entry.config.origin
                usernameProtected=(ConvertFrom-SecureString (ConvertTo-SecureString $username -AsPlainText -Force))
                passwordProtected=(ConvertFrom-SecureString (ConvertTo-SecureString $password -AsPlainText -Force))
            }
            $username=$null;$password=$null
        }
        if(!$accounts.Count){$message.Text='请至少填写一个仓库的网页登录账号与密码。';return}
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($CredentialPath))|Out-Null
        $data=[ordered]@{version=1;usage='warehouse_web_login_only';accounts=$accounts}
        [IO.File]::WriteAllText($CredentialPath,($data|ConvertTo-Json -Depth 6 -Compress),[Text.UTF8Encoding]::new($false))
        $acl=New-Object Security.AccessControl.FileSecurity
        $acl.SetAccessRuleProtection($true,$false)
        $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
        $acl.SetOwner($sid)
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')))
        Set-Acl -LiteralPath $CredentialPath -AclObject $acl
        foreach($entry in $webFields){$entry.account.Clear();$entry.password.Clear()}
        $webForm.DialogResult=[Windows.Forms.DialogResult]::OK;$webForm.Close()
    } catch {$message.Text='保存未完成，请重试。不会显示账号或密码。'}
})
$webForm.Add_Shown({$webForm.Activate();$webForm.BringToFront();$webFields[0].account.Focus()|Out-Null})
$result=$webForm.ShowDialog();$webForm.Dispose()
if($result -eq [Windows.Forms.DialogResult]::OK){Write-Output '仓库网页账号已在本机加密保存。尚未验证网页登录。'}else{Write-Output '录入已取消。';exit 2}
