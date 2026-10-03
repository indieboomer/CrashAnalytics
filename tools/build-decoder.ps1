param([string]$SdkPath = '')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $SdkPath) {
    $localEnv = Join-Path $projectRoot '.env'
    if (Test-Path -LiteralPath $localEnv) {
        foreach ($line in Get-Content -LiteralPath $localEnv) {
            if ($line -match '^\s*AFTERMATH_SDK_PATH\s*=\s*(.*?)\s*$') {
                $SdkPath = $Matches[1].Trim('"', "'")
            }
        }
    }
}
if (-not $SdkPath) { $SdkPath = $env:AFTERMATH_SDK_PATH }
if (-not $SdkPath) { throw 'Set AFTERMATH_SDK_PATH in local .env or pass -SdkPath.' }
$SdkPath = (Resolve-Path -LiteralPath $SdkPath).Path
if (-not (Test-Path -LiteralPath (Join-Path $SdkPath 'include\GFSDK_Aftermath_GpuCrashDumpDecoding.h'))) {
    throw 'SDK path must contain include\GFSDK_Aftermath_GpuCrashDumpDecoding.h.'
}
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Install Visual Studio C++ Build Tools with the Desktop development with C++ workload.' }
$instances = (& $vswhere -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -format json | Out-String | ConvertFrom-Json)
$instance = $instances | Sort-Object installationVersion -Descending | Select-Object -First 1
if (-not $instance) { throw 'No Visual Studio instance with x64 C++ tools found.' }
$major = ([version]$instance.installationVersion).Major
switch ($major) {
    18 { $generator = 'Visual Studio 18 2026' }
    17 { $generator = 'Visual Studio 17 2022' }
    default { throw "Unsupported Visual Studio version: $major. Use Visual Studio 2022 or 2026." }
}
$candidates = @((Join-Path $instance.installationPath 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'))
$systemCmake = Get-Command cmake -ErrorAction SilentlyContinue
if ($systemCmake) { $candidates += $systemCmake.Source }
$cmake = $null
foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
        $helpText = & $candidate --help | Out-String
        if ($helpText.Contains($generator)) { $cmake = $candidate; break }
    }
}
if (-not $cmake) { throw "Install a CMake version supporting '$generator' (VS 2026 requires CMake 4.2 or newer)." }
$source = Join-Path $projectRoot 'native\aftermath-decoder'
$build = Join-Path $source 'build'
Write-Host "Using $generator and $cmake"
& $cmake --fresh -S $source -B $build -G $generator -A x64 "-DCMAKE_GENERATOR_INSTANCE=$($instance.installationPath)" "-DAFTERMATH_SDK_PATH=$SdkPath"
if ($LASTEXITCODE -ne 0) { throw 'Decoder configuration failed.' }
& $cmake --build $build --config Release
if ($LASTEXITCODE -ne 0) { throw 'Decoder compilation failed.' }
$exe = Join-Path $build 'Release\aftermath-decoder.exe'
$runtimeDirectory = Join-Path $SdkPath 'lib\x64'
if (-not (Test-Path -LiteralPath (Join-Path $runtimeDirectory 'GFSDK_Aftermath_Lib.x64.dll'))) { $runtimeDirectory = Join-Path $SdkPath 'lib' }
$originalPath = $env:PATH
try {
    $env:PATH = "$runtimeDirectory;$originalPath"
    & $exe --version
    if ($LASTEXITCODE -ne 0) { throw 'Decoder runtime probe failed.' }
} finally { $env:PATH = $originalPath }
Write-Host "Built decoder: $exe"
Write-Host 'Set AFTERMATH_DECODER to this path in .env; Crash Lab uses AFTERMATH_SDK_PATH to locate the runtime DLL automatically.'
