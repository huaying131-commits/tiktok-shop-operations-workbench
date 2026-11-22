[CmdletBinding()]
param([string]$Branch='cloud-227-read-v3-20261122')
$ErrorActionPreference='Stop'
Set-Location ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')))
if($Branch -ne 'cloud-227-read-v3-20261122'){throw 'This publisher is scoped to the reviewed cloud source branch.'}
if((git branch --show-current).Trim() -ne $Branch){throw 'Unexpected branch.'}
if((git remote get-url origin).Trim() -ne 'https://github.com/huaying131-commits/tiktok-shop-operations-workbench.git'){throw 'Unexpected repository.'}
git diff --check
if($LASTEXITCODE){throw 'Whitespace validation failed.'}
git add -- README.md apps/cloud-shop-read apps/business-callback-receiver tools/publish-cloud-read.ps1
if($LASTEXITCODE){throw 'Explicit staging failed.'}
$names=@(git diff --cached --name-only)
if(!$names.Count){throw 'No reviewed source changes staged.'}
foreach($name in $names){
 if($name -notmatch '^(README[.]md|tools/publish-cloud-read[.]ps1|apps/(cloud-shop-read|business-callback-receiver)/)'){throw 'Unreviewed staged path.'}
 if($name -match '(?i)([.]dpapi$|[.]private/|[.]env$|authorization[.]enc$|vault[.]key$|[.]crt$|[.]key$|[.]log$)'){throw 'Private artifact refused.'}
}
git commit -m 'Add cloud shop read API and disabled Business callback receiver'
if($LASTEXITCODE){throw 'Commit failed; inspect before retrying.'}
git -c http.proxy=http://127.0.0.1:10808 push -u origin $Branch
if($LASTEXITCODE){throw 'Push outcome requires remote readback; do not blindly republish.'}
git status --short
git rev-parse HEAD
