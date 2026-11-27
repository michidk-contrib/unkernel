// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

// Exercise the exact compressed disks and Android kernel distributed by Pages.
test('Pages Android disks boot the launcher, draw Settings and accept pointer input', { timeout: 1_200_000 }, async () => {
	const root = resolve(import.meta.dirname, '..');
	await promisify(execFile)(process.execPath, ['guest/android/framework.ts'], {
		cwd: root, timeout: 1_140_000, maxBuffer: 8 * 1024 * 1024,
		env: {
			...process.env,
			ANDROID_KERNEL: `${root}/dist-pages/runtime/unkernel.wasm`,
			ANDROID_SYSTEM_IMAGE: `${root}/dist-pages/android/system.erofs`,
			ANDROID_VENDOR_IMAGE: `${root}/dist-pages/android/vendor.erofs`,
			ANDROID_DISK_FORMAT: 'erofs',
			ANDROID_RUNTIME_DIR: `${root}/dist-pages/android`,
		},
	});
});
