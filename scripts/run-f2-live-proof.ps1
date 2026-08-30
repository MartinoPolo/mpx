param(
  [switch]$ConfirmLive,
  [string]$ConfirmPhrase,
  [string]$PlanFile,
  [string]$PlanExportKey,
  [string]$PlanKey,
  [ValidateRange(1,300)][int]$InvocationTimeoutSeconds = 30
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Confirmation = 'RUN MPX F2 LIVE PROOF'
$Sha = '^[a-f0-9]{64}$'
$Profiles = @('open','deny-all','delivery','implementation','minimal','research')
function Fail([string]$Code) { throw $Code }
function Get-FileSha256([string]$File) { (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() }
function ConvertTo-CanonicalJson($Value) {
  if ($null -eq $Value) { return 'null' }
  if ($Value -is [string]) { return ConvertTo-Json $Value -Compress }
  if ($Value -is [bool]) { return $(if ($Value) { 'true' } else { 'false' }) }
  if ($Value -is [System.Collections.IDictionary]) { $names=@($Value.Keys) }
  elseif ($Value -is [pscustomobject]) { $names=@($Value.PSObject.Properties.Name) }
  elseif ($Value -is [System.Collections.IEnumerable]) { return '['+[String]::Join(',',@($Value|ForEach-Object { ConvertTo-CanonicalJson $_ })) +']' }
  else { return [Convert]::ToString($Value,[Globalization.CultureInfo]::InvariantCulture) }
  return '{'+[String]::Join(',',@($names|Sort-Object|ForEach-Object { (ConvertTo-Json ([string]$_) -Compress)+':'+(ConvertTo-CanonicalJson $Value.$_) }))+'}'
}
function Get-CanonicalSha256($Value) { $bytes=[Text.Encoding]::UTF8.GetBytes((ConvertTo-CanonicalJson $Value));$hasher=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$hasher.Dispose()} }
function Get-TextSha256([string]$Text) { $bytes=[Text.Encoding]::UTF8.GetBytes($Text);$hasher=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$hasher.Dispose()} }
function Assert-Exact($Value,[string[]]$Names,[string]$Label) {
  $actual=@($Value.PSObject.Properties.Name|Sort-Object);$expected=@($Names|Sort-Object)
  if ([String]::Join(',', $actual) -cne [String]::Join(',', $expected)) { Fail "PLAN_EXPORT_INVALID:$Label" }
}
function Assert-SafeText([string]$Value,[string]$Label,[int]$Maximum=256) {
  if ([string]::IsNullOrEmpty($Value) -or $Value.Length -gt $Maximum -or $Value -match "[`r`n`0]" -or $Value -match '(?i)(authorization|token|secret|credential|password|api[_-]?key|CLAUDE_CONFIG_DIR|PI_CODING_AGENT_DIR)' -or $Value -match '^(?:[A-Za-z]:[\\/]|\\\\|/)') { Fail "PLAN_EXPORT_PRIVATE:$Label" }
}
function Stop-ProcessTree([int]$ProcessId) { & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null }
function Invoke-SbxBounded([string[]]$Arguments,[string]$Label,[int]$MaximumBytes=65536) {
  $stdout=Join-Path ([IO.Path]::GetTempPath()) ("mpx-f2-{0}.out" -f [Guid]::NewGuid().ToString('N'));$stderr="$stdout.err";$process=$null;$primary=$null
  try {
    $launchFile=$sbx;$launchArguments=$Arguments
    # Test fixtures use a command shim; the pinned production executable is always sbx.exe.
    if([IO.Path]::GetExtension($sbx) -ieq '.cmd'){$launchFile=$env:ComSpec;$launchArguments=@('/d','/s','/c',('"{0}"' -f $sbx))+@($Arguments)}
    $process=Start-Process -FilePath $launchFile -ArgumentList $launchArguments -WorkingDirectory $repositoryRoot -NoNewWindow -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr;$null=$process.Handle
    $deadline=[DateTime]::UtcNow.AddSeconds($InvocationTimeoutSeconds)
    while(-not $process.WaitForExit(50)){
      if(([IO.FileInfo]$stdout).Exists -and ([IO.FileInfo]$stdout).Length -gt $MaximumBytes){Stop-ProcessTree $process.Id;Fail "$Label`_OUTPUT_LIMIT"}
      if(([IO.FileInfo]$stderr).Exists -and ([IO.FileInfo]$stderr).Length -gt $MaximumBytes){Stop-ProcessTree $process.Id;Fail "$Label`_OUTPUT_LIMIT"}
      if([DateTime]::UtcNow -ge $deadline){Stop-ProcessTree $process.Id;Fail "$Label`_TIMEOUT"}
    }
    $process.WaitForExit();$process.Refresh();$exitCode=[int]$process.ExitCode
    $out=if(Test-Path -LiteralPath $stdout){Get-Content -LiteralPath $stdout -Raw -Encoding UTF8}else{''};$err=if(Test-Path -LiteralPath $stderr){Get-Content -LiteralPath $stderr -Raw -Encoding UTF8}else{''};if($null-eq$out){$out=''};if($null-eq$err){$err=''}
    if([Text.Encoding]::UTF8.GetByteCount([string]$out)-gt $MaximumBytes -or [Text.Encoding]::UTF8.GetByteCount([string]$err)-gt $MaximumBytes){Fail "$Label`_OUTPUT_LIMIT"}
    return [pscustomobject]@{ExitCode=$exitCode;Stdout=$out;Stderr=$err}
  } catch {$primary=$_;throw} finally {Remove-Item -LiteralPath $stdout,$stderr -Force -ErrorAction SilentlyContinue}
}
if ([string]::IsNullOrWhiteSpace($PlanFile) -or [string]::IsNullOrWhiteSpace($PlanExportKey)) { Fail 'PLAN_EXPORT_REQUIRED' }
if ($PlanExportKey -cnotmatch $Sha) { Fail 'PLAN_EXPORT_REQUIRED' }
$repositoryRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$resolvedPlan=[IO.Path]::GetFullPath($PlanFile)
if (-not (Test-Path -LiteralPath $resolvedPlan -PathType Leaf)) { Fail 'PLAN_EXPORT_REQUIRED' }
$info=Get-Item -LiteralPath $resolvedPlan
if ($info.Length -lt 2 -or $info.Length -gt 1048576 -or $info.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) { Fail 'PLAN_EXPORT_INVALID' }
try { $document=Get-Content -LiteralPath $resolvedPlan -Raw -Encoding UTF8 | ConvertFrom-Json }
catch { Fail 'PLAN_EXPORT_INVALID' }
if (@($document.PSObject.Properties.Name) -contains 'apiVersion') {
  Assert-Exact $document @('apiVersion','ok','data','warnings') 'envelope'
  if (-not ($document.apiVersion -is [int]) -or $document.apiVersion -ne 1 -or -not ($document.ok -is [bool]) -or -not $document.ok -or $null -eq $document.data -or -not ($document.warnings -is [array]) -or $document.warnings.Count -ne 0) { Fail 'PLAN_EXPORT_INVALID:envelope' }
  $plan=$document.data
} else { $plan=$document }
Assert-Exact $plan @('schemaVersion','exportKey','launchKey','descriptorSha256','runtime','identity','artifact','evidence','sandbox','policyMatrix') 'root'
if ($plan.schemaVersion -ne 1 -or $plan.runtime -notin @('claude','pi')) { Fail 'PLAN_EXPORT_INVALID' }
foreach($digest in @($plan.exportKey,$plan.launchKey,$plan.descriptorSha256,$plan.artifact.manifestKey,$plan.artifact.artifactKey,$plan.artifact.fileMapHash,$plan.evidence.sbxPinSha256,$plan.evidence.runtimeToolInventorySha256,$plan.evidence.executorEvidenceSha256,$plan.sandbox.planKey)){if($digest -cnotmatch $Sha){Fail 'PLAN_EXPORT_INVALID'}}
Assert-Exact $plan.identity @('name','domain') 'identity';Assert-Exact $plan.artifact @('manifestKey','artifactKey','fileMapHash') 'artifact';Assert-Exact $plan.evidence @('sbxPinSha256','runtimeToolInventorySha256','executorEvidenceSha256') 'evidence';Assert-Exact $plan.sandbox @('planKey','profile','proofSandboxName','createArgv') 'sandbox'
Assert-SafeText $plan.identity.name 'identity';if($plan.identity.domain -notin @('personal','work')){Fail 'PLAN_EXPORT_INVALID'}
if($plan.sandbox.proofSandboxName -cnotmatch '^mpx-proof-[a-f0-9]{12}$' -or $plan.sandbox.proofSandboxName -cne "mpx-proof-$($plan.sandbox.planKey.Substring(0,12))" -or $plan.sandbox.profile -notin $Profiles){Fail 'PLAN_EXPORT_INVALID'}
$tuple=[ordered]@{schemaVersion=1;launchKey=$plan.launchKey;descriptorSha256=$plan.descriptorSha256;runtime=$plan.runtime;identity=$plan.identity;artifact=$plan.artifact;evidence=$plan.evidence;sandbox=$plan.sandbox;policyMatrix=$plan.policyMatrix}
if((Get-CanonicalSha256 $tuple) -cne $plan.exportKey -or $plan.exportKey -cne $PlanExportKey){Fail 'PLAN_EXPORT_KEY_MISMATCH'}
$argv=@($plan.sandbox.createArgv);if($argv.Count -lt 5 -or $argv.Count -gt 64 -or $argv[0] -cne 'create' -or $argv[1] -cne '--name' -or @($argv|Where-Object{$_ -ceq '--name'}).Count -ne 1 -or @($argv|Where-Object{$_ -ceq '--profile'}).Count -ne 0){Fail 'PLAN_ARGV_INVALID'}
foreach($arg in $argv){Assert-SafeText ([string]$arg) 'argv' 1024};if(-not (@($argv)|Where-Object{$_ -in @('shell','claude')})){Fail 'PLAN_ARGV_INVALID'}
if(@($plan.policyMatrix).Count -ne 1){Fail 'POLICY_MATRIX_INVALID'}
$expectedDecisions=[Collections.Generic.List[object]]::new()
$entry=$plan.policyMatrix[0];Assert-Exact $entry @('profile','default','targets') 'policy[0]';if($entry.profile -cne $plan.sandbox.profile -or $entry.default -notin @('allow','deny') -or (($entry.profile -ceq 'open') -ne ($entry.default -ceq 'allow')) -or @($entry.targets).Count -lt 1 -or @($entry.targets).Count -gt 32){Fail 'POLICY_MATRIX_INVALID'};$prior='';$hasDeny=$false;foreach($target in $entry.targets){Assert-Exact $target @('target','decision') 'target';if($target.target -cnotmatch '^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?:(?:[1-9]\d{0,4})$' -or $target.target -cle $prior -or $target.decision -notin @('allow','deny')){Fail 'POLICY_MATRIX_INVALID'};$prior=$target.target;if($target.target -ceq 'blocked.invalid:443' -and $target.decision -ceq 'deny'){$hasDeny=$true};$expectedDecisions.Add([ordered]@{profile=$entry.profile;target=$target.target;decision=$target.decision})};if(($entry.default -ceq 'deny' -and -not $hasDeny) -or ($entry.default -ceq 'allow' -and @($entry.targets|Where-Object{$_.decision -ceq 'deny'}).Count -gt 0)){Fail 'POLICY_MATRIX_INVALID'}
$evidenceRoot=Join-Path $repositoryRoot 'evidence'
if((Get-FileSha256 (Join-Path $evidenceRoot 'sbx-pin.json')) -cne $plan.evidence.sbxPinSha256){Fail 'SBX_PIN_DIGEST_DRIFT'}
$inventory=Get-Content -LiteralPath (Join-Path $evidenceRoot 'runtime-tool-inventory.json') -Raw|ConvertFrom-Json
if($inventory.runtimeToolInventorySha256 -cne $plan.evidence.runtimeToolInventorySha256 -or (Get-FileSha256 (Join-Path $evidenceRoot 'executor-evidence.ts')) -cne $plan.evidence.executorEvidenceSha256){Fail 'PACKAGED_EVIDENCE_DRIFT'}
if(-not $ConfirmLive -or $ConfirmPhrase -cne $Confirmation){Fail 'LIVE_PROOF_CONFIRMATION_REQUIRED'}
$sbx=$env:MPX_SBX_EXECUTABLE;if([string]::IsNullOrWhiteSpace($sbx)-or-not[IO.Path]::IsPathRooted($sbx)){Fail 'SBX_EXECUTABLE_REQUIRED'}
if((Get-FileSha256 $sbx)-cne'b064711a10f22363953e90eae926dbd9d96419e601f9308cd9d1102e3d81ccbf'){Fail 'SBX_BUILD_MISMATCH'}
$create=@($argv);$create[2]=$plan.sandbox.proofSandboxName;$decisions=[Collections.Generic.List[object]]::new();$claudeEvidence=$null;$created=$false;$primary=$null;$teardown=$null
Push-Location $repositoryRoot
try{
 # Read-only preflight. MPX never initializes the global policy; the human must
 # review and run `sbx policy init allow-all` once because it affects every sbx sandbox.
 $globalPolicy=Invoke-SbxBounded @('policy','ls','--json') 'SBX_GLOBAL_POLICY_PREFLIGHT' 65536;if($globalPolicy.ExitCode){Fail 'SBX_GLOBAL_POLICY_UNINITIALIZED'}
 $createResult=Invoke-SbxBounded $create 'SBX_CREATE' 65536;if($createResult.ExitCode){Fail 'SBX_CREATE_FAILED'};$created=$true
 $allowTargets=@($expectedDecisions|Where-Object{$_.decision -ceq 'allow'}|ForEach-Object{$_.target})
 if($entry.default -ceq 'deny' -and $allowTargets.Count -gt 0){$apply=Invoke-SbxBounded (@('policy','allow','network','--sandbox',$plan.sandbox.proofSandboxName)+$allowTargets) 'SBX_POLICY_APPLY' 65536;if($apply.ExitCode){Fail 'SBX_POLICY_APPLY_FAILED'}}
 foreach($want in $expectedDecisions){
  $checkResult=Invoke-SbxBounded @('policy','check','network','--sandbox',$plan.sandbox.proofSandboxName,$want.target,'--json') 'POLICY_CHECK' 65536;$checkText=$checkResult.Stdout.Trim();try{$check=$checkText|ConvertFrom-Json}catch{Fail 'POLICY_CHECK_MALFORMED'}
  $actualFields=@($check.PSObject.Properties.Name);$allowedFields=@('action','allowed','resource_value','type','deny_kind','reason','rule');$requiredFields=@('action','allowed','resource_value','type');if($actualFields|Where-Object{$_ -notin $allowedFields}){Fail 'POLICY_CHECK_MALFORMED'};foreach($required in $requiredFields){if($required -notin $actualFields){Fail 'POLICY_CHECK_MALFORMED'}}
  foreach($optional in @('deny_kind','reason','rule')){if($optional -in $actualFields -and (-not($check.$optional -is [string]) -or $check.$optional.Length -gt 1024 -or $check.$optional -match "[`r`n`0]")){Fail 'POLICY_CHECK_MALFORMED'}}
  if($check.action -cne 'net:connect:tcp' -or $check.type -cne 'network' -or $check.resource_value -cne $want.target -or -not($check.allowed -is [bool])){Fail 'POLICY_CHECK_MISMATCH'};$observedDecision=if($check.allowed){'allow'}else{'deny'}
  $hasDenyFields=@(@('deny_kind','reason','rule')|Where-Object{$_ -in $actualFields}).Count -gt 0
  if($observedDecision -cne $want.decision -or ($observedDecision -ceq 'allow' -and $checkResult.ExitCode -ne 0) -or ($observedDecision -ceq 'deny' -and $checkResult.ExitCode -eq 0) -or ($observedDecision -ceq 'allow' -and $hasDenyFields)){Fail "POLICY_CHECK_MISMATCH:$($want.target):${observedDecision}:$($checkResult.ExitCode):$hasDenyFields"}
  $decisions.Add([ordered]@{profile=$want.profile;target=$want.target;decision=$observedDecision;count=1})
 }
 if($plan.runtime -ceq 'claude'){$identities=[Collections.Generic.List[object]]::new();foreach($identityName in @('personal','work')){$captured=[ordered]@{};foreach($checkName in @('enrollment','credential-isolation','opposite-identity-denial')){$worker=Invoke-SbxBounded @('exec',$plan.sandbox.proofSandboxName,'mpx-f2-proof-worker','claude-evidence','--identity',$identityName,'--app-name',"mpx-claude-$identityName",'--check',$checkName,'--json') 'CLAUDE_EVIDENCE' 65536;$observation=$worker.Stdout.Trim();if($worker.ExitCode -or [string]::IsNullOrEmpty($observation)){Fail 'CLAUDE_EVIDENCE_FAILED'};$captured[$checkName]=Get-TextSha256 $observation};$signature=Get-TextSha256 ([String]::Join("`n",@($captured.enrollment,$captured.'credential-isolation',$captured.'opposite-identity-denial')));$identities.Add([ordered]@{identity=$identityName;appNamespace="mpx-claude-$identityName";enrollmentEvidenceSha256=$captured.enrollment;isolationEvidenceSha256=$captured.'credential-isolation';oppositeIdentityDenialEvidenceSha256=$captured.'opposite-identity-denial';captureSignatureSha256=$signature})};$claudeEvidence=[ordered]@{source='live';identities=@($identities)}}
}catch{$primary=$_}finally{if($created){try{$remove=Invoke-SbxBounded @('rm','--force',$plan.sandbox.proofSandboxName) 'SBX_TEARDOWN' 65536;if($remove.ExitCode){Fail 'SBX_TEARDOWN_FAILED'}}catch{try{Fail "SBX_TEARDOWN_FAILED:$($_.Exception.Message)"}catch{$teardown=$_}}};Pop-Location}
if($primary){if($teardown){throw "$($primary.Exception.Message); teardown: $($teardown.Exception.Message)"};throw $primary};if($teardown){throw $teardown}
$reportTuple=[ordered]@{schemaVersion=2;planExportKey=$plan.exportKey;launchKey=$plan.launchKey;descriptorSha256=$plan.descriptorSha256;runtime=$plan.runtime;identity=$plan.identity;artifact=$plan.artifact;evidence=$plan.evidence;sandbox=$plan.sandbox;policyMatrix=$plan.policyMatrix;decisions=@($decisions);builtInClaudeEvidence=$claudeEvidence;verdict='pass'}
$report=[ordered]@{schemaVersion=2;reportKey=(Get-CanonicalSha256 $reportTuple);planExportKey=$plan.exportKey;launchKey=$plan.launchKey;descriptorSha256=$plan.descriptorSha256;runtime=$plan.runtime;identity=$plan.identity;artifact=$plan.artifact;evidence=$plan.evidence;sandbox=$plan.sandbox;policyMatrix=$plan.policyMatrix;decisions=@($decisions);builtInClaudeEvidence=$claudeEvidence;verdict='pass'}
Write-Output(ConvertTo-Json $report -Depth 16 -Compress)
