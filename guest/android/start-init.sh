#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
set -eu
mount --make-rprivate /
mount --bind / /
cd /
exec chroot . /bin/sh -ec '
    cd /android
    mkdir -p oldroot
    pivot_root . oldroot
    /oldroot/bin/umount -l /oldroot
    exec /system/bin/init second_stage
'
