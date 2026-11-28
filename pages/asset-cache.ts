// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
export const assetCachePrefix = 'unkernel-android-assets-v1-';

interface ResponseCache {
	match(request: Request): Promise<Response | undefined>;
	put(request: Request, response: Response): Promise<void>;
}

/** Cache only immutable, build-addressed Android assets, including HTTP ranges.
 * Cache API rejects 206 responses, so retain their headers with a 200 envelope.
 */
export async function androidAssetFetch(request: Request, {
	storage = caches,
	fetcher = fetch,
}: { storage?: { open(name: string): Promise<ResponseCache> }; fetcher?: typeof fetch } = {}): Promise<Response> {
	const url = new URL(request.url);
	const build = url.searchParams.get('v');
	const range = request.headers.get('range');
	if (request.method !== 'GET' || !build || !/^[a-f0-9]{64}$/.test(build) ||
		!/(?:\/android\/(?:system|vendor)\.erofs|\/runtime\/unkernel\.wasm)$/.test(url.pathname) ||
		(range !== null && !/^bytes=\d+-\d+$/.test(range))) return fetcher(request);
	const key = new URL(url);
	key.searchParams.set('__range', range ?? 'full');
	const cacheKey = new Request(key);
	let cache: ResponseCache;
	try {
		cache = await storage.open(`${assetCachePrefix}${build}`);
		const saved = await cache.match(cacheKey);
		if (saved) {
			const headers = new Headers(saved.headers);
			const status = headers.get('X-Android-Cached-Status');
			headers.delete('X-Android-Cached-Status');
			return new Response(saved.body, { status: status === '206' ? 206 : 200, headers });
		}
	} catch {
		return fetcher(request);
	}
	const response = await fetcher(request);
	if (response.status !== (range ? 206 : 200)) return response;
	const headers = new Headers(response.headers);
	headers.set('X-Android-Cached-Status', String(response.status));
	try {
		await cache.put(cacheKey, new Response(response.clone().body, { status: 200, headers }));
	} catch { /* Storage quota or private mode must not prevent Android startup. */ }
	return response;
}

/** Keep one build's downloaded assets, without touching user or unrelated caches. */
export async function pruneAndroidAssets(identity: string): Promise<void> {
	for (const key of await caches.keys()) {
		if (key.startsWith(assetCachePrefix) && key !== `${assetCachePrefix}${identity}`) await caches.delete(key);
	}
}

// Installed before coi-serviceworker's fetch handler; its isolation headers remain intact.
if (typeof window === 'undefined' && typeof self !== 'undefined') Object.assign(self, { androidAssetFetch });
