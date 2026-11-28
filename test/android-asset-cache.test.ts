// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { androidAssetFetch } from '../pages/asset-cache.ts';

test('disk ranges survive between launches without another network request', async () => {
	const entries = new Map<string, Response>();
	const storage = { async open(name: string) {
		return {
			async match(key: Request) { return entries.get(name + key.url)?.clone(); },
			async put(key: Request, response: Response) {
				assert.equal(response.status, 200, 'Cache API cannot store 206');
				entries.set(name + key.url, response);
			},
		};
	} };
	let requests = 0;
	const fetcher: typeof fetch = async () => {
		requests++;
		return new Response('disk', { status: 206, headers: { 'Content-Range': 'bytes 0-3/16', ETag: 'image' } });
	};
	const url = `https://demo.test/android/system.erofs?v=${'a'.repeat(64)}`;
	const request = new Request(url, { headers: { Range: 'bytes=0-3' } });
	assert.equal(await (await androidAssetFetch(request, { storage, fetcher })).text(), 'disk');
	const cached = await androidAssetFetch(request, { storage, fetcher });
	assert.equal(cached.status, 206);
	assert.equal(cached.headers.get('Content-Range'), 'bytes 0-3/16');
	assert.equal(cached.headers.get('ETag'), 'image');
	assert.equal(cached.headers.get('X-Android-Cached-Status'), null);
	assert.equal(await cached.text(), 'disk');
	assert.equal(requests, 1);
	await androidAssetFetch(new Request(url.replace('a'.repeat(64), 'b'.repeat(64)), { headers: request.headers }), { storage, fetcher });
	assert.equal(requests, 2, 'a new image build must miss the old cache');
	await androidAssetFetch(new Request(url, { headers: { Range: 'bytes=4-7' } }), { storage, fetcher });
	assert.equal(requests, 3, 'different byte ranges must never alias');
});

test('unversioned assets bypass storage and unavailable storage falls back to network', async () => {
	let opens = 0;
	const storage = { async open(): Promise<never> { opens++; throw new Error('Storage unavailable'); } };
	const fetcher: typeof fetch = async () => new Response('network');
	await androidAssetFetch(new Request('https://demo.test/android/system.erofs'), { storage, fetcher });
	assert.equal(opens, 0);
	const result = await androidAssetFetch(new Request(`https://demo.test/runtime/unkernel.wasm?v=${'a'.repeat(64)}`), { storage, fetcher });
	assert.equal(await result.text(), 'network');
	assert.equal(opens, 1);
});

test('quota failures still return downloaded data', async () => {
	const storage = { async open() { return {
		async match() { return undefined; },
		async put() { throw new Error('Quota exceeded'); },
	}; } };
	const fetcher: typeof fetch = async () => new Response('kernel');
	const response = await androidAssetFetch(new Request(`https://demo.test/runtime/unkernel.wasm?v=${'c'.repeat(64)}`), { storage, fetcher });
	assert.equal(await response.text(), 'kernel');
});

test('startup downloads stream while the service worker retains background cache writes', async () => {
	let finish: (() => void) | undefined;
	const stored = new Promise<void>(resolve => { finish = resolve; });
	let background: Promise<void> | undefined;
	const storage = { async open() { return {
		async match() { return undefined; },
		async put() { await stored; },
	}; } };
	const response = await androidAssetFetch(new Request(`https://demo.test/android/startup.zst?v=${'a'.repeat(64)}`), {
		storage, fetcher: async () => new Response('startup'), waitUntil: work => { background = work; },
	});
	assert.equal(await response.text(), 'startup');
	assert.ok(background, 'the service worker must retain the cache write');
	finish?.();
	await background;
});
