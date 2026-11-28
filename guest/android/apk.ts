// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
import type { KernelHandle } from '../../js/core/instance.ts';

export const MAX_APK_BYTES = 64 * 1024 * 1024;
export const FDROID = {
	name: 'F-Droid 2.0.3',
	url: 'https://f-droid.org/repo/org.fdroid.fdroid_2000053.apk',
	packageName: 'org.fdroid.fdroid',
	sha256: 'dac55a0d17b1edf7e7286b48cfbd70c7c52fbb32a00af062c68830a437c47959',
};
export interface ApkSession {
	vm: Pick<KernelHandle, 'exec'>;
	namespace: string;
	signal: AbortSignal;
}

export function apkUrl(value: string): string {
	let url: URL;
	try { url = new URL(value); } catch { throw new Error('Enter a complete HTTPS URL to an APK.'); }
	if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('APK links must use HTTPS without credentials or a fragment.');
	return url.href;
}

export function validateApk(bytes: Uint8Array): void {
	if (bytes.length > MAX_APK_BYTES) throw new Error('APK files must be at most 64 MiB.');
	if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 3 || bytes[3] !== 4) throw new Error('Choose an APK file. Split APK bundles and XAPK archives are not supported.');
}

async function android(session: ApkSession, file: string, args: string[], input?: Uint8Array): Promise<string> {
	if (!/^[1-9][0-9]*$/.test(session.namespace)) throw new Error('Android installation namespace is unavailable.');
	const result = await session.vm.exec('/bin/nsenter', ['-t', session.namespace, '-m', '-p', file, ...args], {
		input, signal: AbortSignal.any([session.signal, AbortSignal.timeout(300000)]),
	});
	if (result.exitCode !== 0) throw new Error((result.stdout + '\n' + result.stderr).trim() || 'Android could not complete this operation.');
	return result.stdout;
}

export function packagePaths(output: string): Map<string, string> {
	const packages = new Map<string, string>();
	for (const line of output.split('\n')) {
		const match = /^package:(.+)=([A-Za-z][A-Za-z0-9_.]*)$/.exec(line.trim());
		if (match?.[1] && match[2]) packages.set(match[2], match[1]);
	}
	return packages;
}

async function packages(session: ApkSession): Promise<Map<string, string>> {
	return packagePaths(await android(session, '/system/bin/pm', ['list', 'packages', '-f', '--user', '0']));
}

async function installedPackage(session: ApkSession, before: Map<string, string>): Promise<string | undefined> {
	const after = await packages(session);
	const changed = [...after].filter(([name, path]) => before.get(name) !== path);
	return changed.length === 1 ? changed[0]?.[0] : undefined;
}

export async function installLocalApk(session: ApkSession, bytes: Uint8Array): Promise<string | undefined> {
	validateApk(bytes);
	const before = await packages(session);
	const output = await android(session, '/system/bin/pm', ['install', '-r', '-t', '-S', String(bytes.length)], bytes);
	if (!/^Success\s*$/m.test(output)) throw new Error(output || 'Android did not confirm APK installation.');
	return installedPackage(session, before);
}

type DownloadStatus = { state: 'downloading'; bytes: number } | { state: 'complete'; bytes: number; sha256: string } | { state: 'failed'; message: string };
export function downloadStatus(text: string): DownloadStatus {
	const value: unknown = JSON.parse(text);
	if (!value || typeof value !== 'object' || !('state' in value)) throw new Error('Invalid Android download status.');
	if (value.state === 'failed' && 'message' in value && typeof value.message === 'string') return { state: 'failed', message: value.message };
	if (!('bytes' in value) || typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > MAX_APK_BYTES) throw new Error('APK download exceeds its size limit or has invalid progress.');
	if (value.state === 'downloading') return { state: 'downloading', bytes: value.bytes };
	if (value.state === 'complete' && value.bytes > 0 && 'sha256' in value && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)) return { state: 'complete', bytes: value.bytes, sha256: value.sha256 };
	throw new Error('Invalid Android download status.');
}

export async function installApkUrl(session: ApkSession, source: string, onProgress: (label: string) => void): Promise<string | undefined> {
	const url = apkUrl(source);
	const token = crypto.randomUUID();
	const base = `/data/user/0/dev.unkernel.home/cache/download-${token}`;
	const deadline = AbortSignal.any([session.signal, AbortSignal.timeout(300000)]);
	const job = { ...session, signal: deadline };
	await android(job, '/system/bin/am', ['start', '-n', 'dev.unkernel.home/.HomeActivity', '-a', 'dev.unkernel.home.DOWNLOAD_APK', '--es', 'url', url, '--es', 'token', token]);
	try {
		for (;;) {
			deadline.throwIfAborted();
			const status = await job.vm.exec('/bin/nsenter', ['-t', job.namespace, '-m', '-p', '/system/bin/sh', '-c', 'test ! -f "$1" || cat "$1"', 'apk-status', `${base}.json`], { signal: deadline });
			if (status.exitCode !== 0) throw new Error(status.stderr || 'Cannot read APK download progress.');
			if (status.stdout.trim()) {
				const current = downloadStatus(status.stdout);
				if (current.state === 'failed') throw new Error(current.message);
				onProgress(`Downloading APK through Android: ${(current.bytes / 1048576).toFixed(1)} MiB`);
				if (current.state === 'complete') {
					if (url === FDROID.url && current.sha256 !== FDROID.sha256) throw new Error('The F-Droid download does not match the pinned release checksum.');
					onProgress('Installing APK in Android…');
					const before = await packages(session);
					const output = await android(session, '/system/bin/pm', ['install', '-r', '-t', `${base}.apk`]);
					if (!/^Success\s*$/m.test(output)) throw new Error(output || 'Android did not confirm APK installation.');
					return installedPackage(session, before);
				}
			}
			await new Promise(resolve => setTimeout(resolve, 1000));
		}
	} finally {
		await android(session, '/system/bin/rm', ['-f', `${base}.apk`, `${base}.json`, `${base}.json.tmp`]).catch(() => {});
	}
}

export async function openInstalledApp(session: ApkSession, name: string): Promise<boolean> {
	if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(name)) throw new Error('Invalid installed package name.');
	const resolved = await android(session, '/system/bin/cmd', ['package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', name]);
	const component = resolved.trim().split('\n').at(-1) ?? '';
	if (!/^[\w.]+\/[\w.$]+$/.test(component)) return false;
	const output = await android(session, '/system/bin/am', ['start', '-n', component]);
	if (/Error:|Exception/.test(output)) throw new Error(output);
	return true;
}

export async function openAndroidApps(session: ApkSession): Promise<void> {
	await android(session, '/system/bin/am', ['start', '-n', 'dev.unkernel.home/.HomeActivity', '-a', 'dev.unkernel.home.SHOW_APPS']);
}
