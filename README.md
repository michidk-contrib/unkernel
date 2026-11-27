# Android on unkernel

An Android-focused fork of [pithings/unkernel](https://github.com/pithings/unkernel).
The target is a full Android system with its graphical interface running on the
WebAssembly Linux kernel, initially through Node for bring-up and then in a browser.

**Android does not boot to its graphical interface yet.** The first working
milestone is Android Bionic userspace: the Android dynamic linker, mksh shell,
Toybox commands, and child processes execute inside the AArch64 wasm guest.
The pinned upstream kernel has no Android Binder IPC devices or binderfs, which
blocks the framework and its system services.

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

The static demo boots the same real Android Bionic fixture and opens an
interactive xterm.js terminal. It does not display the Android graphical
interface. Choose 512 MiB, 1 GiB or 2 GiB before starting; Stop releases the VM,
and starting again creates a fresh session. The demo currently has no network
relay configured.

```sh
bun run android:prepare
bun run check:pages
bun run build:pages
```

`dist-pages/` is the complete static site. All assets use relative URLs, so it
works at a GitHub Pages project path as well as the domain root. The build
preserves SDK module paths, packages the pinned Android filesystem with file
modes and symlinks, and includes a checksum for the compressed fixture.
A COI service worker provides isolation on Pages. Use a current Chromium browser
with WebAssembly JSPI; the first visit can reload once to activate isolation.

`.github/workflows/pages.yml` installs Bun and Node 24, prepares the verified
fixture, checks types, runs the real Android VM integration test, builds the
site, and deploys its artifact through GitHub Pages. It runs on pushes to
`feat/android` and `main`, or manually. Enable Pages with **GitHub Actions** as
the source, and allow the deployment branch in the `github-pages` environment.
No kernel compilation or multi-gigabyte Android image download is needed.
