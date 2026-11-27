// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
import { createWland, createStreamLink } from 'wland/client';
import type { KernelInstance } from '../js/web.ts';

function element<T extends HTMLElement>(id: string, ctor: { new(...args: never[]): T }): T {
	const value = document.getElementById(id);
	if (!(value instanceof ctor)) throw new Error(`Missing element: ${id}`);
	return value;
}
const start = element('start', HTMLButtonElement);
const stop = element('stop', HTMLButtonElement);
const memory = element('memory', HTMLSelectElement);
const status = element('status', HTMLSpanElement);
const error = element('error', HTMLParagraphElement);
const light = element('light', HTMLSpanElement);
const screen = element('display', HTMLDivElement);
const placeholder = element('placeholder', HTMLParagraphElement);
const progress = element('progress', HTMLSpanElement);
const reportButton = element('report', HTMLButtonElement);
let startupLog = '';
let startedAt = 0;
let lastStats: ReturnType<KernelInstance['stats']> | undefined;
function appendLog(text: string): void { startupLog = (startupLog + text).slice(-96000); }
function visiblePixels(): number {
	for (const canvas of screen.querySelectorAll('canvas')) {
		if (canvas.width < 100 || canvas.height < 100) continue;
		const pixels = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
		if (!pixels) continue;
		let count = 0;
		for (let i = 0; i < pixels.length; i += 4) {
			if (pixels[i]! > 16 || pixels[i + 1]! > 16 || pixels[i + 2]! > 16) count++;
		}
		if (count >= 5000) return count;
	}
	return 0;
}
reportButton.addEventListener('click', () => {
	const url = URL.createObjectURL(new Blob([JSON.stringify({
		status: status.textContent, error: error.textContent, elapsedSeconds: Math.round((performance.now() - startedAt) / 1000),
		browser: navigator.userAgent, isolated: crossOriginIsolated, visibility: document.visibilityState, stats: lastStats, log: startupLog,
	}, null, 2)], { type: 'application/json' }));
	const link = document.createElement('a');
	link.href = url; link.download = 'android-startup.json'; link.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
});
let vm: KernelInstance | undefined;
let desktop: Awaited<ReturnType<typeof createWland>> | undefined;
let controller: AbortController | undefined;
let busy = false;
function report(cause: unknown): void {
	error.textContent = cause instanceof Error ? cause.message : String(cause);
	error.hidden = false;
}
function controls(): void {
	start.disabled = busy || !!vm;
	memory.disabled = busy || !!vm;
	stop.disabled = !controller;
}
async function shutdown(): Promise<void> {
	controller?.abort();
	controller = undefined;
	desktop?.dispose();
	desktop = undefined;
	const old = vm;
	vm = undefined;
	await old?.stop();
	light.classList.remove('running');
	placeholder.hidden = false;
	placeholder.textContent = 'Your Android display will appear here.';
	controls();
}
async function checkedFetch(path: string, signal: AbortSignal): Promise<Response> {
	const response = await fetch(new URL(path, document.baseURI), { signal });
	if (!response.ok) throw new Error(`Download failed: ${path} (HTTP ${response.status})`);
	return response;
}
async function boot(): Promise<void> {
	busy = true;
	error.hidden = true;
	error.textContent = '';
	startupLog = '';
	startedAt = performance.now();
	lastStats = undefined;
	reportButton.hidden = false;
	placeholder.hidden = false;
	const session = new AbortController();
	controller = session;
	const signal = session.signal;
	controls();
	const updateProgress = () => {
		lastStats = vm?.stats() ?? lastStats;
		const seconds = Math.round((performance.now() - startedAt) / 1000);
		progress.textContent = `${Math.floor(seconds / 60)}m ${seconds % 60}s elapsed${lastStats ? ` · ${(lastStats.block.bytesRead / 1048576).toFixed(0)} MiB read from Android disks` : ''}${document.hidden ? ' · Keep this tab visible to continue startup' : ''}`;
		if (controller === session) {
			placeholder.textContent = `${status.textContent} First boot can take 10–20 minutes. Keep this tab visible.`;
			placeholder.hidden = visiblePixels() >= 5000;
		}
	};
	const ticker = setInterval(updateProgress, 1000);
	const deadline = setTimeout(() => {
		report(new Error('Android did not show its interface within 20 minutes. Download the startup report to inspect the stalled boot.'));
		session.abort();
	}, 20 * 60 * 1000);
	try {
		status.textContent = 'Checking browser support…';
		const url = new URL('./runtime/web.mjs', document.baseURI).href;
		const sdk: typeof import('../js/web.ts') = await import(/* @vite-ignore */ url);
		const support = await sdk.checkSupport();
		if (!support.ok) throw new Error(`${support.problems.join('. ')}. Use a current Chrome or Chromium browser with JSPI support.`);
		if (!crossOriginIsolated) throw new Error('Browser isolation is not active. Reload once after the service worker installs, and allow service workers for this site.');
		const [runtime, initScript, relay] = await Promise.all([
			checkedFetch('./android/runtime.sh', signal).then(response => response.text()),
			checkedFetch('./android/start-init.sh', signal).then(response => response.text()),
			checkedFetch('./android/wlandr', signal).then(response => response.arrayBuffer()),
		]);
		status.textContent = 'Booting Linux and opening Android disks…';
		const instance = await sdk.createKernel({
			memoryMiB: Number(memory.value), memoryFallbackMiB: [], cpus: 1, signal,
			cmdline: 'console=hvc0 rdinit=/init loglevel=3 androidboot.hardware=waydroid androidboot.selinux=permissive androidboot.serialno=unkernel',
			gpu: true, display: { width: 360, height: 640 },
			disks: ['system', 'vendor'].map(name => ({ kind: 'http', url: new URL(`./android/${name}.erofs`, document.baseURI).href, readOnly: true })),
			log: message => appendLog(`${message}\n`),
			onOutput: bytes => appendLog(new TextDecoder().decode(bytes)),
		});
		vm = instance;
		signal.throwIfAborted();
		const exec = async (command: string, input?: Uint8Array) => {
			const result = await instance.exec('/bin/sh', ['-ec', command], { input, signal, env: { ANDROID_DISK_FORMAT: 'erofs' } });
			if (result.exitCode !== 0) throw new Error(`Android setup failed: ${result.stderr || result.stdout}`);
			return result.stdout;
		};
		status.textContent = 'Preparing Android hardware and display…';
		await exec(runtime);
		if (!instance.vsock) throw new Error('The Android kernel has no vsock display transport');
		const listener = instance.vsock.listen(1023);
		const maximized = new WeakSet<object>();
		desktop = await createWland({
			container: screen, link: createStreamLink(listener),
			wasm: new URL('./wland.wasm', document.baseURI), scale: 1, webgl: 'never', shortcuts: false,
			onWindowsChange() {
				for (const window of desktop?.windows() ?? []) {
					if (!maximized.has(window)) {
						maximized.add(window);
						window.setMaximized(true);
					}
				}
			},
		});
		await exec('mkdir -p /android/run/wayland; chmod 777 /android/run/wayland; cat > /android/system/bin/unkernel-wlandr; chmod 755 /android/system/bin/unkernel-wlandr', new Uint8Array(relay));
		const bridge = await instance.spawn('/android/system/bin/unkernel-wlandr', ['--link', 'vsock:2:1023', '--buffers', 'copy', '--display', 'wayland-0', '--xwayland', 'off', '--profile', 'session'], { pty: false, env: { XDG_RUNTIME_DIR: '/android/run/wayland' } });
		const drain = async (stream: ReadableStream<Uint8Array>) => { for await (const bytes of stream) appendLog(new TextDecoder().decode(bytes)); };
		void Promise.all([drain(bridge.stdout), drain(bridge.stderr)]).catch(cause => { if (!signal.aborted) report(cause); });
		await exec('for i in $(seq 100); do if [ -S /android/run/wayland/wayland-0 ]; then chmod 777 /android/run/wayland/wayland-0; exit 0; fi; sleep 0.1; done; exit 1');
		const init = await instance.spawn('/bin/unshare', ['-m', '-p', '-f', '--mount-proc=/android/proc', '/bin/sh', '-ec', initScript], { pty: false, env: { XDG_RUNTIME_DIR: '/run/wayland', WAYLAND_DISPLAY: 'wayland-0' } });
		void Promise.all([drain(init.stdout), drain(init.stderr)]).catch(cause => { if (!signal.aborted) report(cause); });
		const androidLogs = await instance.spawn('/bin/sh', ['-c', `
for i in $(seq 300); do
    children=$(cat /proc/${init.pid}/task/${init.pid}/children 2>/dev/null || true)
    for child in $children; do
        if [ -S "/proc/$child/root/dev/socket/logdr" ]; then
            exec nsenter -t "$child" -m -p /system/bin/logcat -v brief
        fi
    done
    sleep 1
done`], { pty: false });
		void Promise.all([drain(androidLogs.stdout), drain(androidLogs.stderr)]).catch(cause => { if (!signal.aborted) appendLog(String(cause)); });
		status.textContent = 'Starting Android 13…';
		await exec(`for i in $(seq 450); do
    children=$(cat /proc/${init.pid}/task/${init.pid}/children 2>/dev/null || true)
    [ -n "$children" ] || { echo 'Android init exited' >&2; exit 1; }
    for child in $children; do
        if [ "$(nsenter -t "$child" -m -p /system/bin/getprop sys.boot_completed 2>/dev/null)" = 1 ]; then
            nsenter -t "$child" -m -p /system/bin/am start -a android.intent.action.MAIN -c android.intent.category.HOME
            for attempt in $(seq 120); do
                if nsenter -t "$child" -m -p /system/bin/dumpsys activity activities | grep -q 'topResumedActivity.*com.android.launcher3/'; then
                    exit 0
                fi
                sleep 2
            done
            echo 'Android booted but its launcher did not become active. Download the startup report.' >&2
            exit 1
        fi
        break
    done
    sleep 2
done
echo 'Android is not reporting boot complete. Download the startup report' >&2
exit 1`);
		signal.throwIfAborted();
		status.textContent = 'Android booted. Drawing its interface…';
		while (visiblePixels() < 5000) {
			signal.throwIfAborted();
			await new Promise(resolve => setTimeout(resolve, 1000));
		}
		signal.throwIfAborted();
		placeholder.hidden = true;
		status.textContent = 'Android interface ready';
		light.classList.add('running');
	} catch (cause) {
		if (!signal.aborted) report(cause);
		await shutdown();
		status.textContent = signal.aborted && error.hidden ? 'Stopped' : 'Unable to start';
	} finally {
		clearInterval(ticker);
		clearTimeout(deadline);
		updateProgress();
		busy = false;
		controls();
	}
}
start.addEventListener('click', () => { void boot(); });
stop.addEventListener('click', () => { void shutdown().then(() => { status.textContent = 'Stopped'; }).catch(report); });
controls();
