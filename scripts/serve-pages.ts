// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
import { resolve, sep } from 'node:path';
const root = resolve(import.meta.dirname, '../dist-pages');
Bun.serve({
	port: Number(process.env.PORT ?? 3000), hostname: '0.0.0.0',
	async fetch(request) {
		const url = new URL(request.url);
		const path = resolve(root, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
		if (!path.startsWith(root + sep)) return new Response('Forbidden', { status: 403 });
		const file = Bun.file(path);
		if (!await file.exists()) return new Response('Not found', { status: 404 });
		return new Response(file, { headers: {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp',
			'Cache-Control': 'no-cache',
		} });
	},
});
