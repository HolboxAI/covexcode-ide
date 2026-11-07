/**
 * In-memory LRU cache for image attachments sent during chat turns.
 *
 * Stored at send time so replay across session resets (model switches,
 * restarts, crashes) does not depend on calling .data() on old turns.
 * If the window reloads or the cache is cleared, cold-restore degrades
 * gracefully to textual tags without crashing.
 */

export interface CachedImage {
	readonly data: string; // base64-encoded image
	readonly mimeType: string;
	readonly name?: string;
	readonly turnId: string;
	readonly index: number;
}

export class ImageCache {
	private readonly capacity: number;
	// Ordered Map acts as an LRU: least-recently accessed key is first in keys()
	private readonly store = new Map<string, CachedImage>();

	constructor(capacity = 5) {
		this.capacity = Math.max(1, capacity);
	}

	private key(turnId: string, index: number): string {
		return `${turnId}:${index}`;
	}

	set(turnId: string, index: number, image: { data: string; mimeType: string; name?: string }): void {
		const k = this.key(turnId, index);
		if (this.store.has(k)) {
			this.store.delete(k);
		} else if (this.store.size >= this.capacity) {
			const oldestKey = this.store.keys().next().value;
			if (oldestKey !== undefined) {
				this.store.delete(oldestKey);
			}
		}
		this.store.set(k, {
			data: image.data,
			mimeType: image.mimeType,
			name: image.name,
			turnId,
			index,
		});
	}

	get(turnId: string, index: number): CachedImage | undefined {
		const k = this.key(turnId, index);
		const item = this.store.get(k);
		if (item) {
			// Mark as most-recently used
			this.store.delete(k);
			this.store.set(k, item);
		}
		return item;
	}

	getByTurn(turnId: string): CachedImage[] {
		const results: CachedImage[] = [];
		const matchedKeys: string[] = [];
		for (const [k, v] of this.store.entries()) {
			if (v.turnId === turnId) {
				results.push(v);
				matchedKeys.push(k);
			}
		}
		for (const k of matchedKeys) {
			const item = this.store.get(k);
			if (item) {
				this.store.delete(k);
				this.store.set(k, item);
			}
		}
		return results.sort((a, b) => a.index - b.index);
	}

	has(turnId: string, index = 0): boolean {
		return this.store.has(this.key(turnId, index));
	}

	get size(): number {
		return this.store.size;
	}

	clear(): void {
		this.store.clear();
	}
}
