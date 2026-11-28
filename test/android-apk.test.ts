// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apkUrl, downloadStatus, packagePaths, validateApk, MAX_APK_BYTES } from '../guest/android/apk.ts';

test('APK links preserve query strings and require HTTPS without credentials or fragments', () => {
	assert.equal(apkUrl('https://example.com/download?id=42&release=1'), 'https://example.com/download?id=42&release=1');
	for (const input of ['file:///tmp/a.apk', 'http://example.com/a.apk', 'https://u:p@example.com/a.apk', 'https://example.com/a.apk#part', 'not a URL']) assert.throws(() => apkUrl(input));
});

test('empty, non-archive and oversized uploads fail before reaching Android', () => {
	validateApk(new Uint8Array([0x50, 0x4b, 3, 4, 1]));
	assert.throws(() => validateApk(new Uint8Array()));
	assert.throws(() => validateApk(new TextEncoder().encode('<html>')));
	assert.throws(() => validateApk(new Uint8Array(MAX_APK_BYTES + 1)));
});

test('Android download progress validates complete files and failures', () => {
	assert.deepEqual(downloadStatus('{"state":"downloading","bytes":1024}'), { state: 'downloading', bytes: 1024 });
	assert.deepEqual(downloadStatus('{"state":"failed","message":"HTTP 404"}'), { state: 'failed', message: 'HTTP 404' });
	assert.equal(downloadStatus(JSON.stringify({ state: 'complete', bytes: 123, sha256: 'a'.repeat(64) })).state, 'complete');
	for (const input of ['null', '{}', '{"state":"complete","bytes":0}', '{"state":"downloading","bytes":-1}', JSON.stringify({ state: 'downloading', bytes: MAX_APK_BYTES + 1 }), '{"state":"complete","bytes":1,"sha256":"wrong"}']) assert.throws(() => downloadStatus(input));
});

test('package paths preserve the installed code path used to detect installs and updates', () => {
	const result = packagePaths('package:/data/app/~~abc/org.example.app-123/base.apk=org.example.app\npackage:/system/app/Settings/Settings.apk=com.android.settings\nnoise\n');
	assert.equal(result.size, 2);
	assert.equal(result.get('org.example.app'), '/data/app/~~abc/org.example.app-123/base.apk');
});
