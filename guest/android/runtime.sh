#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
# Runs inside the disposable unkernel guest, never on the host.
set -eu
format="${ANDROID_DISK_FORMAT:-ext4}"
case "$format" in ext4|erofs) ;; *) echo "Unsupported Android disk format: $format" >&2; exit 1;; esac
mkdir -p /android-lower /android-vendor-lower /android-rw /android
mount -t "$format" -o ro /dev/wda /android-lower
mount -t tmpfs -o size=256m tmpfs /android-rw
mkdir -p /android-rw/upper /android-rw/work
mount -t overlay overlay -o lowerdir=/android-lower,upperdir=/android-rw/upper,workdir=/android-rw/work /android
mount -t "$format" -o ro /dev/wdb /android-vendor-lower
mkdir -p /android-rw/vendor-upper /android-rw/vendor-work
mount -t overlay overlay -o lowerdir=/android-vendor-lower,upperdir=/android-rw/vendor-upper,workdir=/android-rw/vendor-work /android/vendor
# The CPU implements AArch64, so advertise and start only that Android ABI.
find /android/system /android/vendor -type f \( -name build.prop -o -name prop.default -o -name default.prop \) | while IFS= read -r prop; do
    sed -i -e 's/^\(ro\..*cpu\.abilist\)=.*/\1=arm64-v8a/' -e 's/^\(ro\..*cpu\.abilist32\)=.*/\1=/' -e 's/^ro.zygote=.*/ro.zygote=zygote64/' "$prop"
done
if [ ! -f /android/system/etc/init/hw/init.zygote64.rc ]; then
    awk '/^service zygote_secondary / {exit} !/restart zygote_secondary/ {print}' /android/system/etc/init/hw/init.zygote64_32.rc > /android/system/etc/init/hw/init.zygote64.rc
fi
# Use the software renderer modules present in this ARM64 vendor image.
for module in /android/vendor/lib64/hw/gralloc.default.so /android/vendor/lib64/hw/vulkan.pastel.so /android/vendor/lib64/egl/libEGL_angle.so; do
    [ -f "$module" ] || { echo "Missing software graphics module: $module" >&2; exit 1; }
done
cat >> /android/vendor/build.prop <<'PROPERTIES'
ro.hardware.gralloc=default
ro.hardware.egl=angle
ro.hardware.vulkan=pastel
ro.hardware.hwcomposer=waydroid
waydroid.xdg_runtime_dir=/run/wayland
waydroid.wayland_display=wayland-0
waydroid.background_start=false
waydroid.stub_sensors_hal=true
debug.hwui.renderer=skiagl
debug.sf.nobootanimation=1
sys.use_memfd=true
ro.hardware.audio.primary=default
ro.sf.lcd_density=160
PROPERTIES
# Use the supplied 64-bit audio implementations without the 32-bit HAL service.
for module in /android/vendor/lib64/hw/android.hardware.audio@4.0-impl.so /android/vendor/lib64/hw/android.hardware.audio.effect@4.0-impl.so /android/vendor/lib64/hw/audio.primary.default.so; do
    [ -f "$module" ] || { echo "Missing virtual audio module: $module" >&2; exit 1; }
done
# Audio normally runs in a vendor process. Its passthrough implementation needs
# these VNDK libraries exposed to the same-process HAL linker namespace as well.
vndk_audio_configured=false
for apex in /android/system/apex/com.android.vndk.*; do
    [ -d "$apex" ] || continue
    for list in "$apex"/etc/vndksp.libraries.*.txt; do
        [ -f "$list" ] || continue
        for library in libfmq.so libaudioutils.so libmedia_helper.so libtinyxml2.so; do
            [ -f "$apex/lib64/$library" ] || { echo "Missing audio VNDK library: $library" >&2; exit 1; }
            printf '\n%s\n' "$library" >> "$list"
        done
        vndk_audio_configured=true
    done
done
[ "$vndk_audio_configured" = true ] || { echo 'Missing flattened audio VNDK configuration' >&2; exit 1; }
find /android/vendor/etc/vintf -type f -name '*.xml' | while IFS= read -r manifest; do
    sed -i -e '/<name>android.hardware.audio<\/name>/,/<\/hal>/s@<transport>hwbinder</transport>@<transport arch="64">passthrough</transport>@' -e '/<name>android.hardware.audio.effect<\/name>/,/<\/hal>/s@<transport>hwbinder</transport>@<transport arch="64">passthrough</transport>@' "$manifest"
done
# Physical service keychords are unused in this browser guest. Their init
# scanner opens every /dev/input entry without O_NONBLOCK, including FIFOs.
find /android/system/etc/init /android/vendor/etc/init -type f -name '*.rc' | while IFS= read -r rc; do
    awk '
        /^(service|on|import) / { skip = ($1 == "service" && $2 == "vendor.audio-hal") }
        skip { next }
        $1 == "keycodes" { next }
        ($1 == "start" || $1 == "restart") && $2 == "vendor.audio-hal" { next }
        { print }
    ' "$rc" > "$rc.unkernel"
    cat "$rc.unkernel" > "$rc"
    rm "$rc.unkernel"
done
mkdir -p /dev/binderfs
mount -t binder binder /dev/binderfs
for device in binder hwbinder vndbinder; do
    [ -c "/dev/binderfs/$device" ]
    chmod 666 "/dev/binderfs/$device"
    ln -s "binderfs/$device" "/dev/$device"
done
mkdir -p /dev/input
for input in touch keyboard pointer tablet; do
    pipe="/dev/input/wl_${input}_events"
    [ -p "$pipe" ] || mkfifo -m 666 "$pipe"
done
mount --rbind /dev /android/dev
mkdir -p /android/dev/socket /android/dev/dm-user /android/dev/selinux
mount --rbind /sys /android/sys
mount -t proc proc /android/proc
mount -t tmpfs -o size=512m,mode=0771,uid=1000,gid=1000 tmpfs /android/data
mount -t tmpfs -o mode=0755 tmpfs /android/linkerconfig
mount -t tmpfs -o mode=0755 tmpfs /android/apex
mount -t tmpfs -o mode=0755 tmpfs /android/mnt
mkdir -p /android/mnt/vendor /android/mnt/product
mount -t tmpfs tmpfs /android/debug_ramdisk
mount -t tmpfs tmpfs /android/second_stage_resources
ls -l /android/init /android/system/bin/init /android/system/bin/bootstrap
cat /proc/filesystems
cat /android/system/etc/init/init.waydroid.rc
cat /android/vendor/etc/init/init.waydroid.vendor.rc

printf '\nAvailable Android graphics modules\n'
for dir in /android/vendor/lib64/hw /android/vendor/lib64/egl; do
    if [ -d "$dir" ]; then ls -l "$dir"; else echo "$dir is not provided"; fi
done
printf '\nAndroid host user mapping\n'
if [ -f /android/vendor/etc/passwd ]; then cat /android/vendor/etc/passwd; fi
