#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
"""Download and extract the pinned ARM64 system and vendor images without host mounts."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[2]
PINS = json.loads((Path(__file__).with_name('images.json')).read_text())
DEST = ROOT / 'vendor/android/system'


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def prepare():
    DEST.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(DEST).free < 8 * 1024**3:
        raise RuntimeError('Android image preparation requires at least 8 GiB free')
    for name, pin in PINS['images'].items():
        archive = DEST / pin['filename']
        if not archive.exists() or sha256(archive) != pin['sha256']:
            partial = archive.with_suffix('.zip.part')
            subprocess.run(['curl', '-fL', '--retry', '3', '--connect-timeout', '30', '--max-time', '1200', '-o', str(partial), pin['url']], check=True)
            if partial.stat().st_size != pin['downloadBytes'] or sha256(partial) != pin['sha256']:
                partial.unlink()
                raise RuntimeError(f'{name} download does not match pinned size and SHA-256')
            os.replace(partial, archive)
        image = DEST / f'{name}.img'
        with zipfile.ZipFile(archive) as source:
            candidates = [entry for entry in source.infolist() if entry.filename == image.name]
            if len(candidates) != 1 or candidates[0].file_size > 3 * 1024**3:
                raise RuntimeError(f'Unexpected {name} image archive layout')
            partial = image.with_suffix('.img.part')
            with source.open(candidates[0]) as src, partial.open('wb') as dst:
                shutil.copyfileobj(src, dst, 1024 * 1024)
            with partial.open('rb') as src:
                if src.read(4) == b'\x3a\xff\x26\xed':
                    partial.unlink()
                    raise RuntimeError('Android sparse image needs an explicit simg2img conversion')
            os.replace(partial, image)
        print(f'{name}: {image.stat().st_size} bytes; verified archive {pin["sha256"]}', flush=True)


if __name__ == '__main__':
    prepare()
