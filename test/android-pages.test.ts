// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createKernel, MemoryFs } from '../js/node.ts';
import { fillFixture } from '../pages/fixture.ts';

test('Pages filesystem boots Android and serves a real terminal session', { timeout: 60000 }, async () => {
	const compressed = await readFile(new URL('../dist-pages/android.json.gz', import.meta.url));
	const checksum = await readFile(new URL('../dist-pages/android.sha256', import.meta.url), 'utf8');
	assert.equal(createHash('sha256').update(compressed).digest('hex'), checksum.trim());
	const fs = new MemoryFs();
	fillFixture(fs, JSON.parse(gunzipSync(compressed).toString()));
	const vm = await createKernel({ kernel: new URL('../dist-pages/runtime/unkernel.wasm', import.meta.url).pathname, memoryMiB: 512, cpus: 1, mounts: { '/android': { fs, readOnly: true } }, log: () => {} });
	const watchdog = setTimeout(() => void vm.stop(), 45000);
	try {
		const setup = await vm.exec('/bin/sh', ['-ec', 'mount -t proc proc /android/proc; mount --bind /dev /android/dev; mount --bind /sys /android/sys']);
		assert.equal(setup.exitCode, 0, setup.stderr);
		const pty = await vm.spawn('/bin/chroot', ['/android', '/system/bin/sh', '-i'], { env: { PATH: '/system/bin', HOME: '/', PS1: 'android # ' }, cols: 80, rows: 24 });
		let output = '';
		const drain = (async () => { for await (const chunk of pty.output) output += new TextDecoder().decode(chunk); })();
		await pty.write('echo ANDROID_PAGES_OK; toybox uname -m; exit\n');
		await drain;
		const ended = await pty.ended;
		assert.deepEqual(ended, { type: 'exit', code: 0 }, output);
		assert.match(output, /ANDROID_PAGES_OK/);
		assert.match(output, /aarch64/);
	} finally {
		clearTimeout(watchdog);
		await vm.stop();
	}
});
