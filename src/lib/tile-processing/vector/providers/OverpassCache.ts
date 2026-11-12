import OverpassDataObject from "~/lib/tile-processing/vector/providers/OverpassDataObject";

const DBName = 'streets-gl-overpass';
const StoreName = 'tiles';
const DBVersion = 1;

interface CacheRecord {
	key: string;
	timestamp: number;
	data: OverpassDataObject;
}

export interface CacheEntry {
	data: OverpassDataObject;
	isFresh: boolean;
}

/**
 * Persistent cache of raw Overpass responses (IndexedDB). Works inside Web Workers.
 * Every operation fails soft: if IndexedDB is unavailable the cache is simply a no-op.
 */
export default class OverpassCache {
	private dbPromise: Promise<IDBDatabase | null> | null = null;
	private pruned = false;

	public constructor(
		private readonly maxAgeMs: number,
		private readonly maxEntries: number
	) {
	}

	/**
	 * Returns the cached response. A stale entry (older than maxAge) is still returned, flagged as not fresh,
	 * so that it can be used as a fallback when every Overpass server is unavailable.
	 */
	public async get(key: string): Promise<CacheEntry | null> {
		try {
			const db = await this.open();

			if (!db) {
				return null;
			}

			const record = await OverpassCache.request<CacheRecord | undefined>(
				db.transaction(StoreName, 'readonly').objectStore(StoreName).get(key)
			);

			if (!record) {
				return null;
			}

			return {
				data: record.data,
				isFresh: Date.now() - record.timestamp <= this.maxAgeMs
			};
		} catch (e) {
			console.warn('Overpass cache read failed', e);
			return null;
		}
	}

	public async put(key: string, data: OverpassDataObject): Promise<void> {
		try {
			const db = await this.open();

			if (!db) {
				return;
			}

			const record: CacheRecord = {key, timestamp: Date.now(), data};

			await OverpassCache.request(db.transaction(StoreName, 'readwrite').objectStore(StoreName).put(record));
			await this.pruneOnce(db);
		} catch (e) {
			// e.g. quota exceeded
			console.warn('Overpass cache write failed', e);
		}
	}

	private open(): Promise<IDBDatabase | null> {
		if (!this.dbPromise) {
			this.dbPromise = new Promise(resolve => {
				if (typeof indexedDB === 'undefined') {
					resolve(null);
					return;
				}

				const request = indexedDB.open(DBName, DBVersion);

				request.onupgradeneeded = (): void => {
					const store = request.result.createObjectStore(StoreName, {keyPath: 'key'});
					store.createIndex('timestamp', 'timestamp');
				};
				request.onsuccess = (): void => resolve(request.result);
				request.onerror = (): void => resolve(null);
				request.onblocked = (): void => resolve(null);
			});
		}

		return this.dbPromise;
	}

	/**
	 * Removes entries that are too old and, if there are still too many, the oldest ones. Runs once per worker.
	 */
	private pruneOnce(db: IDBDatabase): Promise<void> {
		if (this.pruned) {
			return Promise.resolve();
		}

		this.pruned = true;

		return new Promise<void>(resolve => {
			const tx = db.transaction(StoreName, 'readwrite');
			const store = tx.objectStore(StoreName);
			const index = store.index('timestamp');
			// Stale entries are kept for 4x the max age so they stay usable as a fallback for a while
			const cutoff = Date.now() - this.maxAgeMs * 4;

			const expired = index.openCursor(IDBKeyRange.upperBound(cutoff));
			expired.onsuccess = (): void => {
				const cursor = expired.result;

				if (cursor) {
					cursor.delete();
					cursor.continue();
				}
			};

			const count = store.count();
			count.onsuccess = (): void => {
				let excess = count.result - this.maxEntries;

				if (excess <= 0) {
					return;
				}

				const oldest = index.openCursor();
				oldest.onsuccess = (): void => {
					const cursor = oldest.result;

					if (cursor && excess-- > 0) {
						cursor.delete();
						cursor.continue();
					}
				};
			};

			tx.oncomplete = (): void => resolve();
			tx.onerror = (): void => resolve();
			tx.onabort = (): void => resolve();
		});
	}

	private static request<T>(request: IDBRequest<T>): Promise<T> {
		return new Promise((resolve, reject) => {
			request.onsuccess = (): void => resolve(request.result);
			request.onerror = (): void => reject(request.error);
		});
	}
}
