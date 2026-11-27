// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { createHeadless, encodePNG } from 'wland/headless';
import type { KernelInstance, Subprocess } from '../../js/node.ts';

/** Bridge Android's Wayland display to the same compositor used by Side by Side. */
export async function startAndroidDisplay(vm: KernelInstance, reports: string) {
	if (!vm.vsock) throw new Error('The Android display requires guest vsock');
	const listener = vm.vsock.listen(1023);
	const desktop = await createHeadless({ link: listener, width: 360, height: 640 });
	let relayLog = '';
	let relayProcess: Subprocess | undefined;
	try {
		const packageRoot = dirname(createRequire(import.meta.url).resolve('wland/package.json'));
		const relay = brotliDecompressSync(await readFile(resolve(packageRoot, 'dist/wlandr-linux-arm64.br')));
		const install = await vm.exec('/bin/sh', ['-ec', 'mkdir -p /android/run/wayland; chmod 777 /android/run/wayland; cat > /android/system/bin/unkernel-wlandr; chmod 755 /android/system/bin/unkernel-wlandr'], { input: relay });
		if (install.exitCode !== 0) throw new Error(`Wayland relay install failed: ${install.stderr}`);
		const process = await vm.spawn('/android/system/bin/unkernel-wlandr', ['--link', 'vsock:2:1023', '--buffers', 'copy', '--display', 'wayland-0', '--xwayland', 'off', '--profile', 'session'], { pty: false, env: { XDG_RUNTIME_DIR: '/android/run/wayland' } });
		relayProcess = process;
		const read = async (stream: ReadableStream<Uint8Array>) => {
			for await (const bytes of stream) relayLog = (relayLog + new TextDecoder().decode(bytes)).slice(-1_000_000);
		};
		void Promise.all([read(process.stdout), read(process.stderr)]).catch(error => { relayLog += `\n${String(error)}`; });
		const socket = await vm.exec('/bin/sh', ['-ec', 'for i in $(seq 100); do if [ -S /android/run/wayland/wayland-0 ]; then chmod 777 /android/run/wayland/wayland-0; exit 0; fi; sleep 0.1; done; exit 1']);
		if (socket.exitCode !== 0) throw new Error(`Wayland socket did not appear: ${relayLog}`);
		return {
			env: { XDG_RUNTIME_DIR: '/run/wayland', WAYLAND_DISPLAY: 'wayland-0' },
			desktop,
			async capture() {
				await writeFile(`${reports}/wayland-relay.txt`, relayLog);
				await writeFile(`${reports}/windows.json`, JSON.stringify(desktop.windows(), null, 2));
				if (desktop.windows().length) await writeFile(`${reports}/android.png`, await encodePNG(desktop.screenshot()));
			},
			async close() {
				desktop.dispose();
				listener.close();
				await process.close();
			},
		};
	} catch (error) {
		await relayProcess?.close().catch(() => {});
		desktop.dispose();
		listener.close();
		await writeFile(`${reports}/wayland-relay.txt`, relayLog);
		throw error;
	}
}
