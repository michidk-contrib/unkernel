// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parseStartupArtifact } from '../guest/android/startup-assets.ts';

const source = process.env.ANDROID_STARTUP_SOURCE;
const output = process.env.ANDROID_STARTUP;
if (!source || !output || resolve(source) === resolve(output)) throw new Error('Set distinct ANDROID_STARTUP_SOURCE and ANDROID_STARTUP directories');
const manifest = parseStartupArtifact(await Bun.file(resolve(source, 'startup.json')).json());
if (manifest.codec !== 'gzip') throw new Error('Startup source must be the verified gzip checkpoint export');
const input = new Uint8Array(await Bun.file(resolve(source, 'startup.gz')).arrayBuffer());
if (input.length !== manifest.bytes || createHash('sha256').update(input).digest('hex') !== manifest.sha256) throw new Error('Startup source checksum mismatch');
const data = Bun.zstdCompressSync(gunzipSync(input), { level: 19 });
await Bun.write(resolve(output, 'startup.zst'), data);
await Bun.write(resolve(output, 'startup.json'), JSON.stringify({ ...manifest, codec: 'zstd', bytes: data.length,
	sha256: createHash('sha256').update(data).digest('hex') }, null, 2));
console.log(`Prebooted Android: ${(input.length / 1048576).toFixed(1)} MiB gzip, ${(data.length / 1048576).toFixed(1)} MiB zstd`);
