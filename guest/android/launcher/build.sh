#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
# A small platform-only APK; no Gradle or external Android libraries.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
sdk="${ANDROID_HOME:?Set ANDROID_HOME to an Android SDK with platform 33 and build-tools 35.0.0}"
tools="$sdk/build-tools/35.0.0"
platform="$sdk/platforms/android-33/android.jar"
out="$root/vendor/android/launcher"
mkdir -p "$out"
work="$(mktemp -d "$out/build.XXXXXX")"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/classes" "$work/dex"
javac --release 8 -classpath "$platform" -d "$work/classes" "$root/guest/android/launcher/HomeActivity.java"
"$tools/aapt2" link -I "$platform" --manifest "$root/guest/android/launcher/AndroidManifest.xml" -o "$work/home.apk"
"$tools/d8" --lib "$platform" --min-api 26 --output "$work/dex" "$work"/classes/dev/unkernel/home/*.class
(cd "$work/dex" && zip -q "$work/home.apk" classes.dex)
if [ ! -f "$out/development.p12" ]; then
    keytool -genkeypair -keystore "$out/development.p12" -storepass android -keypass android -alias android -dname 'CN=unkernel development' -keyalg RSA -keysize 2048 -validity 10000
fi
"$tools/apksigner" sign --ks "$out/development.p12" --ks-pass pass:android --out "$out/home.apk" "$work/home.apk"
"$tools/apksigner" verify "$out/home.apk"
echo "Built $out/home.apk"
