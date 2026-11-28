# Android on unkernel

An Android-focused fork of [pithings/unkernel](https://github.com/pithings/unkernel).
The target is a full Android system with its graphical interface running on the
WebAssembly Linux kernel, initially through Node for bring-up and then in a browser.

Android 13 / LineageOS 20 now completes boot on the Android kernel build and
has rendered Android activities through Wayland. The current browser profile
replaces Trebuchet with Browser Home, a small launcher with hardware acceleration
disabled. The packaged-image Node harness has verified launcher readiness,
Settings rendering, pointer navigation and Android HTTPS through WISP. Browser
performance remains experimental. The full-system harness checks `sys.boot_completed=1`, real app activities and rendered pixels.
The small Bionic fixture remains a separate kernel compatibility test.

This is an independent clone on `feat/android`. Side by Side is unchanged.
The upstream desktop/demo frontend, its assets, its pnpm workspace and lockfile,
and its release workflow have been removed. The kernel, CPU emulator, SDK,
guest tools, graphics bridges, tests and license notices remain.

## Run the verified milestone

Requires Bun, Node 24+ with JSPI, curl, sha256sum and dpkg-deb. No host root
permissions, Docker, Android SDK or Android source build are needed for this check.
All guest mounts and Android execution happen inside unkernel.

```sh
bun install --frozen-lockfile
bun run android:prepare
bun run android:probe
bun run test:android
bun run typecheck
```

The preparation command verifies SHA-256 checksums for the upstream kernel and
Termux's AOSP Bionic libraries/utilities. It downloads about 23 MB into ignored
`vendor/android/`. These small Android 9 binaries are a compatibility fixture,
not a substitute for an Android system image or an APK runtime.

The probe reports the real guest architecture, Android binary output, Binder
nodes, binderfs support, and detected blockers. It stops the VM after the check.

```sh
# Exit 0 only if the Bionic check and the current framework prerequisite probes pass.
# The pinned baseline exits 2 and reports missing Binder IPC.
bun run android:check

# Test a kernel built with Android support instead of the pinned baseline.
ANDROID_KERNEL=/absolute/path/to/unkernel.wasm bun run android:check
```

Passing the prerequisite probe alone does not establish that the Android
framework or graphical interface boots. The probe currently detects the first
known kernel prerequisite, rather than every Android requirement.

## Full Android bring-up

`guest/android/images.json` pins a matched-architecture Android 13 / LineageOS 20
Waydroid VANILLA system image and MAINLINE vendor image, with their official OTA
URLs and ZIP checksums. They are recorded for the next bring-up stage; the small
fixture command does not download them. The two ZIPs total about 1.06 GB and
need additional space when extracted.

The next required work is:

1. Build and test an Android-capable kernel with Binder IPC, binderfs or the
   three Binder device nodes, and the required Android kernel interfaces.
2. Mount the system/vendor images with writable data and runtime filesystems,
   then execute Android init as PID 1 in the guest environment. Diagnose actual
   init, property service, APEX/linker configuration and service-manager failures.
3. Bring up ART/zygote and system_server. Integrate the vendor graphics HAL and
   SurfaceFlinger with a verified graphics path and guest input.
4. Show the Android interface in the browser and verify touch, keyboard,
   networking, application startup and lifecycle behavior.

Use `./setup.sh --check` before rebuilding the kernel. A full engine build also
needs Zig 0.16, LLVM 21+ with a patched wasm-ld, and the build prerequisites it
lists. The retained kernel/guest documentation and `.agents/` explain the build
and patch workflow. Do not launch a full AOSP build as an implicit dependency;
start from the pinned prebuilt images.

## Attribution

unkernel is by Pooya Parsa and its other upstream contributors. This fork retains
its GPL and MIT licenses and third-party notices. Android fixture binaries are
retrieved from Termux's public repository and retain their own upstream licenses.
Waydroid image metadata comes from its public OTA feeds; no Waydroid application
code is copied into this fork.

## Browser demo and GitHub Pages

The static demo boots the full Android 13 system and presents its Wayland display
with wland, the same compositor used by Side by Side. The VM reserves 2 GiB of
RAM. A cold boot takes several minutes, depending on the host CPU and disk
fetches. The emulator runs in a worker so startup does not block the page.
Android apps still use software graphics on the emulated CPU and can respond
slowly. The display uses the browser cursor to avoid distorted Wayland cursor
buffers. Stop discards guest changes. Network settings support configurable WISP
relays or offline operation. WISP is enabled by default, using the same public
relays as Side by Side; configure a trusted relay for private testing. The Android
launcher has a “Check internet” action that requests HTTPS from inside Android.
A saved relay setting alone does not establish that Android networking works.
See [Android graphics](guest/android/graphics.md) for the GPU driver requirements.

The image workflow converts pinned Waydroid ARM64 system/vendor images to EROFS,
retaining the 64-bit runtime and enforcing a 900 MB disk budget. The browser reads
these disks with HTTP Range requests. The Pages build requires these artifacts
and the Android kernel with Binder and BPF support:

```sh
# Requires JDK 17 and ANDROID_HOME with platform 33 and build-tools 35.0.0.
bash guest/android/launcher/build.sh
bun run check:pages
ANDROID_KERNEL=/path/to/android/unkernel.wasm \
UNKERNEL_BUNDLE=/path/to/android/unkernel.wasm bun run build:pages
bun run test:pages
```

Place the compressed images and `images.json` in `vendor/android/web/` first.
`test:pages` boots the exact packaged kernel and compressed disks, checks the
launcher and Settings, and opens Network & internet through the Wayland pointer path.
Set `ANDROID_WISP=wss://your-relay/` to also require a successful HTTPS request
from Browser Home. The browser settings accept repeated `wisp` URL parameters
and `net=off` for offline links. They are also saved in local browser storage.

The minimal profile hides the camera, gallery, recorder, calendar, wallpapers,
Trebuchet, updater and other optional apps in a disposable overlay. This reduces
package scanning and background work, but does not shrink the downloaded disk.
The profile also removes init service definitions for unsupported 32-bit system
and vendor binaries, which otherwise repeatedly fail and restart in the ARM64 guest.
Browser Home offers Settings, installed apps, a tap counter and an Internet check.
The system compositor still uses software Vulkan; launcher changes alone do not
establish a system-wide performance improvement.

`dist-pages/` is the complete static site, with relative asset URLs for project
paths. A COI service worker provides browser isolation on Pages. Use a current
Chromium browser with WebAssembly JSPI; the first visit may reload once.

The Pages workflow downloads the pinned kernel and compressed image artifacts,
builds a cold-boot site, exports prepared data only after the launcher draws,
then rebuilds and checks prepared boot and pointer input before upload. Prepared
data is bound to the kernel, image manifest, startup scripts and launcher APK
by a checksum. Rebuild the launcher before packaging the site. A changed launcher
or profile invalidates old prepared data and falls back to a cold boot.
The page selects up to four CPUs only when the kernel bundle contains its SMP
variant. The first successful launch saves a compressed initial Android state
on this device. Later launches can restore it instead of repeating Android
initialization. Both cold and restored startup wait for window focus and a
response from the launcher UI thread. A failed restore falls back to cold boot.
Kernel and image byte ranges are also cached by build identity, without
downloading the complete disks in advance. Browser storage can be evicted or
unavailable, so saving is best effort. Clear saved startup removes the initial
state while retaining downloaded system files. Stop still discards session
changes. See [startup analysis and verification](guest/android/boot-performance.md)
for the causes of slow boot, cache behavior and measurement limits.
Enable Pages with **GitHub Actions** as the source and allow `feat/android` in the
`github-pages` environment. The managed GitHub App cannot enable Pages in this
repository; that setting requires the repository owner.
