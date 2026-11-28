// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { KernelHandle } from '../../js/node.ts';

import type { SeedManifest } from './seed-assets.ts';
export { seedIdentity, readSeed } from './seed-assets.ts';
export type { SeedManifest } from './seed-assets.ts';

export async function restoreSeed(vm: KernelHandle, data: Uint8Array): Promise<void> {
	const result = await vm.exec('/bin/tar', ['-xzf', '-', '-C', '/android/data'], { input: data, signal: AbortSignal.timeout(120000) });
	if (result.exitCode !== 0) throw new Error(`Cannot restore prepared Android data: ${result.stderr}`);
}

/** Export only a disposable build VM, after Home has actually drawn. */
export async function saveSeed(vm: KernelHandle, namespace: string[], directory: string, identity: string): Promise<SeedManifest> {
	const stopped = await vm.exec('/bin/nsenter', [...namespace, '/system/bin/sh', '-ec', 'setprop ctl.stop zygote; setprop ctl.stop surfaceflinger; sleep 2; sync'], { signal: AbortSignal.timeout(30000) });
	if (stopped.exitCode !== 0) throw new Error(`Cannot quiesce seed builder: ${stopped.stderr}`);
	const archive = await vm.spawn('/bin/tar', ['-czf', '-', '-C', '/android/data', '--exclude=./tombstones', '--exclude=./anr', '--exclude=./misc/logd', '--exclude=./system/dropbox', '.'], { pty: false });
	let stderr = '';
	const errors = (async () => { for await (const bytes of archive.stderr) stderr += new TextDecoder().decode(bytes); })();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const bytes of archive.stdout) {
		size += bytes.length;
		if (size > 160 * 1024 * 1024) { await archive.close(); throw new Error('Prepared Android data exceeds its 160 MiB budget'); }
		chunks.push(bytes);
	}
	await errors;
	const ended = await archive.ended;
	if (ended.type !== 'exit' || ended.code !== 0) throw new Error(`Cannot export prepared Android data: ${stderr}`);
	const data = Buffer.concat(chunks);
	const manifest: SeedManifest = { version: 1, identity, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
	await mkdir(directory, { recursive: true });
	await writeFile(resolve(directory, 'data.tar.gz.partial'), data);
	await rename(resolve(directory, 'data.tar.gz.partial'), resolve(directory, 'data.tar.gz'));
	await writeFile(resolve(directory, 'seed.json'), JSON.stringify(manifest, null, 2) + '\n');
	return manifest;
}
