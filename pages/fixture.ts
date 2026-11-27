// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
import type { MemoryFs } from '../js/web.ts';

/** Decode the build's fixture at the network boundary, preserving executable modes and symlinks. */
export function fillFixture(fs: MemoryFs, input: unknown): void {
	if (!Array.isArray(input) || input.length > 10000) throw new Error('Invalid Android fixture');
	for (const value of input) {
		if (!value || typeof value !== 'object') throw new Error('Invalid fixture entry');
		const { path, mode, type, data, target } = value;
		if (typeof path !== 'string' || !path.startsWith('/') || path.split('/').some(p => p === '..' || p === '.') || path.includes('\0') || typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error('Invalid fixture path or mode');
		if (type === 'dir') fs.mkdirp(path, { mode });
		else if (type === 'symlink' && typeof target === 'string') fs.symlink(path, target);
		else if (type === 'file' && typeof data === 'string') {
			fs.writeFile(path, Uint8Array.from(atob(data), c => c.charCodeAt(0)));
			fs.setattr(path, { mode });
		} else throw new Error(`Invalid fixture entry: ${path}`);
	}
}
