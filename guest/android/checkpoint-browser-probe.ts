// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
// Manual browser verification module. Bundle separately, then call roundTrip(liveVm).
import { createWland, createStreamLink } from 'wland/client';
import type { KernelHandle } from '../../js/web.ts';

export const probeState: {
	stage: string;
	sourceStopped: boolean;
	elapsedMs: number;
	pixels: number;
	windows: number;
	bootCompleted: string;
	launcherResumed: boolean;
	error?: string;
} = { stage: 'idle', sourceStopped: false, elapsedMs: 0, pixels: 0, windows: 0, bootCompleted: '', launcherResumed: false };

/** Consumes a disposable live browser VM only after a successful capture. */
export async function roundTrip(vm: KernelHandle, options: { timeoutMs?: number; onStatus?: (stage: string) => void } = {}) {
	const started = performance.now();
	const panel = document.createElement('section');
	panel.id = 'android-checkpoint-probe';
	panel.style.cssText = 'position:fixed;right:12px;top:12px;z-index:9999;background:#111;color:white;padding:12px;max-height:95vh;overflow:auto';
	const label = document.createElement('p');
	const container = document.createElement('div');
	container.style.cssText = 'position:relative;width:360px;height:640px;overflow:hidden;background:black';
	panel.append(label, container);
	document.body.append(panel);
	const status = (stage: string) => {
		probeState.stage = stage;
		probeState.elapsedMs = Math.round(performance.now() - started);
		label.textContent = `${stage} (${(probeState.elapsedMs / 1000).toFixed(1)}s)`;
		options.onStatus?.(stage);
	};
	Object.assign(probeState, { sourceStopped: false, pixels: 0, windows: 0, bootCompleted: '', launcherResumed: false });
	delete probeState.error;
	let restored: KernelHandle | undefined;
	let desktop: Awaited<ReturnType<typeof createWland>> | undefined;
	let listener: ReturnType<NonNullable<KernelHandle['vsock']>['listen']> | undefined;
	let deadline: ReturnType<typeof setTimeout> | undefined;
	const controller = new AbortController();
	const exec = async (target: KernelHandle, command: string, signal = AbortSignal.timeout(45000)) => {
		const result = await target.exec('/bin/sh', ['-ec', command], { signal });
		if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `Guest command exited ${result.exitCode}`);
		return result.stdout.trim();
	};
	try {
		status('Locating live Android namespace');
		const parent = await exec(vm, 'cat /tmp/android-init-parent');
		if (!/^\d+$/.test(parent)) throw new Error('Saved Android parent PID is invalid');
		const child = (await exec(vm, `cat /proc/${parent}/task/${parent}/children`)).split(/\s+/)[0];
		if (!child || !/^\d+$/.test(child)) throw new Error('Live Android namespace was not found');
		const android = (action: 'start' | 'stop', target = vm, signal?: AbortSignal) => exec(target, `nsenter -t ${child} -m -p /system/bin/setprop ctl.${action} lmkd`, signal);
		status('Stopping lmkd PSI monitor before capture');
		let snapshot;
		try {
			await android('stop');
			await exec(vm, "for i in $(seq 30); do if ! ps -ef | grep -q '[p]simon'; then exit 0; fi; sleep 1; done; ps -ef >&2; exit 1");
			status('Capturing live Android memory');
			snapshot = await vm.snapshot({ dropCaches: true });
		} finally {
			await android('start');
		}
		status('Stopping source VM after successful capture');
		await vm.stop();
		probeState.sourceStopped = true;
		status('Restoring worker VM');
		const sdkUrl = new URL('./runtime/web.mjs', document.baseURI).href;
		const sdk: typeof import('../../js/web.ts') = await import(/* @vite-ignore */ sdkUrl);
		deadline = setTimeout(() => controller.abort(new Error('Restored Android did not draw within the probe deadline')), options.timeoutMs ?? 90000);
		restored = await sdk.createKernel({
			worker: true, restore: snapshot, memoryMiB: 2048, memoryFallbackMiB: [], cpus: snapshot.cpus ?? 1,
			gpu: true, display: { width: 360, height: 640 }, signal: controller.signal,
			cmdline: 'console=hvc0 rdinit=/init loglevel=3 androidboot.hardware=waydroid androidboot.selinux=permissive androidboot.serialno=unkernel',
			disks: ['system', 'vendor'].map(name => ({ kind: 'http', url: new URL(`./android/${name}.erofs`, document.baseURI).href, readOnly: true })),
		});
		if (!restored.vsock) throw new Error('Restored VM has no display transport');
		listener = restored.vsock.listen(1023);
		const maximized = new WeakSet<object>();
		desktop = await createWland({
			container, link: createStreamLink(listener), wasm: new URL('./wland.wasm', document.baseURI), scale: 1, webgl: 'never', shortcuts: false,
			onWindowsChange() {
				for (const window of desktop?.windows() ?? []) if (!maximized.has(window)) {
					maximized.add(window);
					window.setMaximized(true);
				}
			},
		});
		await android('start', restored, controller.signal);
		status('Waiting for restored Home pixels');
		while (probeState.pixels < 5000) {
			controller.signal.throwIfAborted();
			probeState.windows = desktop.windows().length;
			for (const canvas of container.querySelectorAll('canvas')) {
				if (canvas.width < 100 || canvas.height < 100) continue;
				const pixels = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
				if (!pixels) continue;
				let visible = 0;
				for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! > 16 || pixels[i + 1]! > 16 || pixels[i + 2]! > 16) visible++;
				probeState.pixels = Math.max(probeState.pixels, visible);
			}
			if (probeState.pixels < 5000) await new Promise(resolve => setTimeout(resolve, 100));
		}
		probeState.bootCompleted = await exec(restored, `nsenter -t ${child} -m -p /system/bin/getprop sys.boot_completed`, controller.signal);
		const activity = await exec(restored, `nsenter -t ${child} -m -p /system/bin/dumpsys activity activities`, controller.signal);
		probeState.launcherResumed = activity.split('\n').some(line => /(?:mResumedActivity|topResumedActivity)[:=]/.test(line) && line.includes('com.android.launcher3/'));
		if (probeState.bootCompleted !== '1' || !probeState.launcherResumed) throw new Error('Restored Android did not retain boot-completed Home activity');
		clearTimeout(deadline);
		status('PASS: Android Home restored with visible pixels');
		const restoredVm = restored;
		const restoredDesktop = desktop;
		const restoredListener = listener;
		return {
			vm: restoredVm, state: probeState, container,
			async close() { restoredDesktop.dispose(); restoredListener.close(); panel.remove(); await restoredVm.stop(); },
		};
	} catch (error) {
		clearTimeout(deadline);
		probeState.error = String(error);
		status(`FAILED: ${String(error)}`);
		desktop?.dispose();
		listener?.close();
		await restored?.stop().catch(() => {});
		throw error;
	}
}
