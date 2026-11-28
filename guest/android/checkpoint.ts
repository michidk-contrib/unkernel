// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
import { decodeSnapshot, encodeSnapshot } from '../../js/core/snapshot.ts';
import type { KernelSnapshot } from '../../js/core/snapshot.ts';

const databaseName = 'unkernel-android-checkpoint';
const storeName = 'checkpoints';

/** Include the kernel hash, image hashes, runtime revision, CPU count and memory preset. */
export type AndroidCheckpointIdentity = string;

async function openDatabase(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(databaseName, 1);
		request.onupgradeneeded = () => request.result.createObjectStore(storeName);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
		request.onblocked = () => reject(new Error('Android checkpoint storage is blocked by another tab'));
	});
}

async function storedCheckpoint(identity: AndroidCheckpointIdentity): Promise<unknown> {
	const database = await openDatabase();
	try {
		return await new Promise((resolve, reject) => {
			const transaction = database.transaction(storeName, 'readonly');
			const request = transaction.objectStore(storeName).get(identity);
			transaction.oncomplete = () => resolve(request.result);
			transaction.onabort = () => reject(transaction.error);
		});
	} finally {
		database.close();
	}
}

/** Gzip after the SDK has removed zero memory pages. Suitable for IDB or a static artifact. */
export async function encodeAndroidCheckpoint(snapshot: KernelSnapshot): Promise<Blob> {
	const encoded = encodeSnapshot(snapshot);
	if (!(encoded.buffer instanceof ArrayBuffer)) throw new Error('Snapshot encoding must use an ArrayBuffer');
	const input = new Blob([encoded.buffer]);
	return new Response(input.stream().pipeThrough(new CompressionStream('gzip'))).blob();
}

export async function decodeAndroidCheckpoint(blob: Blob): Promise<KernelSnapshot> {
	const bytes = await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
	return decodeSnapshot(new Uint8Array(bytes));
}

/** A failed save keeps the previous checkpoint; only one build/preset is retained. */
export async function saveAndroidCheckpoint(identity: AndroidCheckpointIdentity, snapshot: KernelSnapshot): Promise<number> {
	const blob = await encodeAndroidCheckpoint(snapshot);
	const database = await openDatabase();
	try {
		await new Promise<void>((resolve, reject) => {
			const transaction = database.transaction(storeName, 'readwrite');
			const store = transaction.objectStore(storeName);
			store.clear();
			store.put(blob, identity);
			transaction.oncomplete = () => resolve();
			transaction.onabort = () => reject(transaction.error);
		});
		return blob.size;
	} finally {
		database.close();
	}
}

export async function loadAndroidCheckpoint(identity: AndroidCheckpointIdentity): Promise<KernelSnapshot | undefined> {
	const blob = await storedCheckpoint(identity);
	if (blob === undefined) return undefined;
	if (!(blob instanceof Blob)) throw new Error('Android checkpoint has an invalid storage format');
	return decodeAndroidCheckpoint(blob);
}

export async function clearAndroidCheckpoint(identity: AndroidCheckpointIdentity): Promise<void> {
	const database = await openDatabase();
	try {
		await new Promise<void>((resolve, reject) => {
			const transaction = database.transaction(storeName, 'readwrite');
			transaction.objectStore(storeName).delete(identity);
			transaction.oncomplete = () => resolve();
			transaction.onabort = () => reject(transaction.error);
		});
	} finally {
		database.close();
	}
}

export async function clearAllAndroidCheckpoints(): Promise<void> {
	const database = await openDatabase();
	try {
		await new Promise<void>((resolve, reject) => {
			const transaction = database.transaction(storeName, 'readwrite');
			transaction.objectStore(storeName).clear();
			transaction.oncomplete = () => resolve();
			transaction.onabort = () => reject(transaction.error);
		});
	} finally { database.close(); }
}
