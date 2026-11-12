export namespace WorkerMessage {
	export enum ToWorkerType {
		Start,
		Height
	}

	export interface ToWorker {
		type: ToWorkerType;
		tile: [number, number];
		overpassEndpoint?: string;
		allowStaleCache?: boolean;
		openFreeMapTemplate?: string | null;
		isTerrainHeightEnabled?: boolean;
		height?: Float64Array;
	}

	export interface TileError {
		message: string;
		status?: number;
		retryAfterSeconds?: number;
		isOverpassError: boolean;
	}

	export enum FromWorkerType {
		Success,
		Error,
		RequestHeight
	}

	export interface FromWorker {
		type: FromWorkerType;
		tile: [number, number];
		payload?: any;
	}
}
