// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
// Verify the distributed startup through HTTP, including its real Wayland input path.
import { writeFile } from 'node:fs/promises';
import { createKernel } from '../../js/node.ts';
import { createHeadless, encodePNG } from 'wland/headless';
import { parseBootAssets } from '../../pages/boot-assets.ts';
import { bindStartupDisks, fetchStartupCheckpoint } from './startup.ts';

const started = performance.now();
const origin = process.env.ANDROID_STARTUP_ORIGIN;
if (!origin) throw new Error('Set ANDROID_STARTUP_ORIGIN to the packaged Pages server');
const signal = AbortSignal.timeout(180000);
const boot = parseBootAssets(await (await fetch(new URL('android/boot.json', origin), { signal })).json());
if (!boot.startup || !boot.startup.network) throw new Error('Build with a network-enabled prebooted Android artifact');
const asset = (path: string) => {
	const url = new URL(path, origin); url.searchParams.set('v', boot.identity); return url.href;
};
const snapshot = await fetchStartupCheckpoint(asset(`android/startup.${boot.startup.codec === 'gzip' ? 'gz' : 'zst'}`), boot.startup, signal, () => {});
const urls: [string, string] = [asset('android/system.erofs'), asset('android/vendor.erofs')];
await bindStartupDisks(snapshot, boot.startup, urls, signal);
const vm = await createKernel({
	kernel: asset('runtime/unkernel.wasm'), memoryMiB: 2048, cpus: 1, restore: snapshot,
	gpu: true, display: { width: 360, height: 640 },
	net: { kind: 'net', backend: { kind: 'wisp', servers: process.env.ANDROID_WISP ?? 'wss://wisp.mercurywork.shop/' } },
	disks: urls.map(url => ({ kind: 'http', url, readOnly: true })), signal,
});
let desktop: Awaited<ReturnType<typeof createHeadless>> | undefined;
try {
	const listener = vm.vsock!.listen(1023);
	desktop = await createHeadless({ link: listener, width: 360, height: 640 });
	const exec = async (command: string) => {
		const result = await vm.exec('/bin/sh', ['-ec', command], { signal });
		if (result.exitCode) throw new Error(result.stderr || result.stdout || 'Guest command failed');
		return result.stdout;
	};
	const parent = (await exec('cat /tmp/android-init-parent')).trim();
	if (!/^[1-9][0-9]*$/.test(parent)) throw new Error('Missing Android init parent');
	const child = (await exec(`cat /proc/${parent}/task/${parent}/children`)).trim().split(/\s+/)[0];
	if (!child || !/^[1-9][0-9]*$/.test(child)) throw new Error('Missing Android namespace');
	const android = `nsenter -t ${child} -m -p /system/bin/`;
	await exec(`${android}setprop ctl.start lmkd`);
	for (let i = 0; i < 90; i++) {
		if (desktop.windows().length) {
			const pixels = desktop.screenshot().data;
			let visible = 0;
			for (let j = 0; j < pixels.length; j += 4) if (pixels[j]! + pixels[j + 1]! + pixels[j + 2]! > 36) visible++;
			if (visible > 5000) break;
		}
		if (i === 89) throw new Error('Restored display did not draw');
		await exec('sleep 1');
	}
	await exec(`${android}dumpsys -t 15 activity dev.unkernel.home/.HomeActivity | grep -q 'View Hierarchy:'`);
	const readyMs = performance.now() - started;
	console.log(`HTTP startup ready in ${(readyMs / 1000).toFixed(1)}s including download and decompression`);
	const successes = `${android}logcat -d -s BrowserHome:I '*:S' | grep -c 'Network HTTP 200' || true`;
	const before = Number((await exec(successes)).trim());
	if (!Number.isSafeInteger(before) || before < 0) throw new Error('Invalid Android network log count');
	desktop.pointerMove(180, 281); desktop.click(180, 282);
	await exec(`for i in $(seq 60); do [ \"$(${successes})\" -gt ${before} ] && exit 0; sleep 1; done; exit 1`);
	await writeFile('/tmp/android-startup-restored.png', await encodePNG(desktop.screenshot()));
	await writeFile('/tmp/android-startup-timing.json', JSON.stringify({ readyMs, pointerHttps200: true, checkpointBytes: boot.startup.bytes }, null, 2));
	console.log('Actual Wayland click triggered Android HTTPS 200 after HTTP checkpoint restore');
} finally { desktop?.dispose(); await vm.stop(); }
