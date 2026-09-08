$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$ownedPathsFile = Join-Path $repositoryRoot 'packages/installer/src/windows-owned-paths.json'
$ownedPaths = Get-Content -LiteralPath $ownedPathsFile -Raw | ConvertFrom-Json

foreach ($name in $ownedPaths) {
    if ([string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($name, 'Process'))) {
        $value = [Environment]::GetEnvironmentVariable($name, 'User')
        if (-not [string]::IsNullOrEmpty($value)) {
            [Environment]::SetEnvironmentVariable($name, $value, 'Process')
        }
    }
}

if ([string]::IsNullOrEmpty($env:MPX_NODE_EXECUTABLE) -or
    -not [System.IO.Path]::IsPathRooted($env:MPX_NODE_EXECUTABLE) -or
    -not (Test-Path -LiteralPath $env:MPX_NODE_EXECUTABLE -PathType Leaf)) {
    throw 'The existing MPX_NODE_EXECUTABLE Windows setting must identify an installed Node executable.'
}

& $env:MPX_NODE_EXECUTABLE (Join-Path $repositoryRoot 'bin/mpx.mjs') setup
exit $LASTEXITCODE
