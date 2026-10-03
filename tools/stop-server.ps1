$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\', '/')
$projectPrefix = $projectRoot.Replace('/', '\') + '\'

# Match both the tsx parent and its Node child, using this repository's absolute
# path and the exact server entry point. Other Node applications stay running.
$servers = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
    $command = ([string]$_.CommandLine).Replace('/', '\')
    $command.IndexOf($projectPrefix, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $command -match '(?i)(?:^|[\s"\\])apps\\server\\main\.ts(?:[\s"]|$)'
})

if (-not $servers.Count) {
    Write-Host 'No existing Crash Lab server is running for this repository.'
    exit 0
}

$serverIds = @($servers | ForEach-Object { [int]$_.ProcessId })
Write-Host "Stopping existing Crash Lab server (PID $($serverIds -join ', '))..."
foreach ($serverId in $serverIds) {
    try {
        Stop-Process -Id $serverId -Force -ErrorAction Stop
    } catch {
        # A tsx parent may exit when its child is stopped.
        if (Get-Process -Id $serverId -ErrorAction SilentlyContinue) { throw }
    }
}
foreach ($serverId in $serverIds) {
    if (Get-Process -Id $serverId -ErrorAction SilentlyContinue) {
        Wait-Process -Id $serverId -Timeout 10 -ErrorAction Stop
    }
}
Write-Host 'Previous Crash Lab server stopped.'
