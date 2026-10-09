param([switch]$SkipModel)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$taskPython = $null
$taskBundledPython = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
if (Test-Path -LiteralPath $taskBundledPython) { $taskPython = $taskBundledPython }
if (-not $taskPython -and (Get-Command py -ErrorAction SilentlyContinue)) {
    $taskPython = (& py -3 -c 'import sys; print(sys.executable)' 2>$null)
}
if (-not $taskPython -and (Get-Command python -ErrorAction SilentlyContinue)) {
    $taskPython = (& python -c 'import sys; print(sys.executable)' 2>$null)
}
if (-not $taskPython) {
    $taskBundledPython = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
    if (Test-Path -LiteralPath $taskBundledPython) { $taskPython = $taskBundledPython }
}
if (-not $taskPython) { throw 'Python 3.10 or newer is required. Install Python, then run this script again.' }
& $taskPython -m pip install --disable-pip-version-check --target .deps -r requirements-voice.txt
if ($LASTEXITCODE -ne 0) { throw 'Voice package installation failed. Check your internet connection.' }
if (-not $SkipModel) {
    & $taskPython -X utf8 prepare_voice.py
    if ($LASTEXITCODE -ne 0) { throw 'Model download failed. Check your internet connection and run setup again.' }
}
Write-Host 'Voice setup complete. Start the application with start.cmd.'
