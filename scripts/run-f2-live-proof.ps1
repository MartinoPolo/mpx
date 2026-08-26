param(
  [switch]$ConfirmLive,
  [string]$ConfirmPhrase,
  [string]$SbxPinSha256,
  [string]$RuntimeToolInventorySha256,
  [string]$ExecutorEvidenceSha256,
  [string]$PlanKey
)
$ErrorActionPreference = 'Stop'
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
try {
  & $sbx create --name $name --profile deny-all shell (Get-Location).Path
  if ($LASTEXITCODE) { throw 'SBX_CREATE_FAILED' }
  # Mount output is the v0.39 substitute for the unavailable no-shared-skills flag.
  $mountEvidence = & $sbx exec $name mount
  if ($mountEvidence -match '[/\\](\.claude|\.pi|skills)([/\\]|\s)') { throw 'SHARED_SKILLS_MOUNTED' }
  & $sbx policy check network --sandbox $name blocked.invalid:443 --json | Out-Null
  & $sbx policy log $name --json | Out-Null
} finally {
  & $sbx rm --force $name | Out-Null
}
Write-Output '{"schemaVersion":1,"status":"live-evidence-captured","sanitized":true}'
