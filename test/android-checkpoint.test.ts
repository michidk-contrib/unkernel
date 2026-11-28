// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeAndroidCheckpoint, decodeAndroidCheckpoint } from '../guest/android/checkpoint.ts';
import type { KernelSnapshot } from '../js/core/snapshot.ts';

test('Android checkpoint gzip preserves sparse memory and restore metadata', async () => {
	const memory = new Uint8Array(3 * 65536);
	memory[65536 + 12] = 73;
	const snapshot: KernelSnapshot = {
		version: 1, fingerprint: 'test-kernel', cpus: 1, memory64: false,
		memory, monotonicMs: 123, consoleSize: 0, input: new Uint8Array([5]),
		disks: [], devices: { vsock: null },
	};
	const blob = await encodeAndroidCheckpoint(snapshot);
	assert.ok(blob.size < 4096, 'zero pages and repeated memory should compress');
	const restored = await decodeAndroidCheckpoint(blob);
	assert.deepEqual(restored.memory, memory);
	assert.equal(restored.fingerprint, snapshot.fingerprint);
	assert.equal(restored.cpus, 1);
	assert.equal(restored.monotonicMs, 123);
	assert.deepEqual(restored.input, snapshot.input);
	assert.deepEqual(restored.devices, snapshot.devices);
});

test('Android checkpoint rejects corrupt cached bytes for a cold boot fallback', async () => {
	await assert.rejects(decodeAndroidCheckpoint(new Blob(['corrupt'])));
});
