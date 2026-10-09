param(
    [switch]$NoBrowser,
    [ValidateRange(1024, 65535)][int]$Port = 8766
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$taskPython = $null
$taskPythonArguments = @()
$taskBundledPython = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$taskCandidates = @()

# The bundled interpreter matches the optional packages prepared on this laptop.
if ((Test-Path -LiteralPath (Join-Path $PSScriptRoot '.deps')) -and (Test-Path -LiteralPath $taskBundledPython)) {
    $taskCandidates += @{ Path = $taskBundledPython; Arguments = @() }
}
$taskVenv = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (Test-Path -LiteralPath $taskVenv) { $taskCandidates += @{ Path = $taskVenv; Arguments = @() } }
$taskPyCommand = Get-Command py.exe -ErrorAction SilentlyContinue
if ($taskPyCommand) { $taskCandidates += @{ Path = $taskPyCommand.Source; Arguments = @('-3') } }
$taskPythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
if ($taskPythonCommand -and ($taskPythonCommand.Source -notmatch '\\WindowsApps\\')) {
    $taskCandidates += @{ Path = $taskPythonCommand.Source; Arguments = @() }
}
if (Test-Path -LiteralPath $taskBundledPython) { $taskCandidates += @{ Path = $taskBundledPython; Arguments = @() } }

foreach ($taskCandidate in $taskCandidates) {
    try {
        & $taskCandidate.Path @($taskCandidate.Arguments) -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>$null
        if ($LASTEXITCODE -eq 0) {
            $taskPython = $taskCandidate.Path
            $taskPythonArguments = @($taskCandidate.Arguments)
            break
        }
    } catch { continue }
}
if (-not $taskPython) {
    Write-Host 'Python 3.10 or newer was not found. Install Python, then run start.cmd again.' -ForegroundColor Red
    exit 1
}

Write-Host "Personal Voice AI Assistant: http://127.0.0.1:$Port" -ForegroundColor Green
Write-Host 'Keep this window open. Press Ctrl+C to stop the assistant.'
$taskServer = Join-Path $PSScriptRoot 'server.py'
if ($NoBrowser) {
    & $taskPython @taskPythonArguments $taskServer --port $Port --no-browser
} else {
    # Opening a browser is intentional only when the user runs this launcher.
    $taskBootstrap = @'
import runpy, sys, threading, webbrowser
script_path, port = sys.argv[1:3]
sys.argv = [script_path, '--port', port]
threading.Timer(1.5, lambda: webbrowser.open('http://127.0.0.1:' + port)).start()
runpy.run_path(script_path, run_name='__main__')
'@
    & $taskPython @taskPythonArguments -c $taskBootstrap $taskServer ([string]$Port)
}
exit $LASTEXITCODE
