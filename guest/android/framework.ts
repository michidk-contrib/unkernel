// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createKernel } from '../../js/node.ts';
import { startAndroidDisplay } from './display.ts';
import { encodePNG } from 'wland/headless';
import { seedIdentity, readSeed, restoreSeed, saveSeed } from './seed.ts';

const root = resolve(import.meta.dirname, '../..');
const launcherPath = process.env.ANDROID_RUNTIME_DIR ? resolve(process.env.ANDROID_RUNTIME_DIR, 'home.apk') : resolve(root, 'vendor/android/launcher/home.apk');
const reports = resolve(process.env.ANDROID_REPORTS ?? `${root}/vendor/android/framework-reports`);
const startedAt = performance.now();
await mkdir(reports, { recursive: true });
const kernel = process.env.ANDROID_KERNEL ?? resolve(root, 'vendor/android/unkernel.wasm');
const cmdline = 'console=hvc0 rdinit=/init loglevel=7 printk.devkmsg=on androidboot.hardware=waydroid androidboot.selinux=permissive androidboot.serialno=unkernel';
const vm = await createKernel({
	kernel, cmdline, memoryMiB: 2048, cpus: Number(process.env.ANDROID_CPUS ?? 1),
	gpu: true, display: { width: 360, height: 640 },
	net: process.env.ANDROID_WISP ? { kind: 'net', backend: { kind: 'wisp', servers: process.env.ANDROID_WISP } } : undefined,
	disks: [
		{ kind: 'file', path: process.env.ANDROID_SYSTEM_IMAGE ?? resolve(root, 'vendor/android/system/system.img'), readOnly: true },
		{ kind: 'file', path: process.env.ANDROID_VENDOR_IMAGE ?? resolve(root, 'vendor/android/system/vendor.img'), readOnly: true },
	],
	log: message => process.stderr.write(`${message}\n`),
});
let consoleOutput = '';
vm.onOutput(bytes => { consoleOutput = (consoleOutput + new TextDecoder().decode(bytes)).slice(-4_000_000); });
const watchdog = setTimeout(() => void vm.stop(), 1080000);
let stage = 'mount';
let display: Awaited<ReturnType<typeof startAndroidDisplay>> | undefined;
let androidNamespace: string[] | undefined;
let diagnosticTicker: ReturnType<typeof setInterval> | undefined;
let writingDiagnostics = false;
let androidLog = '';
try {
	const setupScript = await readFile(resolve(process.env.ANDROID_RUNTIME_DIR ?? import.meta.dirname, 'runtime.sh'), 'utf8');
	const setup = await vm.exec('/bin/sh', ['-ec', setupScript], { env: { ANDROID_DISK_FORMAT: process.env.ANDROID_DISK_FORMAT ?? 'ext4' }, signal: AbortSignal.timeout(60000) });
	await writeFile(`${reports}/mount.txt`, JSON.stringify(setup, null, 2));
	if (setup.exitCode !== 0) throw new Error(`System image mount failed: ${setup.stderr}`);
	const launcher = await vm.exec('/bin/sh', ['-ec', 'cat > /android/system/app/BrowserHome/BrowserHome.apk; chmod 644 /android/system/app/BrowserHome/BrowserHome.apk'], {
		input: await readFile(launcherPath), signal: AbortSignal.timeout(30000),
	});
	if (launcher.exitCode !== 0) throw new Error('Cannot install Browser Home in the Android system overlay');
	if (process.env.ANDROID_CPUS && vm.stats().cpus !== Number(process.env.ANDROID_CPUS)) throw new Error('Android did not start the requested number of CPUs');
	if (process.env.ANDROID_DATA_SEED) {
		const identity = await seedIdentity(process.env.ANDROID_RUNTIME_DIR ?? import.meta.dirname, kernel, resolve(root, 'vendor/android/web/images.json'), launcherPath);
		const seed = await readSeed(process.env.ANDROID_DATA_SEED, identity);
		await restoreSeed(vm, seed.data);
	}
	stage = 'display';
	display = await startAndroidDisplay(vm, reports);
	stage = 'init';
	const init = await vm.spawn('/bin/unshare', ['-m', '-p', '-f', '--mount-proc=/android/proc', '/bin/sh', '-ec', await readFile(resolve(process.env.ANDROID_RUNTIME_DIR ?? import.meta.dirname, 'start-init.sh'), 'utf8')], { pty: false, env: display.env });
	let initOutput = '';
	const read = async (stream: ReadableStream<Uint8Array>) => {
		for await (const bytes of stream) initOutput = (initOutput + new TextDecoder().decode(bytes)).slice(-4_000_000);
	};
	const drain = Promise.all([read(init.stdout), read(init.stderr)]);
	const logs = await vm.spawn('/bin/sh', ['-c', `
for i in $(seq 300); do
    for child in $(cat /proc/${init.pid}/task/${init.pid}/children 2>/dev/null); do
        if [ -S "/proc/$child/root/dev/socket/logdr" ] && [ "$(nsenter -t "$child" -m -p /system/bin/getprop logd.ready 2>/dev/null)" = true ]; then
            exec nsenter -t "$child" -m -p /system/bin/logcat -v brief
        fi
    done
    sleep 1
done`], { pty: false });
	const collect = async (stream: ReadableStream<Uint8Array>) => {
		for await (const bytes of stream) androidLog = (androidLog + new TextDecoder().decode(bytes)).slice(-500_000);
	};
	void Promise.all([collect(logs.stdout), collect(logs.stderr)]).catch(() => {});
	diagnosticTicker = setInterval(() => {
		if (writingDiagnostics) return;
		writingDiagnostics = true;
		void (async () => {
			await writeFile(`${reports}/live-logcat.txt`, androidLog);
			await writeFile(`${reports}/live-init.txt`, initOutput);
			await writeFile(`${reports}/live-console.txt`, consoleOutput.slice(-96000));
			if (display?.desktop.windows().length) await writeFile(`${reports}/live.png`, await encodePNG(display.desktop.screenshot()));
		})().catch(() => {}).finally(() => { writingDiagnostics = false; });
	}, 30000);
	const result = await Promise.race([
		drain.then(async () => ({ ended: await init.ended })),
		vm.exec('/bin/sh', ['-ec', `
for i in $(seq 300); do
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
`], { signal: AbortSignal.timeout(630000) }).then(readiness => ({ readiness })).catch(error => ({ readinessError: String(error) })),
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
	androidNamespace = enter;
	const properties = await vm.exec('/bin/nsenter', [...enter, '/system/bin/getprop'], { signal: AbortSignal.timeout(15000) });
	await writeFile(`${reports}/properties.txt`, JSON.stringify(properties, null, 2));
	const logcat = await vm.exec('/bin/nsenter', [...enter, '/system/bin/logcat', '-b', 'main', '-b', 'system', '-b', 'crash', '-d', '-t', '3000'], { signal: AbortSignal.timeout(60000) }).catch(error => ({ error: String(error) }));
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
	stage = 'launcher';
	const home = await vm.exec('/bin/nsenter', [...enter, '/system/bin/cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.HOME'], { signal: AbortSignal.timeout(30000) });
	await writeFile(`${reports}/home-activity.txt`, JSON.stringify(home, null, 2));
	const homeComponent = home.stdout.trim().split('\n').at(-1) ?? '';
	if (home.exitCode !== 0 || !/^[\w.]+\/[\w.$]+$/.test(homeComponent)) throw new Error('Android has no resolvable Home activity');
	const selectHome = await vm.exec('/bin/nsenter', [...enter, '/system/bin/cmd', 'package', 'set-home-activity', '--user', '0', 'dev.unkernel.home/.HomeActivity'], { signal: AbortSignal.timeout(30000) });
	if (selectHome.exitCode !== 0) throw new Error(`Cannot select Browser Home: ${selectHome.stderr}`);
	const homePackage = 'dev.unkernel.home';
	const waitForActivity = async (packageName: string, name: string) => {
		for (let i = 0; i < 30; i++) {
			const current = await vm.exec('/bin/nsenter', [...enter, '/system/bin/dumpsys', 'activity', 'activities'], { signal: AbortSignal.timeout(15000) });
			await writeFile(`${reports}/${name}.txt`, JSON.stringify(current, null, 2));
			if (current.stdout.split('\n').some(line => /(?:mResumedActivity|topResumedActivity)[:=]/.test(line) && line.includes(`${packageName}/`))) return;
			await new Promise(resolve => setTimeout(resolve, 1000));
		}
		throw new Error(`${packageName} did not become the resumed Android activity`);
	};
	for (const setting of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) {
		const configured = await vm.exec('/bin/nsenter', [...enter, '/system/bin/cmd', 'settings', 'put', 'global', setting, '0'], { signal: AbortSignal.timeout(30000) });
		if (configured.exitCode !== 0) throw new Error(`Cannot disable Android animation: ${configured.stderr}`);
	}
	const launchHome = await vm.exec('/bin/nsenter', [...enter, '/system/bin/am', 'start', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.HOME'], { signal: AbortSignal.timeout(60000) });
	await writeFile(`${reports}/launch-home.txt`, JSON.stringify(launchHome, null, 2));
	await waitForActivity(homePackage, 'launcher');
	for (let i = 0; i < 180; i++) {
		const frame = display.desktop.screenshot();
		let visiblePixels = 0;
		for (let pixel = 0; pixel < frame.data.length; pixel += 4) {
			if (frame.data[pixel]! > 16 || frame.data[pixel + 1]! > 16 || frame.data[pixel + 2]! > 16) visiblePixels++;
		}
		if (visiblePixels >= 5000) break;
		if (i === 179) throw new Error('Home is resumed but the display remains blank');
		await new Promise(resolve => setTimeout(resolve, 1000));
	}
	stage = 'launcher-input';
	const inputReady = await vm.exec('/bin/nsenter', [...enter, '/system/bin/sh', '-ec', `
for i in $(seq 60); do
	if dumpsys input | sed -n '/^  FocusedWindows:/,/^  FocusRequests:/p' | grep -q 'dev.unkernel.home/' &&
	   dumpsys -t 5 activity dev.unkernel.home/.HomeActivity | grep -q 'View Hierarchy:'; then
		exit 0
	fi
	sleep 2
done
echo 'Launcher is drawn but its UI thread is not responding' >&2
exit 1`], { signal: AbortSignal.timeout(450000) });
	await writeFile(`${reports}/launcher-input-ready.txt`, JSON.stringify(inputReady, null, 2));
	if (inputReady.exitCode !== 0) throw new Error('Launcher has not become responsive; prepared data will not be exported');
	const launcherFrame = display.desktop.screenshot();
	await writeFile(`${reports}/launcher.png`, await encodePNG(launcherFrame));
	await writeFile(`${reports}/timing.json`, JSON.stringify({ launcherMs: Math.round(performance.now() - startedAt), cpus: vm.stats().cpus, preparedData: !!process.env.ANDROID_DATA_SEED }));
	if (process.env.ANDROID_WISP) {
		stage = 'network';
		await vm.exec('/bin/nsenter', [...enter, '/system/bin/am', 'start', '-n', 'dev.unkernel.home/.HomeActivity', '-a', 'dev.unkernel.home.CHECK_NETWORK'], { signal: AbortSignal.timeout(30000) });
		let connected = false;
		for (let i = 0; i < 60; i++) {
			const network = await vm.exec('/bin/nsenter', [...enter, '/system/bin/logcat', '-d', '-s', 'BrowserHome:I', '*:S'], { signal: AbortSignal.timeout(15000) });
			await writeFile(`${reports}/network-check.txt`, network.stdout);
			if (/Network HTTP 200/.test(network.stdout)) { connected = true; break; }
			if (network.stdout.includes('Network failed:')) break;
			await new Promise(resolve => setTimeout(resolve, 1000));
		}
		if (!connected) throw new Error('Android app HTTPS check through WISP failed');
		await vm.exec('/bin/nsenter', [...enter, '/system/bin/am', 'start', '-n', 'dev.unkernel.home/.HomeActivity', '-a', 'android.intent.action.MAIN'], { signal: AbortSignal.timeout(30000) });
	}
	if (process.env.ANDROID_EXPORT_SEED) {
		const identity = await seedIdentity(process.env.ANDROID_RUNTIME_DIR ?? import.meta.dirname, kernel, resolve(root, 'vendor/android/web/images.json'), launcherPath);
		const seed = await saveSeed(vm, enter, process.env.ANDROID_EXPORT_SEED, identity);
		await writeFile(`${reports}/seed-export.json`, JSON.stringify(seed, null, 2));
	} else {
		stage = 'input';
		const settings = await vm.exec('/bin/nsenter', [...enter, '/system/bin/am', 'start', '-a', 'android.settings.SETTINGS'], { signal: AbortSignal.timeout(60000) });
		await writeFile(`${reports}/launch-settings.txt`, JSON.stringify(settings, null, 2));
		await waitForActivity('com.android.settings', 'settings');
		for (let i = 0; i < 180; i++) {
			const frame = display.desktop.screenshot();
			let changedPixels = 0;
			for (let pixel = 0; pixel < frame.data.length; pixel += 4) {
				if (frame.data[pixel] !== launcherFrame.data[pixel] || frame.data[pixel + 1] !== launcherFrame.data[pixel + 1] || frame.data[pixel + 2] !== launcherFrame.data[pixel + 2]) changedPixels++;
			}
			if (changedPixels >= 10000) break;
			if (i === 179) throw new Error('Settings is resumed but its display has not replaced Home');
			await new Promise(resolve => setTimeout(resolve, 1000));
		}
		await writeFile(`${reports}/settings.png`, await encodePNG(display.desktop.screenshot()));
		// Use an app control that is already visible; SystemUI's nav bar can arrive later.
		// Waydroid updates its cursor position on motion, not the initial enter event.
		display.desktop.pointerMove(180, 309);
		display.desktop.click(180, 310);
		let networkOpened = false;
		for (let i = 0; i < 60; i++) {
			const current = await vm.exec('/bin/nsenter', [...enter, '/system/bin/dumpsys', 'activity', 'activities'], { signal: AbortSignal.timeout(15000) });
			await writeFile(`${reports}/network-after-pointer.txt`, JSON.stringify(current, null, 2));
			if (current.stdout.split('\n').some(line => /(?:mResumedActivity|topResumedActivity)[:=]/.test(line) && line.includes('com.android.settings/.SubSettings'))) {
				const page = await vm.exec('/bin/nsenter', [...enter, '/system/bin/dumpsys', '-t', '60', 'activity', 'com.android.settings/.SubSettings'], { signal: AbortSignal.timeout(90000) });
				await writeFile(`${reports}/network-fragment.txt`, JSON.stringify(page, null, 2));
				if (page.stdout.includes('NetworkDashboardFragment')) {
					networkOpened = true;
					break;
				}
			}
			await new Promise(resolve => setTimeout(resolve, 1000));
		}
		if (!networkOpened) throw new Error('Wayland pointer click did not open the Network & internet activity');
		await writeFile(`${reports}/input-verified.txt`, 'Wayland pointer click opened Network & internet from Settings.\n');
	}
} catch (error) {
	await writeFile(`${reports}/error.txt`, `${stage}: ${error instanceof Error ? error.stack : error}`);
	process.exitCode = 1;
	if (androidNamespace) {
		for (const [name, command] of [
			['launcher-stack', ['sh', '-c', 'pid=$(pidof dev.unkernel.home); [ -n "$pid" ] && debuggerd -j "$pid"']],
			['surfaceflinger', ['dumpsys', 'SurfaceFlinger']],
			['window', ['dumpsys', 'window', 'windows']],
			['latest-logcat', ['logcat', '-b', 'main', '-b', 'system', '-b', 'crash', '-d', '-t', '3000']],
		] satisfies [string, string[]][]) {
			try {
				const diagnostic = await vm.exec('/bin/nsenter', [...androidNamespace, `/system/bin/${command[0]}`, ...command.slice(1)], { signal: AbortSignal.timeout(60000) });
				await writeFile(`${reports}/${name}.txt`, JSON.stringify(diagnostic, null, 2));
			} catch (diagnosticError) {
				await writeFile(`${reports}/${name}-error.txt`, String(diagnosticError));
			}
		}
	}
} finally {
	clearInterval(diagnosticTicker);
	clearTimeout(watchdog);
	await display?.capture().catch(error => writeFile(`${reports}/display-error.txt`, String(error)));
	await display?.close().catch(() => {});
	await writeFile(`${reports}/console.txt`, consoleOutput);
	await vm.stop();
}
