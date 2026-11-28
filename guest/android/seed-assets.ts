// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface SeedManifest {
	version: 1;
	identity: string;
	bytes: number;
	sha256: string;
}

export async function seedIdentity(runtime: string, kernel: string, images: string): Promise<string> {
	const hash = createHash('sha256');
	for (const file of [kernel, resolve(runtime, 'runtime.sh'), resolve(runtime, 'start-init.sh'), images]) {
		const bytes = await readFile(file);
		hash.update(String(bytes.length)).update(':').update(bytes);
	}
	return hash.digest('hex');
}

export async function readSeed(directory: string, identity: string): Promise<{ manifest: SeedManifest; data: Uint8Array }> {
	const value: unknown = JSON.parse(await readFile(resolve(directory, 'seed.json'), 'utf8'));
	if (!value || typeof value !== 'object' || !('version' in value) || !('identity' in value) ||
		!('bytes' in value) || typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > 160 * 1024 * 1024 ||
		!('sha256' in value) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
		throw new Error('Invalid prepared Android data manifest');
	}
	if (value.version !== 1 || value.identity !== identity) throw new Error('Prepared Android data belongs to a different kernel or image build');
	const manifest: SeedManifest = { version: 1, identity, bytes: value.bytes, sha256: value.sha256 };
	const data = await readFile(resolve(directory, 'data.tar.gz'));
	if (manifest.bytes !== data.length || manifest.sha256 !== createHash('sha256').update(data).digest('hex')) throw new Error('Prepared Android data checksum mismatch');
	return { manifest, data };
}
