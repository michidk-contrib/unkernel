#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
# Run on a disposable Linux build runner with loop-mount permission.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
out="$root/vendor/android/web"
mkdir -p "$out"
erofs_bin="$(bash "$root/guest/tools/erofs-utils.sh")"
mount_dir="$(mktemp -d "$root/vendor/android/pack.XXXXXX")"
cleanup() {
    if mountpoint -q "$mount_dir"; then sudo umount "$mount_dir" || return; fi
    rmdir "$mount_dir"
}
trap cleanup EXIT
for image in system vendor; do
    sudo mount -o loop,ro "$root/vendor/android/system/$image.img" "$mount_dir"
    if [ "$image" = system ]; then
        excludes=(--exclude-regex='^system/lib(/|$)|^system/apex/[^/]+/lib(/|$)|^system/framework/arm(/|$)|^system/system_ext/apex/com.android.vndk.v(28|29|30)(/|$)')
    else
        excludes=(--exclude-path=lib)
    fi
    # Read the original inode owners, modes and xattrs directly from ext4.
    sudo "$erofs_bin/mkfs.erofs" --quiet -z zstd,level=15 --workers=2 "${excludes[@]}" "$out/$image.erofs" "$mount_dir"
    sudo umount "$mount_dir"
done
python3 - "$out" <<'PY'
import hashlib
import json
from pathlib import Path
import sys

out = Path(sys.argv[1])
images = {}
for name in ('system', 'vendor'):
    path = out / f'{name}.erofs'
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    images[name] = {'file': path.name, 'bytes': path.stat().st_size, 'sha256': digest.hexdigest()}
print(json.dumps(images, indent=2), flush=True)
(out / 'images.json').write_text(json.dumps({'format': 'erofs', 'images': images}, indent=2) + '\n')
if sum(image['bytes'] for image in images.values()) > 900_000_000:
    raise SystemExit('Android disks exceed the 900 MB budget reserved for the Pages demo')
PY
