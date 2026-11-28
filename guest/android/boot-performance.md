# Android startup and caching

## Why startup repeats expensive work

The guest mounts `/android/data` as a new tmpfs on every cold boot. Stopping
destroys Android's package database, resource overlays and ART's writable
runtime data. Retaining the downloaded system image alone cannot retain that
work. The ARM64 userspace also runs on an emulated CPU, including Android's
software graphics and shader compiler. Network caching cannot remove that CPU
work. Browser Home avoids hardware acceleration for its own views, but
SurfaceFlinger and other applications still use the software Vulkan driver.

Before this change, the Pages manifest explicitly disabled checkpoints. The
prepared-data archive was also out of date for the current launcher/profile,
so the build correctly omitted it. Every launch therefore initialized Android
again. HTTP disks kept chunks only in their current VM and otherwise relied
on ordinary HTTP caching. The preview server supplied no image validator.

## Cache behavior

The isolation service worker now also caches the kernel and requested system
and vendor byte ranges. Their URLs include the build identity, covering the
kernel, runtime, launcher and image manifest. Range responses retain their
206 status and Content-Range headers when read back. Only the downloaded
ranges are stored; startup does not download all 741 MiB in advance. Old build
caches are removed. Quota and storage errors fall back to network requests.

A local startup checkpoint retains Android's initialized memory, including
its tmpfs data and initialized software graphics. The page captures only
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
