// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
import { cp, mkdir, readdir, lstat, readlink, readFile, rm } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'dist-pages');
await rm(out, { recursive: true, force: true });
await mkdir(`${out}/runtime/_chunks`, { recursive: true });
for (const file of ['web.mjs', 'unkernel.wasm', '_chunks']) {
	await cp(`${root}/dist/${file}`, `${out}/runtime/${file}`, { recursive: true });
}
for (const file of ['LICENSE', 'LICENSE-MIT', 'THIRD-PARTY.md']) await cp(`${root}/${file}`, `${out}/${file}`);
await cp(`${root}/node_modules/coi-serviceworker/coi-serviceworker.js`, `${out}/coi-serviceworker.js`);
await mkdir(`${out}/licenses`, { recursive: true });
for (const [name, file] of [['@xterm/xterm', 'LICENSE'], ['@xterm/addon-fit', 'LICENSE'], ['coi-serviceworker', 'LICENSE']]) {
	await cp(`${root}/node_modules/${name}/${file}`, `${out}/licenses/${name!.replaceAll('/', '-')}.txt`);
}

type Entry = { path: string; mode: number } & ({ type: 'dir' } | { type: 'symlink'; target: string } | { type: 'file'; data: string });
const entries: Entry[] = [];
async function visit(path: string): Promise<void> {
	for (const name of (await readdir(`${root}/vendor/android/rootfs${path}`)).sort()) {
		const rel = `${path}/${name}`;
		const full = `${root}/vendor/android/rootfs${rel}`;
		const stat = await lstat(full);
		const mode = stat.mode & 0o777;
		if (stat.isSymbolicLink()) entries.push({ path: rel, mode, type: 'symlink', target: await readlink(full) });
		else if (stat.isDirectory()) {
			entries.push({ path: rel, mode, type: 'dir' });
			await visit(rel);
		} else if (stat.isFile()) entries.push({ path: rel, mode, type: 'file', data: (await readFile(full)).toString('base64') });
		else throw new Error(`Unsupported fixture entry: ${rel}`);
	}
}
await visit('');
const archive = gzipSync(JSON.stringify(entries), { level: 9 });
await Bun.write(`${out}/android.json.gz`, archive);
await Bun.write(`${out}/android.sha256`, createHash('sha256').update(archive).digest('hex'));
const result = await Bun.build({ entrypoints: [`${root}/pages/main.ts`], outdir: out, target: 'browser', minify: true, naming: '[name].[ext]' });
if (!result.success) throw new AggregateError(result.logs, 'Pages build failed');
await cp(`${root}/pages/index.html`, `${out}/index.html`);
await cp(`${root}/pages/style.css`, `${out}/style.css`);
await Bun.write(`${out}/.nojekyll`, '');
console.log(`Pages demo built in dist-pages; Android fixture ${(archive.length / 1024 / 1024).toFixed(1)} MiB`);
