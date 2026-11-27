// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createKernel } from '../../js/node.ts';
import { startAndroidDisplay } from './display.ts';

const root = resolve(import.meta.dirname, '../..');
const reports = resolve(root, 'vendor/android/framework-reports');
await mkdir(reports, { recursive: true });
const kernel = process.env.ANDROID_KERNEL ?? resolve(root, 'vendor/android/unkernel.wasm');
const cmdline = 'console=hvc0 rdinit=/init loglevel=7 printk.devkmsg=on androidboot.hardware=waydroid androidboot.selinux=permissive androidboot.serialno=unkernel';
const vm = await createKernel({
	kernel, cmdline, memoryMiB: 2048, cpus: 1,
	gpu: true, display: { width: 720, height: 1280 },
	disks: [
		{ kind: 'file', path: resolve(root, 'vendor/android/system/system.img'), readOnly: true },
		{ kind: 'file', path: resolve(root, 'vendor/android/system/vendor.img'), readOnly: true },
	],
	log: message => process.stderr.write(`${message}\n`),
});
let consoleOutput = '';
vm.onOutput(bytes => { consoleOutput = (consoleOutput + new TextDecoder().decode(bytes)).slice(-4_000_000); });
const watchdog = setTimeout(() => void vm.stop(), 780000);
let stage = 'mount';
let display: Awaited<ReturnType<typeof startAndroidDisplay>> | undefined;
try {
	const setupScript = await readFile(new URL('./runtime.sh', import.meta.url), 'utf8');
	const setup = await vm.exec('/bin/sh', ['-ec', setupScript], { signal: AbortSignal.timeout(60000) });
	await writeFile(`${reports}/mount.txt`, JSON.stringify(setup, null, 2));
	if (setup.exitCode !== 0) throw new Error(`System image mount failed: ${setup.stderr}`);
	stage = 'display';
	display = await startAndroidDisplay(vm, reports);
	stage = 'init';
	const init = await vm.spawn('/bin/unshare', ['-m', '-p', '-f', '--mount-proc=/android/proc', '/bin/sh', '-ec', `
mount --make-rprivate /
mount --bind / /
cd /
exec chroot . /bin/sh -ec '
    cd /android
    mkdir -p oldroot
    pivot_root . oldroot
    /oldroot/bin/umount -l /oldroot
    exec /system/bin/init second_stage
'
`], { pty: false, env: display.env });
	let initOutput = '';
	const read = async (stream: ReadableStream<Uint8Array>) => {
		for await (const bytes of stream) initOutput = (initOutput + new TextDecoder().decode(bytes)).slice(-4_000_000);
	};
	const drain = Promise.all([read(init.stdout), read(init.stderr)]);
	const result = await Promise.race([
		drain.then(async () => ({ ended: await init.ended })),
		vm.exec('/bin/sh', ['-ec', `
for i in $(seq 120); do
    children=$(cat /proc/${init.pid}/task/${init.pid}/children 2>/dev/null || true)
    for child in $children; do
        if [ "$(nsenter -t "$child" -m -p /system/bin/getprop sys.boot_completed 2>/dev/null)" = 1 ]; then
            echo sys.boot_completed=1
            exit 0
        fi
        break
    done
    sleep 2
done
exit 1
`], { signal: AbortSignal.timeout(300000) }).then(readiness => ({ readiness })).catch(error => ({ readinessError: String(error) })),
	]);
	await writeFile(`${reports}/init.txt`, initOutput);
	await writeFile(`${reports}/result.json`, JSON.stringify({ stage, ...result }, null, 2));
	const diagnostics = await vm.exec('/bin/sh', ['-c', 'ps -ef; echo KERNEL_LOG; dmesg | tail -300; echo ANDROID_DATA; ls -la /android/data; echo ANDROID_MOUNTS; cat /proc/mounts'], { signal: AbortSignal.timeout(30000) });
	await writeFile(`${reports}/diagnostics.txt`, JSON.stringify(diagnostics, null, 2));
	// APEX mounts belong to Android's mount namespace; inspect its properties there.
	const children = await vm.exec('/bin/cat', [`/proc/${init.pid}/task/${init.pid}/children`]);
	const child = children.stdout.trim().split(/\s+/)[0];
	if (!child || !/^\d+$/.test(child)) throw new Error('Android init exited before framework readiness; inspect the console report');
	const enter = ['-t', child, '-m', '-p'];
	const properties = await vm.exec('/bin/nsenter', [...enter, '/system/bin/getprop'], { signal: AbortSignal.timeout(15000) });
	await writeFile(`${reports}/properties.txt`, JSON.stringify(properties, null, 2));
	const logcat = await vm.exec('/bin/nsenter', [...enter, '/system/bin/logcat', '-b', 'all', '-d', '-t', '10000'], { signal: AbortSignal.timeout(20000) });
	await writeFile(`${reports}/logcat.txt`, JSON.stringify(logcat, null, 2));
	const crashes = await vm.exec('/bin/nsenter', [...enter, '/system/bin/sh', '-c', 'for f in /data/tombstones/tombstone_*; do case "$f" in *.pb) continue;; esac; [ -f "$f" ] && cat "$f"; done'], { signal: AbortSignal.timeout(20000) });
	await writeFile(`${reports}/native-crashes.txt`, JSON.stringify(crashes, null, 2));
	const activity = await vm.exec('/bin/nsenter', [...enter, '/system/bin/dumpsys', 'activity', 'activities'], { signal: AbortSignal.timeout(20000) });
	await writeFile(`${reports}/activities.txt`, JSON.stringify(activity, null, 2));
	// An init process staying alive alone never establishes that Android booted.
	const booted = await vm.exec('/bin/nsenter', [...enter, '/system/bin/getprop', 'sys.boot_completed'], { signal: AbortSignal.timeout(15000) });
	await writeFile(`${reports}/boot-completed.txt`, JSON.stringify(booted, null, 2));
	if (booted.exitCode !== 0 || booted.stdout.trim() !== '1') {
		try {
			const threads = await vm.exec('/bin/nsenter', [...enter, '/system/bin/ps', '-AT', '-o', 'PID,TID,NAME,STAT,TIME,WCHAN'], { signal: AbortSignal.timeout(15000) });
			await writeFile(`${reports}/threads.txt`, JSON.stringify(threads, null, 2));
			const trace = await vm.exec('/bin/nsenter', [...enter, '/system/bin/sh', '-c', 'server=$(pidof system_server); if [ -n "$server" ]; then debuggerd -j "$server"; else debuggerd -b "$(getprop init.svc_debug_pid.zygote)"; fi'], { signal: AbortSignal.timeout(20000) });
			await writeFile(`${reports}/framework-stack.txt`, JSON.stringify(trace, null, 2));
		} catch (error) {
			await writeFile(`${reports}/stack-error.txt`, String(error));
		}
		throw new Error('Android has not reported sys.boot_completed=1; inspect framework reports');
	}
} catch (error) {
	await writeFile(`${reports}/error.txt`, `${stage}: ${error instanceof Error ? error.stack : error}`);
	process.exitCode = 1;
} finally {
	clearTimeout(watchdog);
	await display?.capture().catch(error => writeFile(`${reports}/display-error.txt`, String(error)));
	await display?.close().catch(() => {});
	await writeFile(`${reports}/console.txt`, consoleOutput);
	await vm.stop();
}
