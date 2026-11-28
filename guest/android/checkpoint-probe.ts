// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
// Opt-in full Android snapshot round trip: ANDROID_EXPORT_SEED=1 timeout 1200 node guest/android/checkpoint-probe.ts
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createKernel } from '../../js/node.ts';
import { createHeadless, encodePNG } from 'wland/headless';
import { readSeed, restoreSeed, saveSeed, seedIdentity } from './seed.ts';
import { parseBootAssets } from '../../pages/boot-assets.ts';
import { encodeAndroidCheckpoint, decodeAndroidCheckpoint } from './checkpoint.ts';

const root = resolve(import.meta.dirname, '../..');
const assets = resolve(root, 'dist-pages');
const boot = parseBootAssets(JSON.parse(await readFile(resolve(assets, 'android/boot.json'), 'utf8')));
const options = {
	kernel: resolve(assets, 'runtime/unkernel.wasm'), memoryMiB: 2048, cpus: 1,
	cmdline: 'console=hvc0 rdinit=/init loglevel=3 androidboot.hardware=waydroid androidboot.selinux=permissive androidboot.serialno=unkernel',
	gpu: true, display: { width: 360, height: 640 },
	...(process.env.ANDROID_WISP ? { net: { kind: 'net' as const, backend: { kind: 'wisp' as const, servers: process.env.ANDROID_WISP } } } : {}),
	disks: ['system', 'vendor'].map(name => ({ kind: 'file' as const, path: resolve(assets, `android/${name}.erofs`), readOnly: true })),
};
let vm = await createKernel(options);
let desktop: Awaited<ReturnType<typeof createHeadless>> | undefined;
let namespaceChild: string | undefined;
let exportedSeed = false;
let homeDrawn = false;
const started = performance.now();
const note = (message: string) => console.log(`${((performance.now() - started) / 1000).toFixed(1)}s ${message}`);
const visiblePixels = () => {
	if (!desktop?.windows().length) return 0;
	const pixels = desktop.screenshot();
	let visible = 0;
	for (let i = 0; i < pixels.data.length; i += 4) if (pixels.data[i]! + pixels.data[i + 1]! + pixels.data[i + 2]! > 36) visible++;
	return visible;
};
const waitForPixels = async () => {
	for (let i = 0; i < 240; i++) {
		if (visiblePixels() >= 5000) return;
		await exec('sleep 1');
	}
	throw new Error('Android display did not draw visible content');
};
const exec = async (command: string, input?: Uint8Array) => {
	const result = await vm.exec('/bin/sh', ['-ec', command], { input, env: { ANDROID_DISK_FORMAT: 'erofs' }, signal: AbortSignal.timeout(450000) });
	if (result.exitCode) throw new Error(result.stderr || result.stdout);
	return result.stdout;
};
const exportSeed = async () => {
	if (process.env.ANDROID_EXPORT_SEED !== '1' || !namespaceChild || !homeDrawn || exportedSeed) return;
	const directory = resolve(root, 'vendor/android/web');
	const identity = await seedIdentity(resolve(assets, 'android'), options.kernel, resolve(directory, 'images.json'));
	const manifest = await saveSeed(vm, ['-t', namespaceChild, '-m', '-p'], directory, identity);
	exportedSeed = true;
	note(`Exported prepared data: ${JSON.stringify(manifest)}`);
};
try {
	await exec(await readFile(resolve(assets, 'android/runtime.sh'), 'utf8'));
	await exec('cat > /android/system/app/BrowserHome/BrowserHome.apk; chmod 644 /android/system/app/BrowserHome/BrowserHome.apk', await readFile(resolve(assets, 'android/home.apk')));
	if (process.env.ANDROID_DATA_SEED) {
		const identity = await seedIdentity(resolve(assets, 'android'), options.kernel, resolve(root, 'vendor/android/web/images.json'));
		const seed = await readSeed(process.env.ANDROID_DATA_SEED, identity);
		await restoreSeed(vm, seed.data);
		note('Loaded prepared data');
	}
	const listener = vm.vsock!.listen(1023);
	desktop = await createHeadless({ link: listener, width: 360, height: 640 });
	await exec('mkdir -p /android/run/wayland; chmod 777 /android/run/wayland; cat >/android/system/bin/unkernel-wlandr; chmod 755 /android/system/bin/unkernel-wlandr', await readFile(resolve(assets, 'android/wlandr')));
	await exec('XDG_RUNTIME_DIR=/android/run/wayland setsid /android/system/bin/unkernel-wlandr --link vsock:2:1023 --buffers copy --display wayland-0 --xwayland off --profile session </dev/null >/tmp/relay.log 2>&1 &', undefined);
	await exec('for i in $(seq 100); do [ ! -S /android/run/wayland/wayland-0 ] || { chmod 777 /android/run/wayland/wayland-0; exit 0; }; sleep .1; done; cat /tmp/relay.log >&2; exit 1');
	await exec('cat >/tmp/start-android; chmod +x /tmp/start-android', await readFile(resolve(assets, 'android/start-init.sh')));
	const parent = (await exec('XDG_RUNTIME_DIR=/run/wayland WAYLAND_DISPLAY=wayland-0 setsid /bin/unshare -m -p -f --mount-proc=/android/proc /bin/sh /tmp/start-android </dev/null >/tmp/android-init.log 2>&1 & echo $! > /tmp/android-init-parent; cat /tmp/android-init-parent')).trim();
	note(`Android init parent ${parent}`);
	const child = (await exec(`for i in $(seq 400); do for child in $(cat /proc/${parent}/task/${parent}/children 2>/dev/null); do if [ "$(nsenter -t "$child" -m -p /system/bin/getprop sys.boot_completed 2>/dev/null)" = 1 ]; then echo "$child"; exit 0; fi; break; done; sleep 1; done; tail -50 /tmp/android-init.log >&2; exit 1`)).trim();
	namespaceChild = child;
	note(`Boot complete, namespace ${child}, windows ${desktop.windows().length}`);
	await exec(`nsenter -t ${child} -m -p /system/bin/cmd package set-home-activity --user 0 dev.unkernel.home/.HomeActivity`);
	await exec(`nsenter -t ${child} -m -p /system/bin/am start -a android.intent.action.MAIN -c android.intent.category.HOME`);
	await exec(`for i in $(seq 60); do if nsenter -t ${child} -m -p /system/bin/dumpsys activity activities | grep -q 'topResumedActivity.*dev.unkernel.home/'; then exit 0; fi; sleep 1; done; exit 1`);
	await waitForPixels();
	const inputReady = () => exec(`nsenter -t ${child} -m -p /system/bin/dumpsys -t 15 activity dev.unkernel.home/.HomeActivity | grep -q 'View Hierarchy:'`);
	await inputReady();
	const coldReadyMs = performance.now() - started;
	note('Cold Home drawn and UI thread responding');
	homeDrawn = true;
	// Closing lmkd's PSI trigger descriptors destroys the non-parkable psimon kthread.
	await exec(`nsenter -t ${child} -m -p /system/bin/setprop ctl.stop lmkd; for i in $(seq 30); do if ! ps -ef | grep -q '[p]simon'; then exit 0; fi; sleep 1; done; ps -ef >&2; exit 1`);
	note(`Capturing snapshot with ${desktop.windows().length} windows`);
	let snapshot;
	try {
		snapshot = await vm.snapshot({ dropCaches: true });
	} finally {
		await exportSeed();
	}
	note(`Captured ${(snapshot.memory.byteLength - (snapshot.freeBytes ?? 0)) / 1048576} MiB used`);
	desktop.dispose(); desktop = undefined; listener.close();
	await vm.stop();
	const encodeStarted = performance.now();
	const blob = await encodeAndroidCheckpoint(snapshot);
	note(`Serialized checkpoint ${(blob.size / 1048576).toFixed(1)} MiB in ${((performance.now() - encodeStarted) / 1000).toFixed(1)}s`);
	const restoreStarted = performance.now();
	snapshot = await decodeAndroidCheckpoint(blob);
	vm = await createKernel({ ...options, restore: snapshot });
	await exec(`nsenter -t ${child} -m -p /system/bin/setprop ctl.start lmkd`);
	const restoredListener = vm.vsock!.listen(1023);
	desktop = await createHeadless({ link: restoredListener, width: 360, height: 640 });
	for (let i = 0; i < 30 && !desktop.windows().length; i++) await exec('sleep 1');
	await waitForPixels();
	await inputReady();
	const restoredReadyMs = performance.now() - restoreStarted;
	note(`Restored Home responding in ${(restoredReadyMs / 1000).toFixed(1)}s, including decompression`);
	if (process.env.ANDROID_WISP) {
		// Click the launcher's visible Check internet button through Wayland.
		desktop.pointerMove(180, 281);
		desktop.click(180, 282);
		await exec(`for i in $(seq 60); do\nnsenter -t ${child} -m -p /system/bin/logcat -d -s BrowserHome:I '*:S' | grep -q 'Network HTTP 200' && exit 0\nsleep 1\ndone\nexit 1`);
		await inputReady();
		note('Restored Wayland click triggered Android HTTPS through WISP: HTTP 200');
	}
	await writeFile('/tmp/android-checkpoint-timing.json', JSON.stringify({ coldReadyMs, restoredReadyMs, checkpointBytes: blob.size, wisp: !!process.env.ANDROID_WISP }, null, 2));
	const state = await exec(`nsenter -t ${child} -m -p /system/bin/getprop sys.boot_completed; cat /tmp/relay.log; ps -ef | head -15`);
	note(`Restored ${desktop.windows().length} windows; ${state}`);
	if (!desktop.windows().length) throw new Error('No Android window reconnected after restore');
	const pixels = desktop.screenshot();
	const visible = visiblePixels();
	if (visible < 5000) throw new Error('Restored Android window did not draw visible content');
	await writeFile('/tmp/android-checkpoint-restored.png', await encodePNG(pixels));
	note(`Restored screenshot ${pixels.width}x${pixels.height}, ${visible} visible pixels`);
	if (process.env.ANDROID_EXPORT_CHECKPOINT) {
		const directory = resolve(process.env.ANDROID_EXPORT_CHECKPOINT);
		const data = new Uint8Array(await blob.arrayBuffer());
		await mkdir(directory, { recursive: true });
		await writeFile(resolve(directory, 'startup.gz'), data);
		await writeFile(resolve(directory, 'startup.json'), JSON.stringify({
			version: 1, codec: 'gzip', identity: boot.identity, cpus: 1, network: !!process.env.ANDROID_WISP,
			diskBytes: await Promise.all(options.disks.map(disk => stat(disk.path).then(value => value.size))),
			bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'),
		}, null, 2));
		note(`Exported verified startup to ${directory}`);
	}

} finally {
	try {
		await exportSeed();
	} finally {
		desktop?.dispose();
		await vm.stop();
	}
}
