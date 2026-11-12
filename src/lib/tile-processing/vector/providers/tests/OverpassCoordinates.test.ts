import OverpassVectorFeatureProvider from "~/lib/tile-processing/vector/providers/OverpassVectorFeatureProvider";
import Tile3DFromVectorProvider from "~/lib/tile-processing/tile3d/providers/Tile3DFromVectorProvider";
import {Tile3DFeaturesToBuffersConverter} from "~/lib/tile-processing/tile3d/buffers/Tile3DFeaturesToBuffersConverter";
import MathUtils from "~/lib/math/MathUtils";
import VectorArea, {VectorAreaRingType} from "~/lib/tile-processing/vector/features/VectorArea";
import {NodeElement, WayElement} from "~/lib/tile-processing/vector/providers/OverpassDataObject";

// The straight skeleton is a browser-only WebAssembly module and is not needed for flat roofs
jest.mock('straight-skeleton', () => ({SkeletonBuilder: {init: async (): Promise<void> => undefined}}));

const X = 24891;
const Y = 37056;
const Zoom = 16;
const TileSize = MathUtils.getTileSizeInMeters(Zoom);

type Point = [number, number]; // fractions of the tile: [east, south]

let nextId = 1;

const mockOverpass = (elements: (NodeElement | WayElement | object)[]): void => {
	(globalThis as any).fetch = jest.fn(async () => ({
		ok: true,
		status: 200,
		headers: {get: (): null => null},
		json: async (): Promise<object> => ({version: 0.6, generator: 'test', osm3s: {}, elements})
	}));
};

const createClosedWay = (points: Point[], tags: Record<string, string>): (NodeElement | WayElement)[] => {
	const nodes: NodeElement[] = points.map(([fx, fy]) => {
		const {lat, lon} = MathUtils.tile2degrees(X + fx, Y + fy, Zoom);

		return {type: 'node', id: nextId++, lat, lon};
	});
	const way: WayElement = {
		type: 'way',
		id: nextId++,
		nodes: [...nodes, nodes[0]].map(n => n.id),
		tags
	};

	return [...nodes, way];
};

// A square 10% of the tile wide that is closer to the east and to the north than to the west and to the south
const SquareCounterclockwise: Point[] = [[0.6, 0.35], [0.6, 0.25], [0.7, 0.25], [0.7, 0.35]];
const SquareClockwise: Point[] = [...SquareCounterclockwise].reverse();

// Same formula as in the vector tile handlers: outer rings must be negative in the tile space
const gaussSum = (nodes: {x: number; y: number}[]): number => {
	let sum = 0;

	for (let i = 0; i < nodes.length; i++) {
		const a = nodes[i];
		const b = nodes[i + 1] ?? nodes[0];

		sum += (b.x - a.x) * (b.y + a.y);
	}

	return sum;
};

describe('Overpass data in the vector tile space', () => {
	const getBuilding = async (points: Point[]): Promise<VectorArea> => {
		mockOverpass(createClosedWay(points, {building: 'yes'}));

		const {areas} = await new OverpassVectorFeatureProvider('https://overpass.test').getCollection({x: X, y: Y, zoom: Zoom});

		return areas.find(a => a.descriptor.type === 'building');
	};

	it('should put positions in the same space as vector tiles: x points east, y points south', async () => {
		const building = await getBuilding(SquareCounterclockwise);
		const xs = building.rings[0].nodes.map(n => n.x);
		const ys = building.rings[0].nodes.map(n => n.y);

		expect(Math.min(...xs)).toBeCloseTo(0.6 * TileSize, 1);
		expect(Math.max(...xs)).toBeCloseTo(0.7 * TileSize, 1);
		expect(Math.min(...ys)).toBeCloseTo(0.25 * TileSize, 1);
		expect(Math.max(...ys)).toBeCloseTo(0.35 * TileSize, 1);
	});

	it.each([
		['counterclockwise', SquareCounterclockwise],
		['clockwise', SquareClockwise]
	])('should make outer rings clockwise like vector tiles do (%s input)', async (_, points) => {
		const building = await getBuilding(points);
		const ring = building.rings[0];

		expect(ring.type).toBe(VectorAreaRingType.Outer);
		expect(gaussSum(ring.nodes)).toBeLessThan(0);
	});

	it('should make inner rings of multipolygons counterclockwise', async () => {
		const outerWay = createClosedWay([[0.2, 0.2], [0.2, 0.8], [0.8, 0.8], [0.8, 0.2]], {});
		const innerWay = createClosedWay([[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]], {});
		const ways = [outerWay, innerWay].map(list => list.find(e => e.type === 'way') as WayElement);

		mockOverpass([
			...outerWay,
			...innerWay,
			{
				type: 'relation',
				id: nextId++,
				tags: {type: 'multipolygon', building: 'yes'},
				members: [
					{type: 'way', ref: ways[0].id, role: 'outer'},
					{type: 'way', ref: ways[1].id, role: 'inner'}
				]
			}
		]);

		const {areas} = await new OverpassVectorFeatureProvider('https://overpass.test').getCollection({x: X, y: Y, zoom: Zoom});
		const building = areas.find(a => a.descriptor.type === 'building');

		expect(building.rings).toHaveLength(2);

		for (const ring of building.rings) {
			if (ring.type === VectorAreaRingType.Outer) {
				expect(gaussSum(ring.nodes)).toBeLessThan(0);
			} else {
				expect(gaussSum(ring.nodes)).toBeGreaterThan(0);
			}
		}
	});

	it('should give the straight skeleton counterclockwise outer rings in world space and convert shared nodes once', async () => {
		for (const points of [SquareCounterclockwise, SquareClockwise]) {
			mockOverpass(createClosedWay(points, {building: 'yes'}));

			const fresh = await new OverpassVectorFeatureProvider('https://overpass.test').getCollection({x: X, y: Y, zoom: Zoom});
			const ring = fresh.areas.find(a => a.descriptor.type === 'building').rings[0];
			const [firstNode, lastNode] = [ring.nodes[0], ring.nodes[ring.nodes.length - 1]];

			// A closed way refers to its first node twice
			expect(firstNode).toBe(lastNode);

			(Tile3DFromVectorProvider as any).transformVectorFeaturesToWorldSpace(fresh, X, Y, Zoom);

			// Standard (y-up) signed area of the world space ring; the straight skeleton needs it to be positive
			let area = 0;

			for (let i = 0; i < ring.nodes.length - 1; i++) {
				const a = ring.nodes[i];
				const b = ring.nodes[i + 1];

				area += a.x * b.y - b.x * a.y;
			}

			expect(area / 2).toBeGreaterThan(0);
			// 10% x 10% of the tile
			expect(area / 2).toBeCloseTo(0.1 * TileSize * 0.1 * TileSize, -1);
			expect(firstNode.x).toBeCloseTo(lastNode.x, 6);
		}
	});

	it('should end up at the right place in world space (x points north, z points east)', async () => {
		mockOverpass(createClosedWay(SquareCounterclockwise, {building: 'yes', 'building:levels': '3'}));

		const provider = new Tile3DFromVectorProvider({
			overpassEndpoint: 'https://overpass.test',
			allowStaleCache: false,
			openFreeMapTemplate: null,
			heightPromise: async (positions: Float64Array): Promise<Float64Array> => new Float64Array(positions.length / 2)
		});
		const buffers = Tile3DFeaturesToBuffersConverter.convert(await provider.getCollection({x: X, y: Y, zoom: Zoom}));
		const positions = buffers.extruded.positionBuffer;
		const xs: number[] = [];
		const zs: number[] = [];

		for (let i = 0; i < positions.length; i += 3) {
			xs.push(positions[i]);
			zs.push(positions[i + 2]);
		}

		// north offset = tile size - south offset
		expect(Math.min(...xs)).toBeCloseTo(0.65 * TileSize, 0);
		expect(Math.max(...xs)).toBeCloseTo(0.75 * TileSize, 0);
		expect(Math.min(...zs)).toBeCloseTo(0.6 * TileSize, 0);
		expect(Math.max(...zs)).toBeCloseTo(0.7 * TileSize, 0);
	});
});
