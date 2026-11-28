// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { readSeed, seedIdentity } from '../guest/android/seed-assets.ts';
import type { SeedManifest } from '../guest/android/seed-assets.ts';

async function fixture(t: { after(callback: () => Promise<void>): void }) {
	const directory = await mkdtemp(join(tmpdir(), 'android-seed-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const files = ['kernel.wasm', 'runtime.sh', 'start-init.sh', 'images.json'];
	for (const file of files) await writeFile(join(directory, file), file);
	const identity = await seedIdentity(directory, join(directory, 'kernel.wasm'), join(directory, 'images.json'));
	const data = gzipSync(Buffer.from('prepared Android data'));
	const manifest: SeedManifest = { version: 1, identity, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
	await writeFile(join(directory, 'data.tar.gz'), data);
	await writeFile(join(directory, 'seed.json'), JSON.stringify(manifest));
	return { directory, identity, data, manifest };
}

test('prepared data returns the verified manifest and exact archive bytes', async t => {
	const f = await fixture(t);
	const actual = await readSeed(f.directory, f.identity);
	assert.deepEqual(actual.manifest, f.manifest);
	assert.deepEqual(actual.data, f.data);
});

test('changing any runtime, kernel or image manifest invalidates prepared data', async t => {
	const f = await fixture(t);
	for (const file of ['kernel.wasm', 'runtime.sh', 'start-init.sh', 'images.json']) {
		await writeFile(join(f.directory, file), `${file} changed`);
		const identity = await seedIdentity(f.directory, join(f.directory, 'kernel.wasm'), join(f.directory, 'images.json'));
		assert.notEqual(identity, f.identity, file);
		await assert.rejects(readSeed(f.directory, identity), /different kernel or image build/);
		await writeFile(join(f.directory, file), file);
	}
});

test('corrupt archive content and wrong byte lengths fail verification', async t => {
	const f = await fixture(t);
	const damaged = Buffer.from(f.data);
	damaged[0] = (damaged[0] ?? 0) ^ 1;
	await writeFile(join(f.directory, 'data.tar.gz'), damaged);
	await assert.rejects(readSeed(f.directory, f.identity), /checksum mismatch/);
	await writeFile(join(f.directory, 'data.tar.gz'), f.data);
	await writeFile(join(f.directory, 'seed.json'), JSON.stringify({ ...f.manifest, bytes: f.manifest.bytes + 1 }));
	await assert.rejects(readSeed(f.directory, f.identity), /checksum mismatch/);
});

test('malformed manifests and unsupported versions are refused', async t => {
	const f = await fixture(t);
	for (const value of [null, [], {}, { ...f.manifest, bytes: '1' }, { ...f.manifest, bytes: -1 }, { ...f.manifest, sha256: 'invalid' }]) {
		await writeFile(join(f.directory, 'seed.json'), JSON.stringify(value));
		await assert.rejects(readSeed(f.directory, f.identity), /Invalid prepared Android data manifest/);
	}
	await writeFile(join(f.directory, 'seed.json'), JSON.stringify({ ...f.manifest, version: 2 }));
	await assert.rejects(readSeed(f.directory, f.identity), /different kernel or image build/);
	await writeFile(join(f.directory, 'seed.json'), '{');
	await assert.rejects(readSeed(f.directory, f.identity), SyntaxError);
});
