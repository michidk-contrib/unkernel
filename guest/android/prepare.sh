#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
# Download only the small Android Bionic fixture and known baseline kernel.
set -euo pipefail
. "$(dirname "$0")/../lib/env.sh"
. "$guest/android/pins.sh"
for tool in curl sha256sum dpkg-deb; do
	command -v "$tool" >/dev/null || { echo "Missing required tool: $tool" >&2; exit 1; }
done
fixture="$vendor/android"
mkdir -p "$fixture/downloads"
fetch_verified "$ANDROID_PROBE_REPOSITORY/pool/main/a/aosp-libs/aosp-libs_${ANDROID_PROBE_VERSION}_aarch64.deb" \
	"$fixture/downloads/aosp-libs.deb" "$ANDROID_PROBE_LIBS_SHA256"
fetch_verified "$ANDROID_PROBE_REPOSITORY/pool/main/a/aosp-utils/aosp-utils_${ANDROID_PROBE_VERSION}_aarch64.deb" \
	"$fixture/downloads/aosp-utils.deb" "$ANDROID_PROBE_UTILS_SHA256"
fetch_verified "https://github.com/pithings/unkernel/releases/download/$ANDROID_PROBE_KERNEL_VERSION/unkernel.wasm" \
	"$fixture/unkernel.wasm" "$ANDROID_PROBE_KERNEL_SHA256"
# SDK builds require the matching renderer files even when a probe has no GPU.
release="https://github.com/pithings/unkernel/releases/download/$ANDROID_PROBE_KERNEL_VERSION"
fetch_verified "$release/virgl.mjs" "$build/gl-wasm/virgl.mjs" "$ANDROID_PROBE_GL_JS_SHA256"
fetch_verified "$release/virgl.wasm" "$build/gl-wasm/virgl.wasm" "$ANDROID_PROBE_GL_WASM_SHA256"
fetch_verified "$release/kwvk-naga.wasm" "$build/vk/kwvk-naga.wasm" "$ANDROID_PROBE_VK_NAGA_SHA256"
# Keep the SDK build's default bundle in sync without replacing a local kernel build.
if [ ! -e "$base_bundle" ]; then
	mkdir -p "$(dirname "$base_bundle")"
	ln -s "$fixture/unkernel.wasm" "$base_bundle"
fi
# This tree contains only downloaded fixture files. Never replace a user-provided rootfs.
stage="$(mktemp -d "$fixture/rootfs.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
dpkg-deb -x "$fixture/downloads/aosp-libs.deb" "$stage"
dpkg-deb -x "$fixture/downloads/aosp-utils.deb" "$stage"
ln -s data/data/com.termux/files/usr/opt/aosp "$stage/system"
mkdir -p "$stage/dev" "$stage/proc" "$stage/sys"
printf '%s\n' "$ANDROID_PROBE_VERSION" > "$stage/.unkernel-android-fixture"
if [ -e "$fixture/rootfs" ]; then
	[ -f "$fixture/rootfs/.unkernel-android-fixture" ] || { echo "Refusing to replace an unmarked rootfs: $fixture/rootfs" >&2; exit 1; }
	# A previously prepared fixture is disposable; keep other Android images outside it.
	rm -rf "$fixture/rootfs"
fi
mv "$stage" "$fixture/rootfs"
printf 'Android Bionic fixture ready. Run: bun run android:probe\n'
