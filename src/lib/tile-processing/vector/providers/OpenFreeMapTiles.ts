// OpenFreeMap serves OpenMapTiles-schema vector tiles from static files, without an API key.
// The tile URL contains the planet version, which changes with every update, so it has to be read from TileJSON.

export const OpenFreeMapMaxZoom = 14;

const TileJSONTimeoutMs = 10000;

let templatePromise: Promise<string | null> | null = null;

/**
 * Reads the current tile URL template from the TileJSON document. Resolves to null if it is not available.
 * A successful result is reused; a failure can be retried by calling the function again.
 */
export function fetchOpenFreeMapTemplate(tileJSONUrl: string): Promise<string | null> {
	if (!templatePromise) {
		const promise = requestTemplate(tileJSONUrl);

		templatePromise = promise;

		promise.then(template => {
			if (template === null && templatePromise === promise) {
				templatePromise = null;
			}
		});
	}

	return templatePromise;
}

async function requestTemplate(tileJSONUrl: string): Promise<string | null> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), TileJSONTimeoutMs);

	try {
		const response = await fetch(tileJSONUrl, {signal: controller.signal});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}

		const tileJSON = await response.json();
		const template = tileJSON?.tiles?.[0];

		if (typeof template !== 'string' || !/{z}/.test(template) || !/{x}/.test(template) || !/{y}/.test(template)) {
			throw new Error('TileJSON has no usable tile URL');
		}

		return template;
	} catch (e) {
		console.warn('Failed to load OpenFreeMap TileJSON, water and land cover will be missing:', e);

		return null;
	} finally {
		clearTimeout(timeoutId);
	}
}

export function resolveOpenFreeMapURL(template: string, x: number, y: number, z: number): string {
	return template
		.replace('{z}', String(z))
		.replace('{x}', String(x))
		.replace('{y}', String(y));
}

/**
 * Finds the tile that contains the given tile. OpenFreeMap has no tiles beyond OpenFreeMapMaxZoom,
 * so deeper zoom levels are served from a parent tile.
 */
export function getOpenFreeMapSourceTile(x: number, y: number, zoom: number): {x: number; y: number; zoom: number} {
	const sourceZoom = Math.min(zoom, OpenFreeMapMaxZoom);
	const shift = zoom - sourceZoom;

	return {x: x >> shift, y: y >> shift, zoom: sourceZoom};
}

/**
 * Downloads a tile. Resolves to null if the tile does not exist (e.g. open ocean).
 */
export async function fetchOpenFreeMapTile(template: string, x: number, y: number, zoom: number): Promise<ArrayBuffer | null> {
	const response = await fetch(resolveOpenFreeMapURL(template, x, y, zoom));

	if (response.status === 404) {
		return null;
	}

	if (!response.ok) {
		throw new Error(`OpenFreeMap tile ${zoom}/${x}/${y} responded with HTTP ${response.status}`);
	}

	return await response.arrayBuffer();
}
