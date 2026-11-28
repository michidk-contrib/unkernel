// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNetworkSettings, readNetworkSettings, networkSearch } from '../pages/network.ts';

test('a shared link overrides local relays and round trips multiple endpoints', () => {
	const settings = parseNetworkSettings('wisp', 'wss://one.example/relay\nwss://two.example/', true);
	assert.deepEqual(readNetworkSettings(`?${networkSearch(settings)}`, 'net=off', true), settings);
	assert.deepEqual(readNetworkSettings('?net=off', 'wisp=wss://saved.example/', true), { mode: 'offline' });
	assert.deepEqual(readNetworkSettings('', 'net=off', true), { mode: 'offline' });
});

test('invalid relay protocols, credentials, fragments, mixed content and empty input fail', () => {
	for (const relay of ['', 'not-a-url', 'https://host/', 'ws://host/', 'wss://user:secret@host/', 'wss://host/#part']) {
		assert.throws(() => parseNetworkSettings('wisp', relay, true));
	}
	assert.throws(() => parseNetworkSettings('wisp', Array(9).fill('wss://host/').join('\n'), true));
	assert.throws(() => readNetworkSettings('?net=invalid', null, true));
	assert.deepEqual(parseNetworkSettings('wisp', 'ws://localhost:8080/', false), { mode: 'wisp', servers: ['ws://localhost:8080/'] });
	assert.deepEqual(parseNetworkSettings('offline', '', true), { mode: 'offline' });
});
