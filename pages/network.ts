// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
export const DEFAULT_RELAYS = ['wss://wisp.mercurywork.shop/', 'wss://anura.pro/'];
export type NetworkSettings = { mode: 'offline' } | { mode: 'wisp'; servers: string[] };

export function parseNetworkSettings(mode: string, relayText: string, secure: boolean): NetworkSettings {
	if (mode === 'offline') return { mode };
	if (mode !== 'wisp') throw new Error('Choose WISP or offline mode.');
	const lines = relayText.split(/\s+/).filter(Boolean);
	if (!lines.length || lines.length > 8) throw new Error('Enter between one and eight WISP relay URLs.');
	const servers = lines.map(line => {
		let url: URL;
		try { url = new URL(line); } catch { throw new Error('Use a complete relay URL, such as wss://relay.example/.'); }
		if (url.protocol !== 'wss:' && url.protocol !== 'ws:') throw new Error('WISP relay URLs must start with wss:// or ws://.');
		if (secure && url.protocol !== 'wss:') throw new Error('This HTTPS page requires a secure wss:// relay.');
		if (url.username || url.password || url.hash) throw new Error('Relay URLs cannot contain a username, password or fragment.');
		return url.href;
	});
	return { mode: 'wisp', servers: [...new Set(servers)] };
}

export function readNetworkSettings(search: string, saved: string | null, secure: boolean): NetworkSettings {
	const supplied = new URLSearchParams(search);
	const params = supplied.has('net') || supplied.has('wisp') ? supplied : new URLSearchParams(saved ?? '');
	const mode = params.get('net') ?? 'wisp';
	if (mode !== 'off' && mode !== 'offline' && mode !== 'wisp') throw new Error('The link contains an unsupported network mode.');
	const servers = params.has('wisp') ? params.getAll('wisp') : DEFAULT_RELAYS;
	return parseNetworkSettings(mode === 'off' ? 'offline' : mode, servers.join('\n'), secure);
}

export function networkSearch(settings: NetworkSettings): URLSearchParams {
	const params = new URLSearchParams({ net: settings.mode === 'offline' ? 'off' : 'wisp' });
	if (settings.mode === 'wisp') for (const server of settings.servers) params.append('wisp', server);
	return params;
}
