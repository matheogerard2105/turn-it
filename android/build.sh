#!/bin/sh
# Construit android/turnit.apk sans Gradle, avec les outils du SDK Android.
# Usage : ./android/build.sh [adresse-du-serveur]   (par défaut : IP locale de ce Mac, port 3000)
set -e
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BT="$SDK/build-tools/$(ls "$SDK/build-tools" | sort -V | tail -1)"
JAR="$SDK/platforms/$(ls "$SDK/platforms" | sort -V | tail -1)/android.jar"
SERVER="${1:-http://$(ipconfig getifaddr en0 2>/dev/null || echo localhost):3000}"

rm -rf build && mkdir -p build/gen build/classes build/apk/assets
cp -R ../public build/apk/assets/www
printf 'window.TURNIT_CONFIG = { app: true, server: "%s" };\n' "$SERVER" > build/apk/assets/www/config.js

"$BT/aapt2" compile --dir res -o build/res.zip
"$BT/aapt2" link -o build/base.apk -I "$JAR" --manifest AndroidManifest.xml build/res.zip --java build/gen -A build/apk/assets
javac -source 11 -target 11 -nowarn -classpath "$JAR" -d build/classes $(find src build/gen -name '*.java') 2>&1 | grep -v "warning" || true
"$BT/d8" --min-api 24 --lib "$JAR" --output build $(find build/classes -name '*.class')
(cd build && cp base.apk unsigned.apk && zip -q unsigned.apk classes.dex)
"$BT/zipalign" -f -p 4 build/unsigned.apk build/aligned.apk

KS="$HOME/.android/turnit-debug.keystore"
[ -f "$KS" ] || keytool -genkeypair -keystore "$KS" -storepass android -keypass android -alias turnit \
  -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Turn It" >/dev/null 2>&1
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --out turnit.apk build/aligned.apk
echo "APK prêt : android/turnit.apk (serveur en ligne : $SERVER)"
