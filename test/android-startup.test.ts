// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import { once } from 'node:events';
import { parseStartupArtifact } from '../guest/android/startup-assets.ts';
import { bindStartupDisks, fetchStartupCheckpoint } from '../guest/android/startup.ts';
import { encodeAndroidCheckpoint } from '../guest/android/checkpoint.ts';
import { BaseDisk, HttpBase } from '../js/core/block.ts';
import { encodeSnapshot, snapshotDiskMismatch, type KernelSnapshot } from '../js/core/snapshot.ts';

test('prebooted download verifies bytes and rebinds immutable disks to SDK HTTP identities', async () => {
	const snapshot: KernelSnapshot = {
		version: 1, fingerprint: 'kernel', memory64: false, cpus: 1,
		memory: new Uint8Array(65536), monotonicMs: 1, consoleSize: 0, input: new Uint8Array(),
		disks: [{ name: 'system', identity: 'file-system', gen: 0 }, { name: 'vendor', identity: 'file-vendor', gen: 0 }],
		devices: { network: null },
	};
	const bytes = new Uint8Array(await (await encodeAndroidCheckpoint(snapshot)).arrayBuffer());
	let corrupt = false;
	let wrongSize = false;
	const server = createServer((request, response) => {
		if (request.url === '/startup.gz') {
			response.end(corrupt ? bytes.slice(1) : bytes);
		} else {
			response.writeHead(206, { 'Content-Range': `bytes 0-262143/${wrongSize ? 524288 : 262144}`, ETag: 'immutable-image' });
			response.end(new Uint8Array(262144));
		}
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	try {
		const address = server.address();
		if (!address || typeof address === 'string') throw new Error('Missing test listener');
		const origin = `http://127.0.0.1:${address.port}`;
		const artifact = parseStartupArtifact({ version: 1, codec: 'gzip', identity: 'a'.repeat(64), cpus: 1, network: true,
			bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), diskBytes: [262144, 262144] });
		const restored = await fetchStartupCheckpoint(`${origin}/startup.gz`, artifact, AbortSignal.timeout(5000), () => {});
		await bindStartupDisks(restored, artifact, [`${origin}/system`, `${origin}/vendor`]);
		const disks = await Promise.all(['system', 'vendor'].map(async name => new BaseDisk(await HttpBase.open(`${origin}/${name}`, { strict: true }))));
		assert.equal(snapshotDiskMismatch(restored.disks, disks), null);
		const compressed = zstdCompressSync(encodeSnapshot(snapshot));
		const zstdServer = createServer((_, response) => response.end(compressed));
		zstdServer.listen(0, '127.0.0.1'); await once(zstdServer, 'listening');
		try {
			const endpoint = zstdServer.address();
			if (!endpoint || typeof endpoint === 'string') throw new Error('Missing zstd test listener');
			const zstd = parseStartupArtifact({ ...artifact, codec: 'zstd', bytes: compressed.length, sha256: createHash('sha256').update(compressed).digest('hex') });
			const decoded = await fetchStartupCheckpoint(`http://127.0.0.1:${endpoint.port}/`, zstd, AbortSignal.timeout(5000), () => {});
			assert.deepEqual(decoded.memory, snapshot.memory);
			assert.deepEqual(decoded.devices, snapshot.devices);
		} finally { zstdServer.closeAllConnections(); await new Promise<void>(resolve => zstdServer.close(() => resolve())); }

		wrongSize = true;
		await assert.rejects(bindStartupDisks(restored, artifact, [`${origin}/system`, `${origin}/vendor`]), /mismatch/);
		corrupt = true;
		await assert.rejects(fetchStartupCheckpoint(`${origin}/startup.gz`, artifact, AbortSignal.timeout(5000), () => {}), /checksum/);
		await assert.rejects(bindStartupDisks({ ...restored, cpus: 4 }, artifact, [`${origin}/system`, `${origin}/vendor`]), /configuration/);
	} finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('startup metadata rejects oversized downloads and incompatible versions', () => {
	const value = { version: 1, codec: 'gzip', identity: 'a'.repeat(64), cpus: 1, network: true, bytes: 100,
		sha256: 'b'.repeat(64), diskBytes: [512, 512] };
	assert.deepEqual(parseStartupArtifact(value), value);
	for (const override of [{ version: 2 }, { cpus: 4 }, { network: 'true' }, { bytes: 400 * 1048576 }, { diskBytes: [512] }]) {
		assert.throws(() => parseStartupArtifact({ ...value, ...override }), /manifest/);
	}
});
