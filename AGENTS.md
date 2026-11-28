# AGENTS.md

## Android fork

This checkout targets a full Android graphical system on unkernel. It is separate
from Side by Side and the package-demo design. Work is on `feat/android`.

### Product direction

Build a compelling demonstration of a real Android system running locally in a
browser, then make it useful for trying and testing Android apps. Put the live
Android display and session controls first. Preserve startup progress, clear
failure states and downloadable diagnostics. Never present a drawn but frozen
launcher as a usable session.

The first target is minimal ARM64 Android based on the pinned Waydroid VANILLA
image, with a small software-rendered launcher, Settings and a touch demo. Keep
Android's framework, permissions, package installer and networking services for
future APK testing. Avoid Google services, widgets and unnecessary bundled apps.
Do not add distribution choices until each choice passes a real interaction
check. Reducing background work does not establish a graphics speedup.

Internet access should use configurable WISP relays, following Side by Side's
settings model. Include an offline mode, validate relay URLs and distinguish
relay configuration from verified Android connectivity. App testing and APK
upload must be verified against Android's package manager and actual app launch.
Keep the site statically deployable on GitHub Pages.

Single APKs can come from local files or an `apk` URL parameter. URL downloads
run in Android through WISP, without requiring the source host to support CORS.
Keep the 64 MiB limit, HTTPS-only redirects and bounded downloads. The optional
F-Droid preset uses a pinned official release and checksum. Install apps only
after capturing and saving the clean startup checkpoint; app data still expires
on Stop. Do not claim that arbitrary apps or the complete F-Droid catalog work
merely because a package installed successfully.

Keep successive launches fast by retaining immutable downloads and a verified
initial startup checkpoint, rather than preserving arbitrary user sessions.
Version caches with the actual kernel, images and runtime. Restore must pass
the same display and UI-thread checks as cold boot, with a cold-boot fallback.
Record timestamped startup phases and distinguish native measurements from
browser measurements. Never promise a fast repeat launch when saving failed.

- Keep the kernel, CPU emulator, SDK, graphics bridges, guest tools and licenses.
  The upstream desktop/demo website and upstream release workflow were removed.
  `pages/` is the focused full Android graphical demo, deployed by the Pages workflow.
- `guest/android/` owns Android bring-up. `bun run android:prepare` downloads a
  pinned Bionic fixture. `bun run test:android` runs real Android-linked binaries
  in the wasm guest. `bun run android:check` also requires the currently probed
  framework prerequisites and exits 2 when they are missing.
- The Bionic fixture is a kernel compatibility check, not a booted Android system.
  Do not claim Android UI, APKs, ART or SurfaceFlinger work until actually verified.
- Use Bun. Do not restore the removed pnpm workspace or lockfile.
- Use a feature branch and the managed signed GitHub API publication flow when
  asked to publish. Do not publish to main. Preserve upstream attribution.
- Keep unsupported 32-bit system and vendor executables out of Android init's service
  list. Otherwise init continuously respawns programs this ARM64 guest cannot run.
- Diagnose live JSPI guests using bounded logs and screenshots. Attaching the
  Node inspector has crashed this Node/V8 build while a JSPI guest was active.

The following upstream notes describe the retained engine and build system.

unkernel runs Linux 7.3, compiled to a single wasm module (`arch/wasm` with an
MMU), in Node 24 or a browser with JSPI. User space is unmodified aarch64
Linux ELF (ARMv8.0-A with FP, AdvSIMD and the crypto, CRC32 and LSE
extensions; a64/isa.md), run by kwemu, a software CPU in Zig linked
into the kernel: the AArch64 front end (src/a64: a reference interpreter, a
decoded-op tier and a wasm JIT) on an ISA-neutral MMU, block cache and JIT
core (src/emu). Its contract with the kernel is `include/kw_emu.h` (ABI 3).
The kernel bundle (`unkernel.wasm`) carries a small base initramfs that
boots a distro image (Alpine or Debian, read-only erofs, attached as a disk)
under an overlay root, or the base shell without one. README.md is the overview,
kernel/README.md maps the kernel directory and its build steps, and
guest/README.md the guest side (base initramfs, distro images, guest
programs).

`.agents/` has one file per area. Read the one for the area you change:

| File | Covers |
| --- | --- |
| [.agents/kernel.md](.agents/kernel.md) | kernel tree and patch workflow, `kw_emu.h` contract, memory model, JSPI, host imports, IRQs, arm64 user ABI, the two builds and two kernels; `.agents/kernel/` holds SMP, parking and snapshots, devices, config, kernel tests, guest images |
| [.agents/a64.md](.agents/a64.md) | the AArch64 CPU (src/a64): layout, group-file conventions, adding instructions, tests; `.agents/a64/` holds instruction semantics and the coverage tool (`isa.md`), the decoded-op tier (`tier.md`), the JIT (`jit.md`), numbers, rejected designs and levers (`performance.md`) |
| [.agents/kwemu.md](.agents/kwemu.md) | the ISA-neutral core: MMU and TLBs, block cache, JIT core (regions, invariants, SMP, compile window, host contract), softfloat, measuring, rejected designs |
| [.agents/js.md](.agents/js.md) | the SDK (`js/`): rules, build checks, disks, network stack and Wisp |
| [.agents/data-disk.md](.agents/data-disk.md) | the persistent data disk, overlay root, safe mode, image updates |
| [.agents/toolchain.md](.agents/toolchain.md) | patched wasm-ld, Binaryen, Zig 0.16, host tools, pinned downloads |
| [.agents/testing.md](.agents/testing.md) | quick checks per area, CLI exit codes, the full matrix, release CI |
| [.agents/gl.md](.agents/gl.md) | guest GL through virgl on WebGL2 (branch `webgl`): plan, measurements, headless tests |
| [.agents/vk.md](.agents/vk.md) | guest Vulkan on WebGPU (kwvk): the ICD, the host renderer, the SPIR-V translator, the relay and headless tests |
| [.agents/va.md](.agents/va.md) | guest VA-API on WebCodecs (kwva): the libva driver, the host decoder and its codecs (VP9, H.264, AV1, HEVC), decoders other than the modelled one, zero-copy output (dmabuf export into virtio-gpu resources), the relay and headless tests |
| [.agents/x64.md](.agents/x64.md) | x86-64 and i386 guest binaries: box64 and qemu-user behind binfmt_misc, what runs and what does not, measurements, a native front end and its references |
| [.agents/status.md](.agents/status.md) | roadmap and open issues; read only for planning, or when asked |

## Building and testing

```sh
./setup.sh                  # check prerequisites, then zig build + kernel/build.sh all
zig build test              # A64 unit tests and guests against qemu-aarch64
kernel/build.sh kernel      # the UP kernel, refreshes the bundle (smp: the SMP kernel)
node js/cli.ts              # boot Alpine (vendor/build/distro) on the bundle; --help lists options
```

Run the quick check for what you changed (testing.md, Quick checks); the
full matrix is for releases or when asked. Do not run the browser tests
(`web/test/`) unless asked.

`vendor/` (gitignored) holds the kernel tree `vendor/src/linux-wasm-kernel`
(branch `kw-arm64-user`), `vendor/src/llvm22`, the toolchain and all build
outputs; `kernel/patches/` is the only durable record of those branches.

## Easy to break

These cut across areas; each area file lists its own invariants.

- Bump `KW_ABI_VERSION` on any layout or semantic change to
  `include/kw_emu.h` (kernel.md).
- `kw_defconfig` is maintained by hand and Kconfig drops options silently:
  check `$KOUT/.config` after changing it.
- Never use `switch_root` in the guest's init: it empties rootfs, the
  overlay's lower layer (data-disk.md).
- Never clear the IndexedDB store `kwdisk:kwdata-v1` in code or tests: it
  is the user's persistent disk (data-disk.md).

## Changing things

- **Kernel**: commit on `kw-arm64-user` in `vendor/src/linux-wasm-kernel`,
  then export so that `kernel/patches/linux/` equals
  `format-patch -N 7595a62d45e..kw-arm64-user` (kernel.md).
- **wasm-ld**: commit in `vendor/src/llvm22`, run `kernel/build.sh
  toolchain`, and re-export (toolchain.md).
- **Guest image**: `kernel/build.sh base` (the base initramfs and the
  bundle) or `kernel/build.sh distro [NAME]` (the images and
  `distros.json`); guest/README.md.
- **Page**: `bun run build:pages` packages the pinned Android fixture and SDK.
  `.github/workflows/pages.yml` deploys the static example on GitHub Pages.

## Conventions

- Commit messages are imperative sentences, optionally prefixed with an
  area (`web: `); kernel patches use kernel style (kernel.md). No
  `Signed-off-by` lines.
- New files get an SPDX header and a copyright line: GPL-2.0-or-later,
  except MIT for JavaScript (`js/`, `web/`, SDK tests) and GPL-2.0-only
  for kernel patches.
- If a change contradicts a statement in a doc, fix that statement in the
  same commit. Do not audit the docs or document new details unless asked.
  Docs describe the current state (no history, no commit hashes); date
  measurements.
