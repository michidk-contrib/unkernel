// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createKernel } from '../../js/node.ts';

const root = resolve(import.meta.dirname, '../..');
const reports = resolve(root, 'vendor/android/framework-reports');
await mkdir(reports, { recursive: true });
const kernel = process.env.ANDROID_KERNEL ?? resolve(root, 'vendor/android/unkernel.wasm');
const cmdline = 'console=hvc0 rdinit=/init loglevel=7 androidboot.hardware=waydroid androidboot.selinux=permissive androidboot.serialno=unkernel';
const vm = await createKernel({
	kernel, cmdline, memoryMiB: 2048, cpus: 1,
	disks: [
		{ kind: 'file', path: resolve(root, 'vendor/android/system/system.img'), readOnly: true },
		{ kind: 'file', path: resolve(root, 'vendor/android/system/vendor.img'), readOnly: true },
	],
	log: message => process.stderr.write(`${message}\n`),
});
let consoleOutput = '';
vm.onOutput(bytes => { consoleOutput = (consoleOutput + new TextDecoder().decode(bytes)).slice(-4_000_000); });
const watchdog = setTimeout(() => void vm.stop(), 240000);
let stage = 'mount';
try {
	const setup = await vm.exec('/bin/sh', ['-ec', `
mkdir -p /android-lower /android-rw /android
mount -t ext4 -o ro /dev/wda /android-lower
mount -t tmpfs -o size=256m tmpfs /android-rw
mkdir -p /android-rw/upper /android-rw/work
mount -t overlay overlay -o lowerdir=/android-lower,upperdir=/android-rw/upper,workdir=/android-rw/work /android
mount -t ext4 -o ro /dev/wdb /android/vendor
mount --rbind /dev /android/dev
mount --rbind /sys /android/sys
mount -t tmpfs -o size=512m,mode=0771,uid=1000,gid=1000 tmpfs /android/data
mount -t tmpfs -o mode=0755 tmpfs /android/linkerconfig
ls -l /android/init /android/system/bin/init /android/system/bin/bootstrap
cat /proc/filesystems
`], { signal: AbortSignal.timeout(60000) });
	await writeFile(`${reports}/mount.txt`, JSON.stringify(setup, null, 2));
	if (setup.exitCode !== 0) throw new Error(`System image mount failed: ${setup.stderr}`);
	stage = 'init';
	const init = await vm.spawn('/bin/unshare', ['-m', '-p', '-f', '--mount-proc=/android/proc', '/bin/chroot', '/android', '/system/bin/init', 'second_stage']);
	let initOutput = '';
	const drain = (async () => {
		for await (const bytes of init.output) initOutput = (initOutput + new TextDecoder().decode(bytes)).slice(-4_000_000);
	})();
	const result = await Promise.race([
		drain.then(async () => ({ ended: await init.ended })),
		new Promise<{ timeout: true }>(r => { const timer = setTimeout(() => r({ timeout: true }), 120000); timer.unref(); }),
	]);
	await writeFile(`${reports}/init.txt`, initOutput);
	await writeFile(`${reports}/result.json`, JSON.stringify({ stage, ...result }, null, 2));
	const diagnostics = await vm.exec('/bin/sh', ['-c', 'ps -ef; echo KERNEL_LOG; dmesg | tail -300; echo ANDROID_DATA; ls -la /android/data; echo ANDROID_PROPERTIES; /bin/chroot /android /system/bin/getprop'], { signal: AbortSignal.timeout(30000) });
	await writeFile(`${reports}/diagnostics.txt`, JSON.stringify(diagnostics, null, 2));
	// An init process staying alive alone never establishes that Android booted.
	const booted = await vm.exec('/bin/chroot', ['/android', '/system/bin/getprop', 'sys.boot_completed'], { signal: AbortSignal.timeout(15000) });
	await writeFile(`${reports}/boot-completed.txt`, JSON.stringify(booted, null, 2));
	if (booted.exitCode !== 0 || booted.stdout.trim() !== '1') throw new Error('Android has not reported sys.boot_completed=1; inspect framework reports');
} catch (error) {
	await writeFile(`${reports}/error.txt`, `${stage}: ${error instanceof Error ? error.stack : error}`);
	process.exitCode = 1;
} finally {
	clearTimeout(watchdog);
	await writeFile(`${reports}/console.txt`, consoleOutput);
	await vm.stop();
}
