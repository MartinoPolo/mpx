param(
  [switch]$ConfirmLive,
  [string]$ConfirmPhrase,
  [string]$SbxPinSha256,
  [string]$RuntimeToolInventorySha256,
  [string]$ExecutorEvidenceSha256,
  [string]$PlanKey
)
$ErrorActionPreference = 'Stop'
function Get-TextSha256([string]$Text) { [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Text))).ToLowerInvariant() }
function ConvertTo-CanonicalJson($Value) {
  if ($null -eq $Value) { return 'null' }
  if ($Value -is [string]) { return (ConvertTo-Json $Value -Compress) }
  if ($Value -is [bool]) { return $(if ($Value) { 'true' } else { 'false' }) }
  if ($Value -is [System.Collections.IDictionary]) { return '{' + [String]::Join(',', @($Value.Keys | Sort-Object | ForEach-Object { (ConvertTo-Json ([string]$_) -Compress) + ':' + (ConvertTo-CanonicalJson $Value[$_]) })) + '}' }
  if ($Value -is [System.Collections.IEnumerable]) { return '[' + [String]::Join(',', @($Value | ForEach-Object { ConvertTo-CanonicalJson $_ })) + ']' }
  return [string]$Value
}
$sha = '^[a-f0-9]{64}$'
if (-not $ConfirmLive -or $ConfirmPhrase -cne 'RUN MPX F2 LIVE PROOF' -or
    $SbxPinSha256 -cnotmatch $sha -or $RuntimeToolInventorySha256 -cnotmatch $sha -or
    $ExecutorEvidenceSha256 -cnotmatch $sha -or $PlanKey -cnotmatch $sha) {
  throw 'LIVE_PROOF_CONFIRMATION_REQUIRED: pass -ConfirmLive, the exact phrase, and all four current digests.'
}
$sbx = $env:MPX_SBX_EXECUTABLE
if (-not [System.IO.Path]::IsPathRooted($sbx)) { throw 'MPX_SBX_EXECUTABLE must be an absolute pinned sbx.exe path.' }
if ((Get-FileHash -LiteralPath $sbx -Algorithm SHA256).Hash.ToLowerInvariant() -cne 'b064711a10f22363953e90eae926dbd9d96419e601f9308cd9d1102e3d81ccbf') { throw 'SBX_BUILD_MISMATCH' }
if ((Get-FileHash -LiteralPath 'docs/inventory/SBX_V0_39_0.json' -Algorithm SHA256).Hash.ToLowerInvariant() -cne $SbxPinSha256) { throw 'SBX_PIN_DIGEST_DRIFT' }
if ((Get-FileHash -LiteralPath 'docs/inventory/PHASE_F1_RUNTIME_TOOL_INVENTORY.json' -Algorithm SHA256).Hash.ToLowerInvariant() -cne $RuntimeToolInventorySha256) { throw 'RUNTIME_TOOL_INVENTORY_DRIFT' }
if ((Get-FileHash -LiteralPath 'packages/executors/src/index.ts' -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExecutorEvidenceSha256) { throw 'EXECUTOR_EVIDENCE_DRIFT' }
$status = & $sbx daemon status --json | ConvertFrom-Json
if ($status.status -ne 'running') { throw 'DAEMON_NOT_RUNNING: start it manually only after separate review; this script never starts or resets it.' }
$name = "mpx-proof-$($PlanKey.Substring(0,12))"
$inventory = Get-Content -LiteralPath 'docs/inventory/PHASE_F1_RUNTIME_TOOL_INVENTORY.json' -Raw | ConvertFrom-Json
$checks = [System.Collections.Generic.List[string]]::new()
$claudeIdentities = [System.Collections.Generic.List[object]]::new()
try {
  & $sbx create --name $name --profile deny-all shell (Get-Location).Path
  if ($LASTEXITCODE) { throw 'SBX_CREATE_FAILED' }
  # Mount output is the v0.39 substitute for the unavailable no-shared-skills flag.
  $mountEvidence = & $sbx exec $name mount
  if ($mountEvidence -match '[/\\](\.claude|\.pi|skills)([/\\]|\s)') { throw 'SHARED_SKILLS_MOUNTED' }
  $checks.Add('mount-isolation')
  foreach ($profile in @('deny-all','minimal','implementation','delivery','research')) {
    & $sbx policy check network --sandbox $name blocked.invalid:443 --profile $profile --json | Out-Null
    if ($LASTEXITCODE) { throw "POLICY_CHECK_FAILED:$profile" }
    $checks.Add("policy:$profile")
  }
  & $sbx policy log $name --json | Out-Null
  # The reviewed image must provide this disposable proof worker. It performs no provider delivery
  # unless the selected test route points to a disposable repository/account.
  foreach ($entry in $inventory.entries) {
    & $sbx exec $name mpx-f2-proof-worker inventory --path $entry.path --json | Out-Null
    if ($LASTEXITCODE) { throw "INVENTORY_PATH_FAILED:$($entry.path)" }
    $checks.Add("inventory:$($entry.path)")
  }
  foreach ($scenario in @('clone-fetch','host-worktree-git-boundary','local-services','resume-after-manual-daemon-restart','disposable-provider-delivery')) {
    & $sbx exec $name mpx-f2-proof-worker scenario --name $scenario --json | Out-Null
    if ($LASTEXITCODE) { throw "SCENARIO_FAILED:$scenario" }
    $checks.Add("scenario:$scenario")
  }
  # Each identity/check is captured independently. Only digests and a capture signature enter the report.
  foreach ($identity in @('personal','work')) {
    $captured = [ordered]@{}
    foreach ($check in @('enrollment','credential-isolation','opposite-identity-denial')) {
      $observation = (& $sbx exec $name mpx-f2-proof-worker claude-evidence --identity $identity --app-name "mpx-claude-$identity" --check $check --json | Out-String).Trim()
      if ($LASTEXITCODE -or -not $observation) { throw "CLAUDE_EVIDENCE_FAILED:$identity`:$check" }
      $captured[$check] = Get-TextSha256 $observation
      $checks.Add("claude:$identity`:$check")
    }
    $signature = Get-TextSha256 ([String]::Join("`n", @($captured['enrollment'],$captured['credential-isolation'],$captured['opposite-identity-denial'])))
    $claudeIdentities.Add([ordered]@{identity=$identity;appNamespace="mpx-claude-$identity";enrollmentEvidenceSha256=$captured['enrollment'];isolationEvidenceSha256=$captured['credential-isolation'];oppositeIdentityDenialEvidenceSha256=$captured['opposite-identity-denial'];captureSignatureSha256=$signature})
  }
} finally {
  & $sbx rm --force $name | Out-Null
  if ($LASTEXITCODE) { throw 'SBX_TEARDOWN_FAILED' }
}
$joined = [String]::Join("`n", ($checks | Sort-Object -Unique))
$checkDigest = Get-TextSha256 $joined
$tuple = [ordered]@{schemaVersion=1;planKey=$PlanKey;sbxPinSha256=$SbxPinSha256;runtimeToolInventorySha256=$RuntimeToolInventorySha256;executorEvidenceSha256=$ExecutorEvidenceSha256;attestationSha256=$checkDigest;builtInClaudeEvidence=[ordered]@{source='live';identities=@($claudeIdentities)};verdict='pass'}
$report = [ordered]@{schemaVersion=1;reportKey=(Get-TextSha256 (ConvertTo-CanonicalJson $tuple));planKey=$PlanKey;sbxPinSha256=$SbxPinSha256;runtimeToolInventorySha256=$RuntimeToolInventorySha256;executorEvidenceSha256=$ExecutorEvidenceSha256;attestationSha256=$checkDigest;builtInClaudeEvidence=$tuple.builtInClaudeEvidence;verdict='pass'}
Write-Output (ConvertTo-Json -Depth 8 -Compress -InputObject $report)
