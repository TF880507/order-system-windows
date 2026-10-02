param(
  [string]$OutputName = 'HaoShiJi-Order-App.apk'
)

$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sdkRoot = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } elseif ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$platform = Join-Path $sdkRoot 'platforms\android-35\android.jar'
$buildTools = Join-Path $sdkRoot 'build-tools\36.0.0'
$aapt2 = Join-Path $buildTools 'aapt2.exe'
$aapt = Join-Path $buildTools 'aapt.exe'
$d8 = Join-Path $buildTools 'd8.bat'
$zipalign = Join-Path $buildTools 'zipalign.exe'
$apksigner = Join-Path $buildTools 'apksigner.bat'
$zxingJar = Join-Path $projectDir 'libs\zxing-core-3.5.3.jar'
$keytool = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin\keytool.exe' } else { '' }
if (-not $keytool -or -not (Test-Path -LiteralPath $keytool)) { $keytool = (Get-Command keytool.exe).Source }

foreach ($required in @($platform, $aapt2, $aapt, $d8, $zipalign, $apksigner, $keytool, $zxingJar)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "缺少 Android 建置工具：$required" }
}

$stageDir = Join-Path $env:TEMP 'hao-shi-ji-apk-build'
$buildDir = Join-Path $stageDir 'build'
$classesDir = Join-Path $buildDir 'classes'
$dexDir = Join-Path $buildDir 'dex'
$signingDir = Join-Path $projectDir 'signing'
$keystore = Join-Path $signingDir 'hao-shi-ji-release.jks'
$passwordFile = Join-Path $signingDir 'password.txt'
$unsignedApk = Join-Path $buildDir 'unsigned.apk'
$alignedApk = Join-Path $buildDir 'aligned.apk'
$signedApk = Join-Path $buildDir 'signed.apk'
$outputApk = Join-Path $projectDir $OutputName

function Assert-NativeSuccess([string]$step) {
  if ($LASTEXITCODE -ne 0) { throw "$step 失敗，結束代碼：$LASTEXITCODE" }
}

Remove-Item -LiteralPath $stageDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $outputApk -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $classesDir, $dexDir, $signingDir | Out-Null
Copy-Item -LiteralPath (Join-Path $projectDir 'AndroidManifest.xml') -Destination $stageDir
Copy-Item -LiteralPath (Join-Path $projectDir 'res') -Destination $stageDir -Recurse
Copy-Item -LiteralPath (Join-Path $projectDir 'src') -Destination $stageDir -Recurse

if (-not (Test-Path -LiteralPath $passwordFile)) {
  $password = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).Replace('+','A').Replace('/','B').Replace('=','C')
  Set-Content -LiteralPath $passwordFile -Value $password -NoNewline
} else {
  $password = Get-Content -LiteralPath $passwordFile -Raw
}

if (-not (Test-Path -LiteralPath $keystore)) {
  & $keytool -genkeypair -keystore $keystore -storepass $password -keypass $password -alias hao-shi-ji -keyalg RSA -keysize 2048 -validity 10000 -dname 'CN=Hao Shi Ji, OU=Order App, O=Hao Shi Ji, L=Taipei, C=TW'
  Assert-NativeSuccess '建立 APK 簽章金鑰'
}

$sources = Get-ChildItem -Path (Join-Path $stageDir 'src') -Recurse -Filter '*.java' | ForEach-Object { $_.FullName }
& javac -encoding UTF-8 -source 8 -target 8 -bootclasspath $platform -classpath $zxingJar -d $classesDir $sources
Assert-NativeSuccess '編譯 Android Java 程式'
$classFiles = Get-ChildItem -Path $classesDir -Recurse -Filter '*.class' | ForEach-Object { $_.FullName }
& $d8 $classFiles $zxingJar --lib $platform --min-api 23 --output $dexDir
Assert-NativeSuccess '產生 Android DEX'

$compiledResources = Join-Path $buildDir 'resources.zip'
& $aapt2 compile --dir (Join-Path $stageDir 'res') -o $compiledResources
Assert-NativeSuccess '編譯 Android 資源'
& $aapt2 link -o $unsignedApk -I $platform --manifest (Join-Path $stageDir 'AndroidManifest.xml') -R $compiledResources --auto-add-overlay --min-sdk-version 23 --target-sdk-version 35 --version-code 4 --version-name 4.0
Assert-NativeSuccess '封裝 Android 資源'
Push-Location $dexDir
try {
  & $aapt add $unsignedApk 'classes.dex'
  Assert-NativeSuccess '加入 Android DEX'
} finally { Pop-Location }
& $zipalign -f -p 4 $unsignedApk $alignedApk
Assert-NativeSuccess '對齊 APK'
& $apksigner sign --min-sdk-version 23 --ks $keystore --ks-key-alias hao-shi-ji --ks-pass "pass:$password" --key-pass "pass:$password" --out $signedApk $alignedApk
Assert-NativeSuccess '簽署 APK'
& $apksigner verify --verbose --print-certs $signedApk
Assert-NativeSuccess '驗證 APK 簽章'
Copy-Item -LiteralPath $signedApk -Destination $outputApk -Force
Write-Output "APK=$outputApk"
