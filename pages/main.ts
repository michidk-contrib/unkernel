// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
import { createWland, createStreamLink } from 'wland/client';
import { nativeAndroidCursor } from './cursor.ts';
import type { KernelHandle } from '../js/web.ts';
import { parseBootAssets, verifySeed } from './boot-assets.ts';
import { clearAllAndroidCheckpoints, clearAndroidCheckpoint, loadAndroidCheckpoint, saveAndroidCheckpoint } from '../guest/android/checkpoint.ts';
import { DEFAULT_RELAYS, parseNetworkSettings, readNetworkSettings, networkSearch } from './network.ts';
import type { NetworkSettings } from './network.ts';
import { pruneAndroidAssets } from './asset-cache.ts';

function element<T extends HTMLElement>(id: string, ctor: { new(...args: never[]): T }): T {
	const value = document.getElementById(id);
	if (!(value instanceof ctor)) throw new Error(`Missing element: ${id}`);
	return value;
}
const start = element('start', HTMLButtonElement);
const stop = element('stop', HTMLButtonElement);
const status = element('status', HTMLSpanElement);
const error = element('error', HTMLParagraphElement);
const light = element('light', HTMLSpanElement);
const screen = element('display', HTMLDivElement);
const placeholder = element('placeholder', HTMLParagraphElement);
const idlePlaceholder = placeholder.innerHTML;
const progress = element('progress', HTMLSpanElement);
const progressBar = element('boot-progress', HTMLProgressElement);
const phases = element('boot-phases', HTMLOListElement);
const downloadDetail = element('download-detail', HTMLSpanElement);
const reportButton = element('report', HTMLButtonElement);
const cacheMessage = element('cache-message', HTMLParagraphElement);
const clearStartup = element('clear-startup', HTMLButtonElement);
clearStartup.addEventListener('click', () => {
	clearStartup.disabled = true;
	void clearAllAndroidCheckpoints().then(() => {
		cacheMessage.textContent = 'Saved startup cleared. The next launch initializes Android again; downloaded system files are kept.';
	}).catch(cause => {
		cacheMessage.textContent = `Could not clear saved startup: ${String(cause)}`;
	}).finally(() => controls());
});
const networkForm = element('network-form', HTMLFormElement);
const networkMode = element('network-mode', HTMLSelectElement);
const relays = element('relays', HTMLTextAreaElement);
const relayFields = element('relay-fields', HTMLDivElement);
const networkMessage = element('network-message', HTMLParagraphElement);
const networkBadge = element('network-badge', HTMLSpanElement);
const share = element('share', HTMLButtonElement);
const secure = location.protocol === 'https:';
const storageKey = 'unkernel-android-network-v1';
let networkSettings: NetworkSettings = { mode: 'wisp', servers: [...DEFAULT_RELAYS] };
try {
	let saved: string | null = null;
	try { saved = localStorage.getItem(storageKey); } catch { /* Session settings still work without storage. */ }
	networkSettings = readNetworkSettings(location.search, saved, secure);
} catch (cause) {
	networkMessage.textContent = cause instanceof Error ? cause.message : String(cause);
	networkMessage.classList.add('invalid');
}
networkMode.value = networkSettings.mode;
relays.value = (networkSettings.mode === 'wisp' ? networkSettings.servers : DEFAULT_RELAYS).join('\n');
function showNetworkSettings(): void {
	relayFields.hidden = networkMode.value === 'offline';
	networkBadge.textContent = networkMode.value === 'offline' ? 'Offline' : 'WISP';
}
showNetworkSettings();
networkMode.addEventListener('change', showNetworkSettings);
function saveNetworkSettings(): URL {
	networkSettings = parseNetworkSettings(networkMode.value, relays.value, secure);
	const search = networkSearch(networkSettings);
	let stored = true;
	try { localStorage.setItem(storageKey, search.toString()); } catch { stored = false; }
	const url = new URL(location.href);
	url.searchParams.delete('wisp'); url.searchParams.delete('net');
	for (const [name, value] of search) url.searchParams.append(name, value);
	history.replaceState(null, '', url);
	networkMessage.classList.remove('invalid');
	networkMessage.textContent = networkSettings.mode === 'offline' ? 'Offline. Android has no network device.' : 'WISP configured. Use “Check internet” inside Android to test connectivity.';
	if (!stored) networkMessage.textContent += ' Browser storage is unavailable; use the session link to keep these settings.';
	return url;
}
function networkError(cause: unknown): void {
	networkMessage.classList.add('invalid');
	networkMessage.textContent = cause instanceof Error ? cause.message : String(cause);
}
networkForm.addEventListener('submit', event => {
	event.preventDefault();
	try { saveNetworkSettings(); } catch (cause) { networkError(cause); }
});
share.addEventListener('click', () => {
	void (async () => {
		try {
			const url = saveNetworkSettings();
			if (!navigator.clipboard) throw new Error('Copy the session link from your browser address bar. Automatic copying is unavailable.');
			await navigator.clipboard.writeText(url.href);
			networkMessage.textContent = 'Session link copied. It shares the image and network settings, not your running session.';
		} catch (cause) { networkError(cause); }
	})();
});
const stage = element('stage', HTMLDivElement);
const fullscreen = element('fullscreen', HTMLButtonElement);
fullscreen.disabled = !document.fullscreenEnabled;
fullscreen.addEventListener('click', () => { void stage.requestFullscreen().catch(report); });
function fitFullscreen(): void {
	if (document.fullscreenElement === stage) stage.style.setProperty('--fullscreen-scale', String(Math.min(stage.clientWidth / 360, stage.clientHeight / 640)));
}
document.addEventListener('fullscreenchange', fitFullscreen);
window.addEventListener('resize', fitFullscreen);
let startupLog = '';
let startedAt = 0;
let lastStats: ReturnType<KernelHandle['stats']> | undefined;
let bootTimings: { stage: string; elapsedMs: number }[] = [];
// Also register on preview hosts that already supply COOP/COEP headers.
if (isSecureContext && 'serviceWorker' in navigator) {
	void navigator.serviceWorker.register(new URL('./coi-serviceworker.js', document.baseURI))
		.catch(cause => appendLog(`Download cache worker unavailable: ${String(cause)}\n`));
}
function appendLog(text: string): void { startupLog = (startupLog + text).slice(-96000); }
function visiblePixels(): number {
	let maximum = 0;
	for (const canvas of screen.querySelectorAll('canvas')) {
		if (canvas.width < 100 || canvas.height < 100 || getComputedStyle(canvas).display === 'none') continue;
		const pixels = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
		if (!pixels) continue;
		let count = 0;
		for (let i = 0; i < pixels.length; i += 4) {
			if (pixels[i]! > 16 || pixels[i + 1]! > 16 || pixels[i + 2]! > 16) count++;
		}
		if (count >= 5000) return count;
		maximum = Math.max(maximum, count);
	}
	return maximum;
}
reportButton.addEventListener('click', () => {
	const url = URL.createObjectURL(new Blob([JSON.stringify({
		status: status.textContent, error: error.textContent, elapsedSeconds: Math.round((performance.now() - startedAt) / 1000),
		browser: navigator.userAgent, isolated: crossOriginIsolated, visibility: document.visibilityState, stats: lastStats, timings: bootTimings, log: startupLog,
	}, null, 2)], { type: 'application/json' }));
	const link = document.createElement('a');
	link.href = url; link.download = 'android-startup.json'; link.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
});
let vm: KernelHandle | undefined;
let desktop: Awaited<ReturnType<typeof createWland>> | undefined;
let controller: AbortController | undefined;
let busy = false;
function report(cause: unknown): void {
	error.textContent = cause instanceof Error ? cause.message : String(cause);
	error.hidden = false;
}
function controls(): void {
	start.disabled = busy || !!vm;
	stop.disabled = !controller;
	clearStartup.disabled = busy || !!vm;
	for (const input of networkForm.querySelectorAll('input, select, textarea, button')) {
		if (input instanceof HTMLInputElement || input instanceof HTMLSelectElement || input instanceof HTMLTextAreaElement || input instanceof HTMLButtonElement) input.disabled = busy || !!vm;
	}
}
async function shutdown(): Promise<void> {
	screen.inert = true;
	controller?.abort();
	controller = undefined;
	desktop?.dispose();
	desktop = undefined;
	const old = vm;
	vm = undefined;
	await old?.stop();
	light.classList.remove('running');
	placeholder.hidden = false;
	placeholder.innerHTML = idlePlaceholder;
	progressBar.hidden = true;
	controls();
}
async function checkedFetch(path: string, signal: AbortSignal): Promise<Response> {
	const response = await fetch(new URL(path, document.baseURI), { signal });
	if (!response.ok) throw new Error(`Download failed: ${path} (HTTP ${response.status})`);
	return response;
}
async function boot(): Promise<void> {
	try { saveNetworkSettings(); } catch (cause) { networkError(cause); return; }
	const network = networkSettings;
	busy = true;
	screen.inert = true;
	error.hidden = true;
	error.textContent = '';
	startupLog = '';
	startedAt = performance.now();
	bootTimings = [];
	lastStats = undefined;
	reportButton.hidden = false;
	placeholder.hidden = false;
	const session = new AbortController();
	controller = session;
	const signal = session.signal;
	controls();
	phases.hidden = false;
	downloadDetail.textContent = '';
	const setPhase = (phase: number, label: string) => {
		if (bootTimings.at(-1)?.stage !== label) bootTimings.push({ stage: label, elapsedMs: Math.round(performance.now() - startedAt) });
		status.textContent = label;
		progressBar.hidden = false;
		progressBar.removeAttribute('value');
		progressBar.removeAttribute('aria-valuetext');
		for (const [index, item] of Array.from(phases.children).entries()) {
			item.classList.toggle('complete', index < phase);
			if (index === phase) item.setAttribute('aria-current', 'step');
			else item.removeAttribute('aria-current');
		}
	};
	let displayShown = false;
	const updateProgress = () => {
		lastStats = vm?.stats() ?? lastStats;
		const seconds = Math.round((performance.now() - startedAt) / 1000);
		progress.textContent = `${Math.floor(seconds / 60)}m ${seconds % 60}s elapsed${lastStats ? ` · ${(lastStats.block.bytesRead / 1048576).toFixed(0)} MiB read from Android disks` : ''}${document.hidden ? ' · Keep this tab visible to continue startup' : ''}`;
		if (controller === session) {
			placeholder.textContent = `${status.textContent} Keep this tab visible during startup.`;
			// A small boot message is enough to uncover Android. Keep it uncovered
			// through black frames between activities; readiness is checked separately.
			if (!displayShown && visiblePixels() > 0) {
				displayShown = true;
				bootTimings.push({ stage: 'First Android pixels', elapsedMs: Math.round(performance.now() - startedAt) });
			}
			placeholder.hidden = displayShown;
		}
	};
	const ticker = setInterval(updateProgress, 1000);
	const deadline = setTimeout(() => {
		report(new Error('Android did not show its interface within 20 minutes. Download the startup report to inspect the stalled boot.'));
		session.abort();
	}, 20 * 60 * 1000);
	try {
		setPhase(0, 'Checking browser support…');
		const url = new URL('./runtime/web.mjs', document.baseURI).href;
		const sdk: typeof import('../js/web.ts') = await import(/* @vite-ignore */ url);
		const support = await sdk.checkSupport();
		if (!support.ok) throw new Error(`${support.problems.join('. ')}. Use a current Chrome or Chromium browser with JSPI support.`);
		if (!crossOriginIsolated) throw new Error('Browser isolation is not active. Reload once after the service worker installs, and allow service workers for this site.');
		setPhase(1, 'Loading Android startup files…');
		const [runtime, initScript, relay, home, assets] = await Promise.all([
			checkedFetch('./android/runtime.sh', signal).then(response => response.text()),
			checkedFetch('./android/start-init.sh', signal).then(response => response.text()),
			checkedFetch('./android/wlandr', signal).then(response => response.arrayBuffer()),
			checkedFetch('./android/home.apk', signal).then(response => response.arrayBuffer()),
			checkedFetch('./android/boot.json', signal).then(response => response.json()).then(parseBootAssets),
		]);
		const cpus = Math.min(assets.maxCpus, Math.max(1, navigator.hardwareConcurrency || 1));
		void pruneAndroidAssets(assets.identity).catch(cause => appendLog(`Download cache unavailable: ${String(cause)}\n`));
		const versionedAsset = (path: string) => {
			const url = new URL(path, document.baseURI);
			url.searchParams.set('v', assets.identity);
			return url.href;
		};
		const checkpointIdentity = `${assets.identity}:2048:${cpus}:${networkSearch(network)}:android-checkpoint-v4`;
		const forgetCheckpoint = async () => {
			try { await clearAndroidCheckpoint(checkpointIdentity); }
			catch (cause) { appendLog(`Could not clear local checkpoint: ${String(cause)}\n`); }
		};
		let restore: Awaited<ReturnType<typeof loadAndroidCheckpoint>>;
		if (assets.checkpoint === true) {
			setPhase(1, 'Checking for a saved Android startup…');
			try { restore = await loadAndroidCheckpoint(checkpointIdentity); }
			catch (cause) {
				appendLog(`Local checkpoint unavailable: ${String(cause)}\n`);
				await forgetCheckpoint();
			}
			cacheMessage.textContent = restore ? 'Using the startup saved on this device.' : 'First startup for this configuration. Android will save its initial ready state for later launches.';
		}
		for (;;) {
			const restoring = restore !== undefined;
			const attempt = new AbortController();
			const restoreDeadline = restoring ? setTimeout(() => attempt.abort(new Error('Saved Android display did not return within 90 seconds')), 90_000) : undefined;
			const attemptSignal = AbortSignal.any([signal, attempt.signal]);
			try {
				setPhase(1, restoring ? 'Restoring saved Android startup…' : 'Booting Linux and opening Android disks…');
				const instance = await sdk.createKernel({
					kernel: versionedAsset('./runtime/unkernel.wasm'),
					memoryMiB: 2048, memoryFallbackMiB: [], cpus, worker: true, signal: attemptSignal, restore,
					cmdline: 'console=hvc0 rdinit=/init loglevel=3 androidboot.hardware=waydroid androidboot.selinux=permissive androidboot.serialno=unkernel',
					gpu: true, display: { width: 360, height: 640 },
					net: network.mode === 'wisp' ? { kind: 'net', backend: { kind: 'wisp', servers: network.servers } } : undefined,
					disks: ['system', 'vendor'].map(name => ({ kind: 'http', url: versionedAsset(`./android/${name}.erofs`), readOnly: true })),
					onProgress: event => {
						if (signal.aborted) return;
						switch (event.stage) {
							case 'download': {
								const name = event.what === 'kernel' ? 'Linux kernel' : 'initial filesystem';
								setPhase(1, `Downloading ${name}…`);
								const loaded = (event.loaded / 1048576).toFixed(1);
								downloadDetail.textContent = `${name}: ${loaded}${event.total > 0 ? ` / ${(event.total / 1048576).toFixed(1)}` : ''} MiB downloaded`;
								if (event.total > 0) {
									progressBar.max = event.total;
									progressBar.value = event.loaded;
									progressBar.setAttribute('aria-valuetext', downloadDetail.textContent);
								}
								break;
							}
							case 'worker': break;
							case 'compile': setPhase(1, 'Compiling the Linux kernel…'); break;
							case 'compiled': setPhase(1, 'Linux kernel compiled. Preparing memory…'); break;
							case 'memory': setPhase(1, 'Allocating Android memory…'); break;
							case 'instantiate': setPhase(1, 'Initializing the Linux kernel…'); break;
							case 'start': setPhase(1, 'Booting Linux and opening Android disks…'); break;
							default: { const exhaustive: never = event; return exhaustive; }
						}
					},
					log: message => appendLog(`${message}\n`),
					onOutput: bytes => appendLog(new TextDecoder().decode(bytes)),
				});
				vm = instance;
				signal.throwIfAborted();
				const exec = async (command: string, input?: Uint8Array) => {
					const result = await instance.exec('/bin/sh', ['-ec', command], { input, signal: attemptSignal, env: { ANDROID_DISK_FORMAT: 'erofs' } });
					if (result.exitCode !== 0) throw new Error(`Android setup failed: ${result.stderr || result.stdout}`);
					return result.stdout;
				};
				setPhase(2, 'Preparing Android hardware and display…');
				if (!restoring) {
					await exec(runtime);
					await exec('cat > /android/system/app/BrowserHome/BrowserHome.apk; chmod 644 /android/system/app/BrowserHome/BrowserHome.apk', new Uint8Array(home));
					if (assets.seed) {
						setPhase(2, 'Loading prepared Android data…');
						const response = await checkedFetch('./android/data.tar.gz', signal);
						if (!response.body) throw new Error('Prepared Android data download has no body');
						const data = new Uint8Array(assets.seed.bytes);
						let offset = 0;
						for await (const chunk of response.body) {
							if (offset + chunk.length > data.length) throw new Error('Prepared Android data exceeds the expected size');
							data.set(chunk, offset); offset += chunk.length;
							progressBar.max = data.length; progressBar.value = offset;
							downloadDetail.textContent = `Prepared data: ${(offset / 1048576).toFixed(1)} / ${(data.length / 1048576).toFixed(1)} MiB`;
						}
						await verifySeed(data, assets.seed);
						setPhase(2, 'Restoring prepared Android data…');
						await exec('tar -xzf - -C /android/data', data);
					}
				}
				if (!instance.vsock) throw new Error('The Android kernel has no vsock display transport');
				const listener = instance.vsock.listen(1023);
				const maximized = new WeakSet<object>();
				desktop = await createWland({
					container: screen, link: createStreamLink(listener), onEvent: nativeAndroidCursor(screen),
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
				if (!restoring) {
					await exec('mkdir -p /android/run/wayland; chmod 777 /android/run/wayland; cat > /android/system/bin/unkernel-wlandr; chmod 755 /android/system/bin/unkernel-wlandr', new Uint8Array(relay));
					await exec('XDG_RUNTIME_DIR=/android/run/wayland setsid /android/system/bin/unkernel-wlandr --link vsock:2:1023 --buffers copy --display wayland-0 --xwayland off --profile session </dev/null >/tmp/android-wlandr.log 2>&1 &');
					await exec('for i in $(seq 100); do if [ -S /android/run/wayland/wayland-0 ]; then chmod 777 /android/run/wayland/wayland-0; exit 0; fi; sleep 0.1; done; exit 1');
					await exec('cat > /tmp/android-start-init.sh', new TextEncoder().encode(initScript));
					await exec('XDG_RUNTIME_DIR=/run/wayland WAYLAND_DISPLAY=wayland-0 setsid /bin/unshare -m -p -f --mount-proc=/android/proc /bin/sh /tmp/android-start-init.sh </dev/null >/tmp/android-init.log 2>&1 & echo $! > /tmp/android-init-parent');
				}
				const initPid = (await exec('cat /tmp/android-init-parent')).trim();
				if (!/^[1-9][0-9]*$/.test(initPid)) throw new Error('Saved Android init process is missing');
				const androidService = async (action: 'start' | 'stop') => exec(`
	children=$(cat /proc/${initPid}/task/${initPid}/children)
	for child in $children; do
	    nsenter -t "$child" -m -p /system/bin/setprop ctl.${action} lmkd
	    exit $?
	done
	exit 1`);
				if (restoring) await androidService('start');
				const drain = async (stream: ReadableStream<Uint8Array>) => { for await (const bytes of stream) appendLog(new TextDecoder().decode(bytes)); };
				const androidLogs = await instance.spawn('/bin/sh', ['-c', `
	for i in $(seq 300); do
		children=$(cat /proc/${initPid}/task/${initPid}/children 2>/dev/null || true)
		for child in $children; do
			if [ -S "/proc/$child/root/dev/socket/logdr" ] && [ "$(nsenter -t "$child" -m -p /system/bin/getprop logd.ready 2>/dev/null)" = true ]; then
				exec nsenter -t "$child" -m -p /system/bin/logcat -v brief
			fi
		done
		sleep 1
	done`], { pty: false });
				void Promise.all([drain(androidLogs.stdout), drain(androidLogs.stderr)]).catch(cause => { if (!signal.aborted) appendLog(String(cause)); });
				setPhase(3, restoring ? 'Reconnecting Android and checking its launcher…' : 'Starting Android 13 and waiting for its launcher…');
				await exec(`for i in $(seq 450); do
		children=$(cat /proc/${initPid}/task/${initPid}/children 2>/dev/null || true)
		[ -n "$children" ] || { echo 'Android init exited' >&2; exit 1; }
		for child in $children; do
			if [ "$(nsenter -t "$child" -m -p /system/bin/getprop sys.boot_completed 2>/dev/null)" = 1 ]; then
				if [ "${restoring ? 'yes' : 'no'}" = no ]; then
					for setting in window_animation_scale transition_animation_scale animator_duration_scale; do
						nsenter -t "$child" -m -p /system/bin/cmd settings put global "$setting" 0
					done
					nsenter -t "$child" -m -p /system/bin/cmd package set-home-activity --user 0 dev.unkernel.home/.HomeActivity
					nsenter -t "$child" -m -p /system/bin/am start -a android.intent.action.MAIN -c android.intent.category.HOME
				fi
				for attempt in $(seq 120); do
					if nsenter -t "$child" -m -p /system/bin/dumpsys activity activities | grep -q 'topResumedActivity.*dev.unkernel.home/'; then
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
				setPhase(4, 'Android launcher active. Waiting for its display…');
				while (visiblePixels() < 5000) {
					attemptSignal.throwIfAborted();
					await new Promise(resolve => setTimeout(resolve, 1000));
				}
				setPhase(4, 'Android launcher drawn. Waiting for it to accept input…');
				await exec(`for i in $(seq 120); do
	for child in $(cat /proc/${initPid}/task/${initPid}/children); do
		if nsenter -t "$child" -m -p /system/bin/dumpsys input | sed -n '/^  FocusedWindows:/,/^  FocusRequests:/p' | grep -q 'dev.unkernel.home/' &&
		   nsenter -t "$child" -m -p /system/bin/dumpsys -t 5 activity dev.unkernel.home/.HomeActivity | grep -q 'View Hierarchy:'; then
			exit 0
		fi
		break
	done
	sleep 2
done
echo 'The launcher is drawn but is not responding to Android input yet' >&2
exit 1`);
				signal.throwIfAborted();
				placeholder.hidden = true;
				clearTimeout(restoreDeadline);
				clearTimeout(deadline);
				setPhase(5, 'Android interface ready');
				progressBar.max = 1;
				progressBar.value = 1;
				progressBar.setAttribute('aria-valuetext', 'Android interface ready');
				light.classList.add('running');
				if (assets.checkpoint === true && !restoring) {
					setPhase(5, 'Android ready. Saving startup for this browser…');
					try {
						const snapshot = await (async () => {
						try {
							await androidService('stop');
							await exec("for i in $(seq 30); do if ! ps -ef | grep -q '[p]simon'; then exit 0; fi; sleep 1; done; ps -ef >&2; exit 1");
							return await instance.snapshot({ dropCaches: true });
						} finally {
							if (!signal.aborted) await androidService('start');
						}
						})();
						signal.throwIfAborted();
						screen.inert = false;
						const bytes = await saveAndroidCheckpoint(checkpointIdentity, snapshot);
						appendLog(`Saved local Android checkpoint: ${bytes} bytes\n`);
						cacheMessage.textContent = `Startup saved on this device (${(bytes / 1048576).toFixed(0)} MiB). Later launches can skip Android initialization. Stopping still discards session changes.`;
					} catch (cause) {
						appendLog(`Local checkpoint was not saved: ${String(cause)}\n`);
						cacheMessage.textContent = 'Startup could not be saved. Later launches will initialize Android again. Download caching may still help.';
					}
					if (!signal.aborted) {
						setPhase(5, 'Android interface ready');
						progressBar.max = 1; progressBar.value = 1;
					}
				}
				signal.throwIfAborted();
				screen.inert = false;
				break;
			} catch (cause) {
				if (!restoring || signal.aborted) throw cause;
				appendLog(`Saved startup failed; starting Android normally: ${String(cause)}\n`);
				cacheMessage.textContent = 'Saved startup could not resume. Starting Android normally and replacing it when ready.';
				desktop?.dispose(); desktop = undefined;
				const failed = vm; vm = undefined;
				await failed?.stop();
				await forgetCheckpoint();
				signal.throwIfAborted();
				restore = undefined;
				setPhase(1, 'Saved startup unavailable. Starting Android normally…');
			} finally {
				clearTimeout(restoreDeadline);
			}
		}
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
