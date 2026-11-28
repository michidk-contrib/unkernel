// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
export interface StartupArtifact {
	version: 1;
	codec: 'gzip' | 'zstd';
	identity: string;
	cpus: 1;
	network: boolean;
	bytes: number;
	sha256: string;
	diskBytes: [number, number];
}

export function parseStartupArtifact(value: unknown): StartupArtifact {
	if (!value || typeof value !== 'object' ||
		!('version' in value) || value.version !== 1 ||
		!('codec' in value) || (value.codec !== 'gzip' && value.codec !== 'zstd') ||
		!('identity' in value) || typeof value.identity !== 'string' || !/^[a-f0-9]{64}$/.test(value.identity) ||
		!('cpus' in value) || value.cpus !== 1 ||
		!('network' in value) || typeof value.network !== 'boolean' ||
		!('bytes' in value) || typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > 320 * 1048576 ||
		!('sha256' in value) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) ||
		!('diskBytes' in value) || !Array.isArray(value.diskBytes) || value.diskBytes.length !== 2 ||
		!value.diskBytes.every((size: unknown) => typeof size === 'number' && Number.isSafeInteger(size) && size > 0 && size <= 900_000_000)) {
		throw new Error('Invalid prebooted Android manifest');
	}
	return { version: 1, codec: value.codec, identity: value.identity, cpus: 1, network: value.network,
		bytes: value.bytes, sha256: value.sha256, diskBytes: [value.diskBytes[0], value.diskBytes[1]] };
}

