// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { fillFixture } from './fixture.ts';
import type { KernelInstance, Pty } from '../js/web.ts';

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
const term = new Terminal({ cursorBlink: true, fontSize: 14, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', theme: { background: '#17212c', foreground: '#e4ecf3', cursor: '#9cbfdf' } });
const fit = new FitAddon();
term.loadAddon(fit);
term.open(element('terminal', HTMLDivElement));
fit.fit();
term.writeln('Android on unkernel\r\n');
term.writeln('Start the VM to open a real Android Bionic shell.');
let vm: KernelInstance | undefined;
let pty: Pty | undefined;
let busy = false;
function report(cause: unknown): void {
	error.textContent = cause instanceof Error ? cause.message : String(cause);
	error.hidden = false;
}
function controls(): void {
	start.disabled = busy || !!vm;
	memory.disabled = busy || !!vm;
	stop.disabled = busy || !vm;
	for (const button of document.querySelectorAll<HTMLButtonElement>('[data-command]')) button.disabled = !pty;
}
async function shutdown(): Promise<void> {
	const old = vm;
	vm = undefined;
	pty = undefined;
	await old?.stop();
	light.classList.remove('running');
	controls();
}
async function checkedFetch(path: string): Promise<Response> {
	const response = await fetch(new URL(path, document.baseURI));
	if (!response.ok) throw new Error(`Download failed: ${path} (HTTP ${response.status})`);
	return response;
}
async function boot(): Promise<void> {
	busy = true;
	error.hidden = true;
	controls();
	try {
		status.textContent = 'Checking browser support…';
		const url = new URL('./runtime/web.mjs', document.baseURI).href;
		const sdk: typeof import('../js/web.ts') = await import(/* @vite-ignore */ url);
		const support = await sdk.checkSupport();
		if (!support.ok) throw new Error(`${support.problems.join('. ')}. Use a current Chrome or Chromium browser with JSPI support.`);
		if (!crossOriginIsolated) throw new Error('Browser isolation is not active. Reload once after the service worker installs, and allow service workers for this site.');
		status.textContent = 'Downloading Android userspace…';
		const [download, checksum] = await Promise.all([checkedFetch('./android.json.gz'), checkedFetch('./android.sha256')]);
		const compressed = await download.arrayBuffer();
		const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', compressed)), b => b.toString(16).padStart(2, '0')).join('');
		if (hash !== (await checksum.text()).trim()) throw new Error('Android fixture checksum mismatch. Reload to download matching assets.');
		const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
		const fs = new sdk.MemoryFs();
		fillFixture(fs, await new Response(stream).json());
		status.textContent = 'Booting kernel…';
		term.clear();
		vm = await sdk.createKernel({ memoryMiB: Number(memory.value), cpus: 1, mounts: { '/android': { fs, readOnly: true } }, log: () => {} });
		const setup = await vm.exec('/bin/sh', ['-ec', 'mount -t proc proc /android/proc; mount --bind /dev /android/dev; mount --bind /sys /android/sys'], { signal: AbortSignal.timeout(30000) });
		if (setup.exitCode !== 0) throw new Error(`Android mount setup failed: ${setup.stderr}`);
		const session = await vm.spawn('/bin/chroot', ['/android', '/system/bin/sh', '-i'], { cols: term.cols, rows: term.rows, env: { PATH: '/system/bin', HOME: '/', TERM: 'xterm-256color', PS1: 'android # ' } });
		pty = session;
		status.textContent = 'Android shell running';
		light.classList.add('running');
		void drain(session);
		term.focus();
	} catch (cause) {
		report(cause);
		await shutdown();
		status.textContent = 'Unable to start';
	} finally {
		busy = false;
		controls();
	}
}
async function drain(session: Pty): Promise<void> {
	try {
		for await (const chunk of session.output) await new Promise<void>(resolve => term.write(chunk, resolve));
		await session.ended;
	} catch (cause) {
		if (pty === session) report(cause);
	} finally {
		if (pty === session) {
			await shutdown();
			status.textContent = 'Shell exited';
		}
	}
}
term.onData(data => { void pty?.write(data).catch(report); });
new ResizeObserver(() => {
	fit.fit();
	pty?.resize(term.cols, term.rows);
}).observe(element('terminal', HTMLDivElement));
start.addEventListener('click', () => { void boot(); });
stop.addEventListener('click', () => {
	busy = true;
	controls();
	void shutdown().then(() => { status.textContent = 'Stopped'; }).catch(report).finally(() => { busy = false; controls(); });
});
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-command]')) {
	button.addEventListener('click', () => {
		void pty?.write(`${button.dataset.command}\n`).catch(report);
		term.focus();
	});
}
controls();
