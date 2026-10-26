# build.ps1 - Automated C++ to Wasm Build Script (Ninja-powered)

$EmsdkPath = "..\web\emsdk" 

Write-Host "==> Activating Emscripten SDK..." -ForegroundColor Cyan
if (Test-Path "$EmsdkPath\emsdk_env.ps1") {
    & "$EmsdkPath\emsdk_env.ps1" | Out-Null
} else {
    Write-Error "Could not find emsdk_env.ps1 at $EmsdkPath. Please check your path."
    exit 1
}

# 1. Clean the old build directory to avoid generator cache conflicts
$BuildDir = "sim-core\build"
if (Test-Path $BuildDir) {
    Write-Host "==> Cleaning old build directory..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force $BuildDir
}
New-Item -ItemType Directory -Path $BuildDir | Out-Null

Set-Location $BuildDir

# 2. Configure CMake using Ninja (the gold standard for Emscripten)
Write-Host "==> Configuring CMake with Ninja generator..." -ForegroundColor Cyan
emcmake cmake .. -G "Ninja"

if ($LASTEXITCODE -ne 0) {
    Write-Error "CMake configuration failed."
    Set-Location "..\.."
    exit 1
}

# 3. Compile the C++ code to WebAssembly
Write-Host "==> Compiling C++ to WebAssembly..." -ForegroundColor Cyan
cmake --build .

if ($LASTEXITCODE -ne 0) {
    Write-Error "Compilation failed."
    Set-Location "..\.."
    exit 1
}

# 4. Return to root and copy artifacts to Next.js public/wasm directory
Set-Location "..\.." 
$TargetDir = "web-app\public\wasm"
if (!(Test-Path $TargetDir)) {
    New-Item -ItemType Directory -Path $TargetDir | Out-Null
}

Write-Host "==> Copying build artifacts to Next.js public/wasm..." -ForegroundColor Cyan
Copy-Item "sim-core\build\sim-core.js" -Destination "$TargetDir\" -Force
Copy-Item "sim-core\build\sim-core.wasm" -Destination "$TargetDir\" -Force

Write-Host "Build complete! Wasm artifacts successfully updated." -ForegroundColor Green