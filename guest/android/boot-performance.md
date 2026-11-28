# Android startup and caching

## Why startup repeats expensive work

The guest mounts `/android/data` as a new tmpfs on every cold boot. Stopping
destroys Android's package database, resource overlays and ART's writable
runtime data. Retaining the downloaded system image alone cannot retain that
work. The ARM64 userspace also runs on an emulated CPU, including Android's
software graphics and shader compiler. Network caching cannot remove that CPU
work. Browser Home avoids hardware acceleration for its own views, but
SurfaceFlinger and other applications still use the software Vulkan driver.

Prepared `/data` retains package state and some ART caches, but still starts
zygote, system_server and software graphics. In one native measurement on
2026-11-28, it reduced launcher readiness from 374.9 to 249.7 seconds. It cannot
remove the several minutes spent initializing running processes. Normal builds
reject a missing or stale prepared-data archive before replacing the site.

## Prebooted first launch

The Pages pipeline now captures an initialized clean VM on the build machine.
`checkpoint-probe.ts` checks the launcher, captures and restores its state, and
requires a real Wayland click to produce Android HTTPS 200 before exporting it.
`pack-android-startup.ts` converts its gzip serialization to Zstandard to fit the
static site budget. The page verifies the artifact's size and SHA-256 before
decoding. Its identity covers the exact kernel, images, launcher and runtime
scripts. CPU and network-device configurations must match.

The capture's read-only disk paths belong to the build machine. Only for this
verified artifact, the page rebinds them to this deployment's build-addressed
HTTP URLs, expected image sizes and current HTTP validators. The SDK then
performs its usual kernel, disk and device checks. A device-local checkpoint
keeps its original disk validation and is never rebound. Offline mode uses
prepared boot because it has a different device configuration.

This moves Android initialization and checkpoint compression to the build
machine. Visitors still download the compressed checkpoint and the image ranges
required after restoring. The service worker retains the artifact by build
identity; storage errors fall back to network access. The initialized state is
clean and contains no uploaded APKs. Stop discards the session as before.

## Cache behavior

The isolation service worker now also caches the kernel and requested system
and vendor byte ranges. Their URLs include the build identity, covering the
kernel, runtime, launcher and image manifest. Range responses retain their
206 status and Content-Range headers when read back. Only the downloaded
ranges are stored; startup does not download all 741 MiB in advance. Old build
caches are removed. Quota and storage errors fall back to network requests.

A local startup checkpoint retains Android's initialized memory, including
its tmpfs data and initialized software graphics. Without a packaged artifact, the page captures only
after Home draws, has focus and responds on its UI thread. It temporarily
stops lmkd to release non-parkable PSI threads, captures the VM, restarts lmkd
and stores a compressed checkpoint in IndexedDB. Later launches restore that
initial state, reconnect Wayland and repeat the readiness checks. Open TCP
connections do not survive restoration; new connections use the configured WISP
relay. A failed or incompatible checkpoint falls back to a normal boot.

The identity also includes memory, CPU count and network configuration. Only
one startup checkpoint is retained. Stop still discards session changes. The
Clear saved startup button removes the checkpoint while retaining downloaded
system files. Browser storage eviction, private mode, a changed build or a
changed configuration can require another first startup.

Startup reports contain timestamped phases, including the first visible
Android pixels. Use these to separate download/compile time, Android
initialization, rendering and UI readiness on the user's actual browser.

## Verification

`guest/android/checkpoint-probe.ts` cold-boots the exact packaged disks, checks
Home's UI thread, snapshots, compresses and decodes using the same codec as
the browser, and restores into a fresh VM. With `ANDROID_WISP` set, a Wayland
pointer click must trigger a successful Android HTTPS request after restore.
Timings go to `/tmp/android-checkpoint-timing.json`. Set `ANDROID_CHECKPOINTS=0`
when building Pages to disable local VM checkpoints for troubleshooting. Run
one VM at a time:

```sh
ANDROID_WISP=wss://wisp.mercurywork.shop/ \
  timeout 1200 node guest/android/checkpoint-probe.ts
```

These are native Node measurements of the emulator and checkpoint path.
They exclude browser storage I/O and do not establish a browser speedup.

A completed run on 2026-11-28 used Node 26.12.1 on the shared AMD EPYC host,
with one emulated CPU and 2 GiB guest memory. Home's UI thread responded after
251.6 seconds cold and 29.8 seconds after restoring the serialized checkpoint,
including decompression and fresh VM creation. The 236.1 MiB checkpoint took
69.9 seconds to encode once. After restore, a real Wayland pointer click
triggered Android HTTPS through WISP and returned HTTP 200. The test exited 0.

This is one run, not an average or a browser benchmark. The cold timer begins
after initial kernel construction; the restore timer includes construction.
Neither path measures browser IndexedDB access or Internet image downloads.
The native result demonstrates that restoring initialized state avoids most
Android startup work; it does not promise a fixed startup time on other devices.

A separate native run on 2026-11-28 with prepared data reached Home in 248.5
seconds and restored the gzip checkpoint in 23.9 seconds. The serialized artifact
was 229.6 MiB. A real Wayland click after restore returned Android HTTPS 200.
This excludes HTTP checkpoint delivery and browser execution.

`guest/android/startup-probe.ts` verifies the distributed artifact through HTTP,
including download, browser-compatible decompression, disk rebinding, fresh VM
creation, visible launcher pixels, its UI-thread response and a Wayland click
that triggers Android HTTPS 200. Set `ANDROID_STARTUP_ORIGIN` to the packaged
site and run one VM at a time.

The distributed Zstandard artifact passed this HTTP probe on 2026-11-28.
Launcher readiness took 18.3 seconds, including local HTTP download, checksum
verification, browser-compatible Zstandard decoding and fresh VM creation.
A real Wayland click then returned Android HTTPS 200. The artifact is
171,710,691 bytes, and the complete site is 965,639,805 bytes, below the
990,000,000-byte budget. The test exited 0. These are native Node results
against a local HTTP server, not browser or Internet-download benchmarks.
