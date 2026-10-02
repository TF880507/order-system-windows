#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")" && pwd)"
sdk_root="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
: "${sdk_root:?請先設定 ANDROID_SDK_ROOT 或 ANDROID_HOME}"
: "${JAVA_HOME:?請先設定 JAVA_HOME}"
platform="$sdk_root/platforms/android-35/android.jar"
tools="$sdk_root/build-tools/36.0.0"
zxing="$project_dir/libs/zxing-core-3.5.3.jar"
stage="${TMPDIR:-/tmp}/hao-shi-ji-apk-build"
build="$stage/build"
classes="$build/classes"
dex="$build/dex"
signing="$project_dir/signing"
keystore="$signing/hao-shi-ji-release.jks"
password_file="$signing/password.txt"
output="${1:-$project_dir/HaoShiJi-Order-App.apk}"

for required in "$platform" "$tools/aapt2" "$tools/aapt" "$tools/d8" "$tools/zipalign" "$tools/apksigner" "$zxing"; do
  [[ -e "$required" ]] || { echo "缺少 Android 建置工具：$required" >&2; exit 1; }
done
rm -rf "$stage"
mkdir -p "$classes" "$dex" "$signing"
cp -R "$project_dir/AndroidManifest.xml" "$project_dir/res" "$project_dir/src" "$stage/"
password="$(cat "$password_file")"
find "$stage/src" -name '*.java' -print0 | xargs -0 "$JAVA_HOME/bin/javac" -encoding UTF-8 -source 8 -target 8 -bootclasspath "$platform" -classpath "$zxing" -d "$classes"
class_files=()
while IFS= read -r -d '' file; do class_files+=("$file"); done < <(find "$classes" -name '*.class' -print0)
"$tools/d8" "${class_files[@]}" "$zxing" --lib "$platform" --min-api 23 --output "$dex"
"$tools/aapt2" compile --dir "$stage/res" -o "$build/resources.zip"
"$tools/aapt2" link -o "$build/unsigned.apk" -I "$platform" --manifest "$stage/AndroidManifest.xml" -R "$build/resources.zip" --auto-add-overlay --min-sdk-version 23 --target-sdk-version 35 --version-code 4 --version-name 4.0
(cd "$dex" && "$tools/aapt" add "$build/unsigned.apk" classes.dex)
"$tools/zipalign" -f -p 4 "$build/unsigned.apk" "$build/aligned.apk"
"$tools/apksigner" sign --min-sdk-version 23 --ks "$keystore" --ks-key-alias hao-shi-ji --ks-pass "pass:$password" --key-pass "pass:$password" --out "$build/signed.apk" "$build/aligned.apk"
"$tools/apksigner" verify --verbose --print-certs "$build/signed.apk"
cp "$build/signed.apk" "$output"
echo "APK=$output"
