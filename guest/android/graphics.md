# Android graphics and browser GPU acceleration

The Android runtime selects ANGLE GLES over the vendor's `vulkan.pastel.so`
software Vulkan driver. The browser's WebGPU bridge, kwvk, currently supports
Linux Vulkan clients. Enabling `vk: true` in the SDK does not redirect Android's
Vulkan loader or accelerate the Android compositor.

## Why selecting kwvk would fail

- `vk/icd/build.sh` builds an ARM64 **glibc** library. Android processes use
  Bionic and discover a hardware module under `/vendor/lib64/hw/`, with an
  exported `HMI` module descriptor and the `hwvulkan_device_t` entry points.
  The existing ICD exports Linux loader entry points instead.
- Android's loader implements `VK_KHR_swapchain` on top of the driver's
  `VK_ANDROID_native_buffer` extension. kwvk does not advertise or implement
  that extension. Its Wayland/X11 swapchains do not replace the Android
  loader's buffer-queue integration.
- Android swapchain images carry `VkNativeBufferANDROID` handles in image
  creation/binding chains. kwvk's `vkBindImageMemory2` currently ignores its
  arguments, and its image texels live only in host WebGPU textures.
  Mapping a kwvk image's nominal Vulkan memory does not expose those texels.
- Android clients also sample buffers produced by other processes through
  EGLImages. ANGLE's Android hardware-buffer support needs
  `VK_ANDROID_external_memory_android_hardware_buffer` and
  `VK_EXT_queue_family_foreign`. kwvk provides neither. Supporting only
  swapchain output would leave this input path incomplete.

These are source-level findings, not a failed Android GPU boot experiment.
No Android GPU driver was built or selected during this assessment.

## Smallest complete implementation to test

A first implementation can keep the existing software gralloc and Wayland
composer. It still needs all of the following:

1. Cross-build kwvk against an Android NDK Bionic sysroot and export the Android
   Vulkan HAL ABI. Preserve the dispatchable-object loader magic and check the
   installed module with Android's actual Vulkan loader.
2. Implement `VK_ANDROID_native_buffer`, including gralloc usage queries,
   image creation and the image-binding `pNext` path. Access shared buffers
   through the gralloc mapper API, checking format, stride and lifetime rather
   than assuming the first native-handle FD is tightly packed RGBA.
3. Implement acquisition and release with correct ownership and synchronization.
   A synchronous implementation can wait for and close an incoming acquire
   fence, complete host work and copy pixels into gralloc on release, then
   return release FD `-1`, meaning the work has already completed. This avoids
   manufacturing hardware sync fences. It does not permit skipping waits.
4. Import Android hardware buffers used as sampled EGLImages, with the matching
   external-memory properties, allocation/binding chains and foreign-queue
   ownership handling. CPU-written buffers must upload before sampling;
   GPU-written buffers must become visible before another process reads them.
5. Check ANGLE's actual shader and extension use against the WebGPU backend.
   Verify a textured Android native window, then SurfaceFlinger composition,
   Launcher, app switching and input while checking host WebGPU error reports.
   Test shared-buffer contents across two Android processes and resize/reuse.

The existing host `present` request can read an image back after earlier submits
have passed validation, so the first output path can reuse that transport.
It would still copy every presented image through guest memory. Removing that
copy requires an additional Android composer/gralloc integration with the
browser's external-buffer path.

## Source references

The Android ABI and loader behavior were checked against AOSP
`android-13.0.0_r1`:

- [Vulkan HAL ABI](https://android.googlesource.com/platform/frameworks/native/+/refs/tags/android-13.0.0_r1/vulkan/include/hardware/hwvulkan.h)
- [Native-buffer extension](https://android.googlesource.com/platform/frameworks/native/+/refs/tags/android-13.0.0_r1/vulkan/include/vulkan/vk_android_native_buffer.h)
- [Android Vulkan loader](https://android.googlesource.com/platform/frameworks/native/+/refs/tags/android-13.0.0_r1/vulkan/libvulkan/driver.cpp)
- [ANGLE extension selection](https://android.googlesource.com/platform/external/angle/+/refs/tags/android-13.0.0_r1/src/libANGLE/renderer/vulkan/RendererVk.cpp)

The checked-in implementation is in `vk/icd/icd.c`, `vk/icd/wsi.c` and
`vk/icd/build.sh`. Its host transport contract is `vk/PROTOCOL.md`.

## Browser cursor fallback

The Android page uses the browser's standard pointer and hides only Wayland
surfaces explicitly identified by cursor events. This keeps pointer movement
independent of guest redraws and leaves the guest's click coordinates unchanged.

This is a workaround for an upstream presentation limitation. Wland accepts
`wp_viewport` source crops and reports destination dimensions, but its browser
view scales the full buffer instead of applying the source crop. Waydroid uses
those crops for padded cursor buffers, so the arrow can become a narrow line.
The workaround does not implement viewport cropping for other surfaces.

Relevant pinned upstream sources:

- [Wland's documented cropping limitation](https://github.com/pithings/wland/blob/6617578/README.md)
- [Wland viewport destination bookkeeping](https://github.com/pithings/wland/blob/6617578/core/src/compositor.zig)
- [Wland WebAssembly surface-size exports](https://github.com/pithings/wland/blob/6617578/core/src/wasm.zig)

The page workaround is implemented in `pages/cursor.ts`, through wland's public
`onEvent` callback. Correct generic cropping needs source-rectangle information
exposed by the compositor and used by its browser presenter.

## Software rendering stalls

A rendered launcher is not sufficient evidence that Android accepts input. In
the browser check, Android received mouse events at the expected coordinates,
but its launcher failed to acknowledge them within its 50-second timeout.
Earlier launcher thread dumps show the UI thread waiting for HWUI's RenderThread,
which waits for pastel Vulkan presentation. Its queue worker was compiling
SwiftShader setup routines in LLVM. This can block application input even while
the browser page and its native cursor remain responsive.

SwiftShader's LLVM optimization level is a build-time setting,
`REACTOR_DEFAULT_OPT_LEVEL`. No runtime optimization switch was verified. Android
HWUI also supports `debug.hwui.renderer=skiavk`, which bypasses ANGLE for new app
processes while retaining the software Vulkan driver. That alternative has not
passed an Android interaction check and is not selected by the demo.
