import System from "../System";
import MapWorkerSystem from "./MapWorkerSystem";
import Tile3DBuffers from "~/lib/tile-processing/tile3d/buffers/Tile3DBuffers";
import Config from "~/app/Config";
import MapWorker from "~/app/world/worker/MapWorker";
import TileSystem from "~/app/systems/TileSystem";
import Vec2 from "~/lib/math/Vec2";
import OverpassEndpointPool from "~/app/overpass/OverpassEndpointPool";
import {WorkerMessage} from "~/app/world/worker/WorkerMessage";

// Endpoint settings are stored under a versioned key so that changed defaults are not hidden by old saved values
const EndpointsStorageKey = 'overpassEndpoints.v2';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export interface OverpassEndpoint {
	url: string;
	isEnabled: boolean;
	isUserDefined: boolean;
}

export default class TileLoadingSystem extends System {
	private readonly overpassEndpointsDefault: OverpassEndpoint[] = [];
	public overpassEndpoints: OverpassEndpoint[] = [];
	private readonly endpointPool = new OverpassEndpointPool();
	private activeLoads = 0;

	public constructor() {
		super();

		for (const {url, isEnabled} of Config.OverpassEndpoints) {
			const endpoint: OverpassEndpoint = {
				url: url,
				isEnabled: isEnabled,
				isUserDefined: false
			};

			this.overpassEndpointsDefault.push(endpoint);
		}

		try {
			const lsEndpoints = JSON.parse(localStorage.getItem(EndpointsStorageKey));

			if (Array.isArray(lsEndpoints)) {
				for (const endpoint of lsEndpoints) {
					this.overpassEndpoints.push({
						url: String(endpoint.url),
						isEnabled: Boolean(endpoint.isEnabled),
						isUserDefined: Boolean(endpoint.isUserDefined),
					});
				}
			}
		} catch (e) {
			console.error(e);
		}

		for (const endpoint of this.overpassEndpointsDefault) {
			if (!this.overpassEndpoints.some(e => e.url === endpoint.url)) {
				this.overpassEndpoints.push(endpoint);
			}
		}
	}

	public postInit(): void {

	}

	public setOverpassEndpoints(endpoints: OverpassEndpoint[]): void {
		this.overpassEndpoints = endpoints;
		localStorage.setItem(EndpointsStorageKey, JSON.stringify(endpoints));
	}

	public resetOverpassEndpoints(): void {
		this.overpassEndpoints = this.overpassEndpointsDefault;

		try {
			localStorage.removeItem(EndpointsStorageKey);
		} catch (e) {
			console.error(e);
		}
	}

	private getEnabledEndpointUrls(): string[] {
		return this.overpassEndpoints
			.filter(endpoint => endpoint.isEnabled)
			.map(endpoint => endpoint.url);
	}

	/**
	 * Waits until an endpoint that is not cooling down is available. Returns null if the tile was cancelled
	 * or there are no enabled endpoints.
	 */
	private async acquireEndpoint(isCancelled: () => boolean): Promise<string | null> {
		while (!isCancelled()) {
			const urls = this.getEnabledEndpointUrls();

			if (urls.length === 0) {
				return null;
			}

			const url = this.endpointPool.acquire(urls);

			if (url !== null) {
				return url;
			}

			await sleep(this.endpointPool.getWaitTime(urls) + 50);
		}

		return null;
	}

	public update(deltaTime: number): void {
		if (this.activeLoads >= Config.OverpassMaxConcurrentRequests) {
			return;
		}

		const urls = this.getEnabledEndpointUrls();

		// Do not take tiles from the queue while every server is cooling down after a failure
		if (urls.length === 0 || this.endpointPool.getWaitTime(urls) > 0) {
			return;
		}

		const mapWorkerSystem = this.systemManager.getSystem(MapWorkerSystem);
		const tileSystem = this.systemManager.getSystem(TileSystem);
		const worker = mapWorkerSystem.getFreeWorker();

		if (!worker) {
			return;
		}

		const queuedTile = tileSystem.getNextTileToLoad();

		if (queuedTile) {
			this.loadTile({
				tile: queuedTile.position,
				onBeforeLoad: queuedTile.onBeforeLoad,
				onLoad: queuedTile.onLoad,
				isCancelled: queuedTile.isCancelled,
				worker: worker,
				isTerrainHeightEnabled: tileSystem.enableTerrainHeight
			});
		}
	}

	private async loadTile(
		{
			tile,
			onBeforeLoad,
			onLoad,
			isCancelled,
			worker,
			isTerrainHeightEnabled
		}: {
			tile: Vec2;
			onBeforeLoad: () => Promise<any>;
			onLoad: (buffers: Tile3DBuffers) => void;
			isCancelled: () => boolean;
			worker: MapWorker;
			isTerrainHeightEnabled: boolean;
		}
	): Promise<void> {
		this.activeLoads++;

		try {
			await onBeforeLoad();

			const buffers = await this.requestTileWithRetries(tile, worker, isTerrainHeightEnabled, isCancelled);

			onLoad(buffers);
		} catch (e) {
			console.error(e);
			onLoad(null);
		} finally {
			this.activeLoads--;
		}
	}

	/**
	 * Requests a tile from a worker. If an Overpass server fails, it is put on a cooldown (exponential backoff)
	 * and the tile is requested again from another server, up to Config.OverpassMaxAttempts times.
	 */
	private async requestTileWithRetries(
		tile: Vec2,
		worker: MapWorker,
		isTerrainHeightEnabled: boolean,
		isCancelled: () => boolean
	): Promise<Tile3DBuffers | null> {
		const maxAttempts = Config.OverpassMaxAttempts;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const endpoint = await this.acquireEndpoint(isCancelled);

			if (endpoint === null) {
				return null;
			}

			try {
				const buffers = await worker.requestTile(tile.x, tile.y, {
					overpassEndpoint: endpoint,
					// Outdated cached data is only used when nothing else worked
					allowStaleCache: attempt === maxAttempts,
					isTerrainHeightEnabled: isTerrainHeightEnabled
				});

				this.endpointPool.reportSuccess(endpoint);

				return buffers;
			} catch (e) {
				const error = e as WorkerMessage.TileError;

				if (error?.isOverpassError !== true) {
					// Not a server problem (e.g. a geometry processing bug): retrying will not help
					console.error(`Failed to process tile ${tile.x},${tile.y}:`, error?.message ?? error);
					return null;
				}

				const isRetryable = OverpassEndpointPool.isRetryable(error);

				if (isRetryable) {
					const cooldown = this.endpointPool.reportFailure(endpoint, error);

					console.warn(
						`Tile ${tile.x},${tile.y}: ${error.message} (attempt ${attempt}/${maxAttempts}), ` +
						`pausing this endpoint for ${Math.round(cooldown / 1000)}s`
					);
				} else {
					console.error(`Tile ${tile.x},${tile.y}: ${error.message}, not retrying`);
					return null;
				}

				if (isCancelled()) {
					return null;
				}
			}
		}

		console.error(`Tile ${tile.x},${tile.y}: giving up after ${maxAttempts} attempts`);

		return null;
	}
}
