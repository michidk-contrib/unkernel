// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
import assert from "node:assert/strict";
import { test } from "node:test";
import { probeAndroid } from "../guest/android/probe.ts";

test("Android Bionic linker, shell, toybox and fork execute inside the wasm Linux guest", { timeout: 75_000 }, async () => {
	const report = await probeAndroid({ kernel: process.env.ANDROID_KERNEL });
	assert.equal(report.architecture, "aarch64");
	assert.equal(report.bionic.exitCode, 0, report.bionic.stderr);
	assert.match(report.bionic.stdout, /ANDROID_BIONIC_OK/);
	assert.match(report.bionic.stdout, /toybox/);
	assert.match(report.bionic.stdout, /uid=0/);
	assert.match(report.bionic.stdout, /ANDROID_FORK_OK/);
	if (!report.binderfs && report.binderDevices.length !== 3) {
		assert.ok(report.blockers.some((blocker) => blocker.includes("Binder IPC")));
	}
});
