// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
import { parseStartupArtifact, type StartupArtifact } from '../guest/android/startup-assets.ts';

export interface BootAssets {
	version: 1;
	identity: string;
	maxCpus: number;
	checkpoint?: boolean;
	startup?: StartupArtifact;
	seed?: { bytes: number; sha256: string };
}

export function parseBootAssets(value: unknown): BootAssets {
	if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('identity' in value) || typeof value.identity !== 'string' || !/^[a-f0-9]{64}$/.test(value.identity) || !('maxCpus' in value) || (value.maxCpus !== 1 && value.maxCpus !== 4)) throw new Error('Invalid Android boot manifest');
	if ('checkpoint' in value && value.checkpoint !== undefined && typeof value.checkpoint !== 'boolean') throw new Error('Invalid Android checkpoint setting');
	const startup = 'startup' in value && value.startup !== undefined ? { startup: parseStartupArtifact(value.startup) } : {};
	if (startup.startup && startup.startup.identity !== value.identity) throw new Error('Prebooted Android belongs to another build');
	const checkpoint = 'checkpoint' in value && typeof value.checkpoint === 'boolean' ? { checkpoint: value.checkpoint } : {};
	if (!('seed' in value) || value.seed === undefined) return { version: 1, identity: value.identity, maxCpus: value.maxCpus, ...checkpoint, ...startup };
	const seed = value.seed;
	if (!seed || typeof seed !== 'object' || !('bytes' in seed) || typeof seed.bytes !== 'number' || !Number.isSafeInteger(seed.bytes) || seed.bytes <= 0 || seed.bytes > 160 * 1024 * 1024 || !('sha256' in seed) || typeof seed.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(seed.sha256)) throw new Error('Invalid prepared Android data manifest');
	return { version: 1, identity: value.identity, maxCpus: value.maxCpus, ...checkpoint, ...startup, seed: { bytes: seed.bytes, sha256: seed.sha256 } };
}

export async function verifySeed(data: Uint8Array<ArrayBuffer>, expected: NonNullable<BootAssets['seed']>): Promise<void> {
	const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), value => value.toString(16).padStart(2, '0')).join('');
	if (data.length !== expected.bytes || hash !== expected.sha256) throw new Error('Prepared Android data checksum mismatch. Reload to fetch the current build.');
}
