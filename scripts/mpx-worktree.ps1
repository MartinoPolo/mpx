# Dot-source this file to define mpxw. It performs no action when loaded.
function mpxw {
    $destination = (& mpx workspace show --machine @args)
    if ($LASTEXITCODE -ne 0) { return }
    if ([string]::IsNullOrWhiteSpace($destination)) { return }
    Set-Location -LiteralPath $destination
}
