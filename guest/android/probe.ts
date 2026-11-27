// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createKernel, nodeFs } from "../../js/node.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

export interface AndroidProbe {
	architecture: string;
	bionic: { stdout: string; stderr: string; exitCode: number | null };
	binderDevices: string[];
	binderfs: boolean;
	blockers: string[];
}

/** Execute real Android-linked binaries; all mounts and devices are inside the VM. */
export async function probeAndroid({
	kernel = resolve(root, "vendor/android/unkernel.wasm"),
	rootfs = resolve(root, "vendor/android/rootfs"),
} = {}): Promise<AndroidProbe> {
	await access(kernel);
	await access(resolve(rootfs, "system/bin/linker64"));
	const vm = await createKernel({
		kernel,
		memoryMiB: 512,
		cpus: 1,
		mounts: { "/android": { fs: nodeFs(rootfs), readOnly: true } },
		log: () => {},
	});
	const watchdog = setTimeout(() => void vm.stop(), 60_000);
	const signal = AbortSignal.timeout(55_000);
	try {
		const setup = await vm.exec("/bin/sh", ["-ec", `
mount -t proc proc /android/proc
mount --bind /dev /android/dev
mount --bind /sys /android/sys
`], { signal });
		if (setup.exitCode !== 0) throw new Error(`Android chroot setup failed: ${setup.stderr}`);
		const arch = await vm.exec("/bin/uname", ["-m"], { signal });
		const bionic = await vm.exec("/bin/chroot", ["/android", "/system/bin/sh", "-ec", `
echo ANDROID_BIONIC_OK
/system/bin/toybox --version
/system/bin/toybox uname -m
/system/bin/toybox id
(/system/bin/toybox echo ANDROID_FORK_OK)
`], { signal });
		const devices = await vm.exec("/bin/sh", ["-c", `
for device in binder hwbinder vndbinder; do
  [ ! -c /dev/$device ] || echo "$device"
done
`], { signal });
		const filesystems = await vm.exec("/bin/cat", ["/proc/filesystems"], { signal });
		const binderDevices = devices.stdout.trim().split("\n").filter(Boolean);
		const binderfs = filesystems.stdout.split("\n").some((line) => line.trim().split(/\s+/).at(-1) === "binder");
		const blockers: string[] = [];
		if (bionic.exitCode !== 0) blockers.push("Android Bionic execution failed");
		if (binderDevices.length !== 3 && !binderfs) {
			blockers.push("Android Binder IPC is unavailable: enable CONFIG_ANDROID_BINDER_IPC and binder devices or binderfs");
		}
		return {
			architecture: arch.stdout.trim(),
			bionic: { stdout: bionic.stdout, stderr: bionic.stderr, exitCode: bionic.exitCode },
			binderDevices,
			binderfs,
			blockers,
		};
	} finally {
		clearTimeout(watchdog);
		await vm.stop();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		const args = process.argv.slice(2);
		if (args.some((arg) => arg !== "--require-framework")) throw new Error("Usage: bun run android:probe [--require-framework]");
		const report = await probeAndroid({ kernel: process.env.ANDROID_KERNEL });
		console.log(JSON.stringify(report, null, 2));
		if (report.bionic.exitCode !== 0) process.exitCode = 1;
		else if (args.includes("--require-framework") && report.blockers.length) process.exitCode = 2;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		console.error("Prepare the fixture first: bun run android:prepare");
		process.exitCode = 1;
	}
}
