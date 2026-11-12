import * as fs from 'fs';
import * as path from 'path';
import OpenFreeMapVectorFeatureProvider from "~/lib/tile-processing/vector/providers/OpenFreeMapVectorFeatureProvider";
import {
	fetchOpenFreeMapTemplate,
	getOpenFreeMapSourceTile,
	resolveOpenFreeMapURL
} from "~/lib/tile-processing/vector/providers/OpenFreeMapTiles";
import VectorArea from "~/lib/tile-processing/vector/features/VectorArea";

// Real OpenFreeMap tile 14/6222/9264 (Rio de Janeiro, Tijuca), which contains the z16 tiles x 24888..24891, y 37056..37059
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/openfreemap-14-6222-9264.pbf'));
const Template = 'https://tiles.example/planet/v1/{z}/{x}/{y}.pbf';
const TileSize16 = 40075016.68 / (1 << 16);

const mockFetch = (impl: (url: string) => Promise<Partial<Response>>): jest.Mock => {
	const mock = jest.fn(impl);

	(globalThis as any).fetch = mock;

	return mock;
};

const bytes = (): ArrayBuffer => fixture.buffer.slice(fixture.byteOffset, fixture.byteOffset + fixture.byteLength);

const jsonResponse = (data: unknown) => async (): Promise<Partial<Response>> => ({
	ok: true,
	status: 200,
	json: async (): Promise<unknown> => data
});

const tileResponse = async (): Promise<Partial<Response>> => ({
	ok: true,
	status: 200,
	arrayBuffer: async (): Promise<ArrayBuffer> => bytes()
});

const getBounds = (area: VectorArea): {minX: number; maxX: number; minY: number; maxY: number} => {
	const xs = area.rings.flatMap(r => r.nodes.map(n => n.x));
	const ys = area.rings.flatMap(r => r.nodes.map(n => n.y));

	return {minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys)};
};

describe('OpenFreeMap helpers', () => {
	it('should use the tile itself up to zoom 14 and a parent tile below', () => {
		expect(getOpenFreeMapSourceTile(100, 200, 13)).toEqual({x: 100, y: 200, zoom: 13});
		expect(getOpenFreeMapSourceTile(24891, 37056, 16)).toEqual({x: 6222, y: 9264, zoom: 14});
	});

	it('should fill the URL template', () => {
		expect(resolveOpenFreeMapURL(Template, 1, 2, 3)).toBe('https://tiles.example/planet/v1/3/1/2.pbf');
	});

	it('should read the template from TileJSON and retry after a failure', async () => {
		jest.resetModules();
		const {fetchOpenFreeMapTemplate: fetchTemplate} = await import("~/lib/tile-processing/vector/providers/OpenFreeMapTiles");
		jest.spyOn(console, 'warn').mockImplementation(() => undefined);

		const mock = mockFetch(async () => ({ok: false, status: 503}));
		expect(await fetchTemplate('https://tilejson.example')).toBeNull();

		mock.mockImplementation(jsonResponse({tiles: [Template]}));
		expect(await fetchTemplate('https://tilejson.example')).toBe(Template);

		// A successful answer is reused
		await fetchTemplate('https://tilejson.example');
		expect(mock).toHaveBeenCalledTimes(2);
	});

	it('should reject a TileJSON without a usable URL', async () => {
		jest.resetModules();
		const {fetchOpenFreeMapTemplate: fetchTemplate} = await import("~/lib/tile-processing/vector/providers/OpenFreeMapTiles");
		jest.spyOn(console, 'warn').mockImplementation(() => undefined);
		mockFetch(jsonResponse({tiles: ['https://x.example/static.pbf']}));

		expect(await fetchTemplate('https://tilejson.example')).toBeNull();
		expect(fetchOpenFreeMapTemplate).toBeDefined();
	});
});

describe('OpenFreeMapVectorFeatureProvider', () => {
	const provider = new OpenFreeMapVectorFeatureProvider(Template);

	beforeEach(() => {
		mockFetch(tileResponse);
	});

	it('should request the parent z14 tile', async () => {
		const mock = mockFetch(tileResponse);

		await provider.getCollection({x: 24891, y: 37056, zoom: 16});

		expect(mock).toHaveBeenCalledWith('https://tiles.example/planet/v1/14/6222/9264.pbf');
	});

	it('should return water, forests and shrubs only, as areas', async () => {
		const types = new Set<string>();

		for (let dx = 0; dx < 4; dx++) {
			for (let dy = 0; dy < 4; dy++) {
				const collection = await provider.getCollection({x: 24888 + dx, y: 37056 + dy, zoom: 16});

				expect(collection.nodes).toHaveLength(0);
				expect(collection.polylines).toHaveLength(0);
				collection.areas.forEach(a => types.add(a.descriptor.type));
			}
		}

		expect(types.has('water')).toBe(true);
		expect(types.has('forest')).toBe(true);
		expect([...types].every(t => ['water', 'forest', 'shrubbery', 'farmland'].includes(t))).toBe(true);
	});

	it('should return finite coordinates for polygons that touch the tile only', async () => {
		const margin = TileSize16 * 0.05;

		for (let dx = 0; dx < 4; dx++) {
			for (let dy = 0; dy < 4; dy++) {
				const {areas} = await provider.getCollection({x: 24888 + dx, y: 37056 + dy, zoom: 16});

				for (const area of areas) {
					const b = getBounds(area);

					expect(Number.isFinite(b.minX) && Number.isFinite(b.maxY)).toBe(true);
					expect(b.maxX).toBeGreaterThanOrEqual(-margin);
					expect(b.minX).toBeLessThanOrEqual(TileSize16 + margin);
					expect(b.maxY).toBeGreaterThanOrEqual(-margin);
					expect(b.minY).toBeLessThanOrEqual(TileSize16 + margin);
				}
			}
		}
	});

	it('should place neighbouring tiles exactly one tile apart', async () => {
		// The same polygon seen from two tiles has the same shape: all of its vertices are moved by the same offset
		const findOffsets = async (a: [number, number], b: [number, number]): Promise<[number, number][]> => {
			const first = await provider.getCollection({x: a[0], y: a[1], zoom: 16});
			const second = await provider.getCollection({x: b[0], y: b[1], zoom: 16});
			const offsets: [number, number][] = [];

			for (const area of first.areas) {
				for (const other of second.areas) {
					const nodesA = area.rings[0].nodes;
					const nodesB = other.rings[0].nodes;

					if (area.descriptor.type !== other.descriptor.type || nodesA.length !== nodesB.length) {
						continue;
					}

					const dx = nodesA[0].x - nodesB[0].x;
					const dy = nodesA[0].y - nodesB[0].y;
					const isSameShape = nodesA.every((n, i) => {
						return Math.abs(n.x - nodesB[i].x - dx) < 1e-6 && Math.abs(n.y - nodesB[i].y - dy) < 1e-6;
					});

					if (isSameShape) {
						offsets.push([dx, dy]);
					}
				}
			}

			return offsets;
		};

		const horizontal = await findOffsets([24889, 37057], [24890, 37057]);
		const vertical = await findOffsets([24889, 37057], [24889, 37058]);

		expect(horizontal.length).toBeGreaterThan(0);
		expect(vertical.length).toBeGreaterThan(0);

		for (const [dx, dy] of horizontal) {
			expect(dx).toBeCloseTo(TileSize16, 3);
			expect(dy).toBeCloseTo(0, 3);
		}

		for (const [dx, dy] of vertical) {
			expect(dx).toBeCloseTo(0, 3);
			expect(dy).toBeCloseTo(TileSize16, 3);
		}
	});

	it('should return nothing for a missing tile', async () => {
		mockFetch(async () => ({ok: false, status: 404}));

		expect(await provider.getCollection({x: 1, y: 1, zoom: 16})).toEqual({nodes: [], polylines: [], areas: []});
	});

	it('should fail on server errors so that the caller can decide what to do', async () => {
		mockFetch(async () => ({ok: false, status: 500}));

		await expect(provider.getCollection({x: 1, y: 1, zoom: 16})).rejects.toThrow('HTTP 500');
	});
});
