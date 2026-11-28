// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseBootAssets, verifySeed } from '../pages/boot-assets.ts';

test('cold-boot manifest remains usable without a prepared-data artifact', () => {
	const value = { version: 1, identity: 'a'.repeat(64), maxCpus: 1 };
	assert.deepEqual(parseBootAssets(value), value);
});

test('prepared-data downloads reject truncated and corrupt bytes', async () => {
	const data = new TextEncoder().encode('prepared Android data');
	const expected = { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
	await verifySeed(data, expected);
	await assert.rejects(verifySeed(data.slice(1), expected), /checksum/);
	const corrupt = data.slice(); corrupt[0] = 0;
	await assert.rejects(verifySeed(corrupt, expected), /checksum/);
});

test('invalid or oversized startup manifests fail before starting Android', () => {
	assert.throws(() => parseBootAssets({ version: 1, identity: 'old-build', maxCpus: 1 }));
	assert.throws(() => parseBootAssets({ version: 1, identity: 'a'.repeat(64), maxCpus: 0 }));
	assert.throws(() => parseBootAssets({ version: 1, identity: 'a'.repeat(64), maxCpus: 1, seed: { bytes: 200 * 1024 * 1024, sha256: 'b'.repeat(64) } }));
});


test('local checkpoints require an explicit boolean enable flag', () => {
	const base = { version: 1, identity: 'a'.repeat(64), maxCpus: 1 };
	assert.equal(parseBootAssets(base).checkpoint, undefined);
	assert.equal(parseBootAssets({ ...base, checkpoint: true }).checkpoint, true);
	assert.equal(parseBootAssets({ ...base, checkpoint: false }).checkpoint, false);
	assert.throws(() => parseBootAssets({ ...base, checkpoint: 'true' }));
});
