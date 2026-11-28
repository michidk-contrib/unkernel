// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
import { decompress } from 'fzstd';
import { decodeSnapshot } from '../../js/core/snapshot.ts';
import type { KernelSnapshot } from '../../js/core/snapshot.ts';
import { decodeAndroidCheckpoint } from './checkpoint.ts';

import type { StartupArtifact } from './startup-assets.ts';

/** Rebind build-machine paths only for the immutable images verified by the build.
 * Keep the SDK's normal disk validation, including the deployment's HTTP validator.
 */
export async function bindStartupDisks(snapshot: KernelSnapshot, artifact: StartupArtifact, urls: [string, string], signal?: AbortSignal): Promise<void> {
	if (snapshot.disks.length !== 2 || snapshot.disks.some(disk => disk.gen !== 0) ||
		(snapshot.cpus ?? 1) !== artifact.cpus || ('network' in snapshot.devices) !== artifact.network) {
		throw new Error('Prebooted Android device configuration mismatch');
	}
	snapshot.disks = await Promise.all(urls.map(async (url, index) => {
		const response = await fetch(url, { headers: { range: 'bytes=0-262143' }, cache: 'no-cache', signal });
		try {
			if (response.status !== 206 || response.headers.get('content-range') !== `bytes 0-262143/${artifact.diskBytes[index]}`) {
				throw new Error('Prebooted Android disk size or range support mismatch');
			}
			const validator = response.headers.get('etag') ?? response.headers.get('last-modified') ?? '';
			const name = `${url} ${artifact.diskBytes[index]} ${validator}`;
			return { name, identity: `base ${name}`, gen: 0 };
		} finally { await response.body?.cancel(); }
	}));
}

export async function fetchStartupCheckpoint(url: string, artifact: StartupArtifact, signal: AbortSignal, progress: (loaded: number) => void): Promise<KernelSnapshot> {
	const response = await fetch(url, { signal });
	if (!response.ok || !response.body) throw new Error(`Prebooted Android download failed: HTTP ${response.status}`);
	const data = new Uint8Array(artifact.bytes);
	let offset = 0;
	for await (const chunk of response.body) {
		if (offset + chunk.length > data.length) throw new Error('Prebooted Android exceeds its expected size');
		data.set(chunk, offset); offset += chunk.length;
		progress(offset);
	}
	const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), byte => byte.toString(16).padStart(2, '0')).join('');
	if (offset !== data.length || sha256 !== artifact.sha256) throw new Error('Prebooted Android checksum mismatch');
	return artifact.codec === 'gzip' ? decodeAndroidCheckpoint(new Blob([data])) : decodeSnapshot(decompress(data));
}
