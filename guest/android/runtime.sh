#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
# Runs inside the disposable unkernel guest, never on the host.
set -eu
mkdir -p /android-lower /android-vendor-lower /android-rw /android
mount -t ext4 -o ro /dev/wda /android-lower
mount -t tmpfs -o size=256m tmpfs /android-rw
mkdir -p /android-rw/upper /android-rw/work
mount -t overlay overlay -o lowerdir=/android-lower,upperdir=/android-rw/upper,workdir=/android-rw/work /android
mount -t ext4 -o ro /dev/wdb /android-vendor-lower
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
debug.hwui.renderer=skiagl
debug.sf.nobootanimation=1
sys.use_memfd=true
PROPERTIES
mkdir -p /dev/binderfs
mount -t binder binder /dev/binderfs
for device in binder hwbinder vndbinder; do
    [ -c "/dev/binderfs/$device" ]
    chmod 666 "/dev/binderfs/$device"
    ln -s "binderfs/$device" "/dev/$device"
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
