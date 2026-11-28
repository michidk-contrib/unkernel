// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
import { cp, mkdir, readFile, rm, link, stat, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { seedIdentity, readSeed } from '../guest/android/seed-assets.ts';
import { smpKernelFromBundle } from '../js/core/kpatch.ts';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'dist-pages');
const images = resolve(root, 'vendor/android/web');
const kernel = process.env.ANDROID_KERNEL;
if (!kernel) throw new Error('Set ANDROID_KERNEL to the verified Binder/BPF Android kernel bundle');
const launcher = `${root}/vendor/android/launcher/home.apk`;
try { await stat(launcher); } catch { throw new Error('Build Browser Home first: bash guest/android/launcher/build.sh (requires JDK 17 and ANDROID_HOME)'); }
await rm(out, { recursive: true, force: true });
await mkdir(`${out}/runtime/_chunks`, { recursive: true });
await mkdir(`${out}/android`, { recursive: true });
for (const file of ['web.mjs', '_chunks']) await cp(`${root}/dist/${file}`, `${out}/runtime/${file}`, { recursive: true });
await cp(kernel, `${out}/runtime/unkernel.wasm`);
for (const file of ['LICENSE', 'LICENSE-MIT', 'THIRD-PARTY.md']) await cp(`${root}/${file}`, `${out}/${file}`);
await cp(`${root}/node_modules/coi-serviceworker/coi-serviceworker.js`, `${out}/coi-serviceworker.js`);
await mkdir(`${out}/licenses`, { recursive: true });
for (const name of ['wland', 'coi-serviceworker']) await cp(`${root}/node_modules/${name}/LICENSE`, `${out}/licenses/${name}.txt`);
for (const file of ['runtime.sh', 'start-init.sh']) await cp(`${root}/guest/android/${file}`, `${out}/android/${file}`);
await cp(launcher, `${out}/android/home.apk`);
await cp(`${images}/images.json`, `${out}/android/images.json`);
const manifest: unknown = JSON.parse(await readFile(`${images}/images.json`, 'utf8'));
if (!manifest || typeof manifest !== 'object' || !('format' in manifest) || manifest.format !== 'erofs' || !('images' in manifest) || !manifest.images || typeof manifest.images !== 'object') throw new Error('Invalid Android EROFS manifest');
let diskBytes = 0;
for (const name of ['system', 'vendor']) {
	const file = `${name}.erofs`;
	const entry: unknown = Reflect.get(manifest.images, name);
	if (!entry || typeof entry !== 'object' || !('file' in entry) || entry.file !== file || !('bytes' in entry) || !('sha256' in entry) || typeof entry.sha256 !== 'string') throw new Error(`Invalid ${name} image manifest`);
	const size = (await stat(`${images}/${file}`)).size;
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(`${images}/${file}`)) hash.update(chunk);
	if (size !== entry.bytes || hash.digest('hex') !== entry.sha256) throw new Error(`Android ${name} image checksum mismatch`);
	diskBytes += size;
	await link(`${images}/${file}`, `${out}/android/${file}`).catch(() => cp(`${images}/${file}`, `${out}/android/${file}`));
}
if (diskBytes > 900_000_000) throw new Error('Android disks exceed the 900 MB Pages budget');
const relay = brotliDecompressSync(await readFile(`${root}/node_modules/wland/dist/wlandr-linux-arm64.br`));
await Bun.write(`${out}/android/wlandr`, relay);
await cp(`${root}/node_modules/wland/dist/wland.wasm`, `${out}/wland.wasm`);
const result = await Bun.build({ entrypoints: [`${root}/pages/main.ts`], outdir: out, target: 'browser', minify: true, naming: '[name].[ext]' });
if (!result.success) throw new AggregateError(result.logs, 'Pages build failed');
for (const file of ['index.html', 'style.css']) await cp(`${root}/pages/${file}`, `${out}/${file}`);
await cp(`${root}/pages/fonts`, `${out}/fonts`, { recursive: true });
await Bun.write(`${out}/.nojekyll`, '');
await Bun.write(`${out}/android/kernel.sha256`, createHash('sha256').update(await readFile(kernel)).digest('hex'));
const identity = await seedIdentity(`${out}/android`, kernel, `${images}/images.json`);
let seed: { bytes: number; sha256: string } | undefined;
try {
	const prepared = await readSeed(images, identity);
	await cp(`${images}/data.tar.gz`, `${out}/android/data.tar.gz`);
	seed = { bytes: prepared.manifest.bytes, sha256: prepared.manifest.sha256 };
} catch (cause) {
	if (process.env.ANDROID_REQUIRE_SEED === '1') throw cause;
	console.log(`Building a cold-boot image: ${String(cause)}`);
}
const smp = !!await smpKernelFromBundle(new Uint8Array(await readFile(kernel)));
await Bun.write(`${out}/android/boot.json`, JSON.stringify({ version: 1, identity, maxCpus: smp ? 4 : 1, checkpoint: false, seed }, null, 2));
async function directoryBytes(path: string): Promise<number> {
	let bytes = 0;
	for (const entry of await readdir(path, { withFileTypes: true })) {
		const file = resolve(path, entry.name);
		bytes += entry.isDirectory() ? await directoryBytes(file) : (await stat(file)).size;
	}
	return bytes;
}
const totalBytes = await directoryBytes(out);
if (totalBytes > 990_000_000) throw new Error(`Android demo exceeds the GitHub Pages size budget (${totalBytes} bytes)`);
console.log(`Android Pages demo built; compressed disks ${(diskBytes / 1024 / 1024).toFixed(1)} MiB`);
