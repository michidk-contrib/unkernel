// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Michael Lohr <michael@lohr.dev>
import type { Event } from 'wland/client';

/** Use the browser pointer until wland presents wp_viewport source crops.
 * Waydroid crops padded cursor buffers; wland currently scales the entire
 * buffer into that crop's destination, compressing the arrow into a line.
 * Run after the public view event handler, leaving input coordinates intact.
 */
export function nativeAndroidCursor(container: HTMLElement): (event: Event) => void {
	const surfaces = new Map<number, Set<number>>();
	return event => {
		if (event.type === 'close') { surfaces.clear(); return; }
		if (event.type === 'disconnect') { surfaces.delete(event.conn); return; }
		if (event.type === 'cursor' && event.surface) {
			let connection = surfaces.get(event.conn);
			if (!connection) surfaces.set(event.conn, connection = new Set());
			connection.add(event.surface);
		} else if (event.type === 'destroy') {
			surfaces.get(event.conn)?.delete(event.surface);
			return;
		} else if (event.type !== 'cursor' && event.type !== 'commit') {
			return;
		}
		// The view may create the cursor canvas before or after set_cursor.
		for (const surface of surfaces.get(event.conn) ?? []) {
			container.querySelector<HTMLCanvasElement>(`canvas[data-wland="c${event.conn}s${surface}"]`)
				?.style.setProperty('display', 'none', 'important');
		}
		for (const window of container.querySelectorAll<HTMLElement>(`[data-wland-window^="c${event.conn}s"]`)) {
			window.style.setProperty('cursor', 'default', 'important');
		}
	};
}
