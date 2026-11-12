import MathUtils from "~/lib/math/MathUtils";
import OverpassDataObject, {NodeElement, RelationElement, RelationMember, WayElement} from "./OverpassDataObject";
import VectorFeatureProvider from "~/lib/tile-processing/vector/providers/VectorFeatureProvider";
import VectorFeatureCollection from "~/lib/tile-processing/vector/features/VectorFeatureCollection";
import Vec2 from "~/lib/math/Vec2";
import OSMNodeHandler from "~/lib/tile-processing/vector/handlers/OSMNodeHandler";
import OSMWayHandler from "~/lib/tile-processing/vector/handlers/OSMWayHandler";
import OSMRelationHandler from "~/lib/tile-processing/vector/handlers/OSMRelationHandler";
import VectorBuildingOutlinesCleaner from "~/lib/tile-processing/vector/VectorBuildingOutlinesCleaner";
import {VectorFeature} from "~/lib/tile-processing/vector/features/VectorFeature";
import OSMHandler from "~/lib/tile-processing/vector/handlers/OSMHandler";
import {getCollectionFromVectorFeatures} from "~/lib/tile-processing/vector/utils";
import OverpassCache from "~/lib/tile-processing/vector/providers/OverpassCache";
import OverpassRequestError from "~/lib/tile-processing/vector/providers/OverpassRequestError";

const TileRequestMargin = 0.05;
const CacheMaxAgeMs = 7 * 24 * 60 * 60 * 1000;
const CacheMaxEntries = 1500;
// The query itself has [timeout:30]; give the server a little extra time to answer before giving up
const FetchTimeoutMs = 35000;

// One cache per worker; all workers share the same IndexedDB database
const cache = new OverpassCache(CacheMaxAgeMs, CacheMaxEntries);

const hashString = (str: string): string => {
	let hash = 5381;

	for (let i = 0; i < str.length; i++) {
		hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
	}

	return (hash >>> 0).toString(36);
};

// Only features that the qualifier factories (see qualifiers/factories/osm) turn into something are requested.
// Large areas (forests, farmland, water bodies, ...) are not rendered from OSM data directly, so asking Overpass for
// them would only make the response bigger. Keep these filters in sync with the factories.
const WayFilters = [
	'["building"]',
	'["building:part"]',
	'["highway"]',
	'["area:highway"]',
	'["waterway"]',
	'["man_made"~"^(pier|bridge)$"]',
	'["aeroway"~"^(runway|taxiway|apron|helipad)$"]',
	'["railway"~"^(rail|light_rail|subway|disused|narrow_gauge|tram)$"]',
	'["barrier"~"^(fence|hedge|wall)$"]',
	'["power"~"^(line|minor_line)$"]',
	'["natural"~"^(tree_row|sand|beach|rock|bare_rock)$"]',
	'["leisure"~"^(pitch|playground|dog_park|garden|swimming_pool)$"]',
	'["golf"="fairway"]',
	'["landuse"~"^(grass|construction|brownfield)$"]',
	'["amenity"~"^(parking|bicycle_parking)$"]'
];

// Relations are only needed for features that can be areas
const RelationFilters = [
	'["building"]',
	'["building:part"]',
	'["highway"]',
	'["area:highway"]',
	'["man_made"~"^(pier|bridge)$"]',
	'["aeroway"~"^(apron|helipad)$"]',
	'["natural"~"^(sand|beach|rock|bare_rock)$"]',
	'["leisure"~"^(pitch|playground|dog_park|garden|swimming_pool)$"]',
	'["golf"="fairway"]',
	'["landuse"~"^(grass|construction|brownfield)$"]',
	'["amenity"~"^(parking|bicycle_parking)$"]'
];

const NodeFilters = [
	'["natural"~"^(tree|rock)$"]',
	'["emergency"="fire_hydrant"]',
	'["advertising"="column"]',
	'["power"~"^(tower|pole|generator)$"]',
	'["amenity"="bench"]',
	'["leisure"="picnic_table"]',
	'["highway"~"^(bus_stop|turning_circle)$"]',
	'["historic"="memorial"]',
	'["tourism"="artwork"]',
	'["aeroway"="helipad"]'
];

export const getRequestBody = (x: number, y: number, zoom: number): string => {
	const position = [
		MathUtils.tile2degrees(x - TileRequestMargin, y + 1 + TileRequestMargin, zoom),
		MathUtils.tile2degrees(x + 1 + TileRequestMargin, y - TileRequestMargin, zoom)
	];
	const bbox = position[0].lat + ',' + position[0].lon + ',' + position[1].lat + ',' + position[1].lon;
	const ways = WayFilters.map(filter => `way${filter}(${bbox});`);
	const relations = [
		// Groups the outline and the parts of a building; usually has no tags of its own
		`rel["type"="building"](${bbox});`,
		...RelationFilters.map(filter => `rel["type"~"^(multipolygon|building)"]${filter}(${bbox});`)
	];
	const nodes = NodeFilters.map(filter => `node${filter}(${bbox});`);

	return `[out:json][timeout:30];
(
	${ways.join('\n\t')}
	${relations.join('\n\t')}
	${nodes.join('\n\t')}

	// Make sure that we have all parts of each building in the result
	(
		relation["building"](${bbox});
		>;
		way["building"](${bbox});
	) ->.buildingOutlines;
	way["building:part"](area.buildingOutlines);
) ->.features;
// The recursion adds all nodes (with their tags) of the selected ways and relations; everything is printed once
(.features; >>;);
out body qt;`;
};

export default class OverpassVectorFeatureProvider extends VectorFeatureProvider {
	/**
	 * @param overpassURL Endpoint to query.
	 * @param allowStaleCache If the request fails, fall back to a cached response even if it is older than the cache lifetime.
	 */
	public constructor(
		private readonly overpassURL: string,
		private readonly allowStaleCache: boolean = false
	) {
		super();
	}

	public async getCollection(
		{
			x,
			y,
			zoom
		}: {
			x: number;
			y: number;
			zoom: number;
		}
	): Promise<VectorFeatureCollection> {
		const tileOrigin = MathUtils.tile2meters(x, y + 1, zoom);
		const tileSize = MathUtils.getTileSizeInMeters(zoom);
		const overpassData = await this.fetchOverpassTile(x, y, zoom);

		const nodeHandlersMap: Map<number, OSMNodeHandler> = new Map();
		const wayHandlersMap: Map<number, OSMWayHandler> = new Map();
		const relationHandlersMap: Map<number, OSMRelationHandler> = new Map();

		const elements = OverpassVectorFeatureProvider.classifyElements(overpassData.elements);

		for (const element of elements.nodes) {
			// Mercator meters relative to the south-west corner of the tile: x points north, y points east
			const position = Vec2.sub(MathUtils.degrees2meters(element.lat, element.lon), tileOrigin);
			// Tile3DFromVectorProvider expects the same space as vector tiles (x points east, y points south),
			// from which it converts everything to world space
			const handler = new OSMNodeHandler(
				element,
				position.y,
				tileSize - position.x
			);

			nodeHandlersMap.set(element.id, handler);
		}

		for (const element of elements.ways) {
			const nodes = element.nodes.map(nodeId => {
				return nodeHandlersMap.get(nodeId);
			});

			const handler = new OSMWayHandler(
				element,
				nodes
			);

			wayHandlersMap.set(element.id, handler);
		}

		const osmMembersMap: Map<OSMRelationHandler, RelationMember[]> = new Map();

		for (const element of elements.relations) {
			const members = element.members.filter(member => member.type === 'way' || member.type === 'relation');

			if (members.length === 0) {
				continue;
			}

			const handler = new OSMRelationHandler(
				element
			);

			relationHandlersMap.set(element.id, handler);
			osmMembersMap.set(handler, members);
		}

		for (const relation of relationHandlersMap.values()) {
			const members = osmMembersMap.get(relation);

			for (const member of members) {
				const memberId = member.ref;
				let handler: OSMWayHandler | OSMRelationHandler;

				switch (member.type) {
					case 'way':
						handler = wayHandlersMap.get(memberId);
						break;
					case 'relation':
						handler = relationHandlersMap.get(memberId);
						break;
				}

				if (!handler) {
					console.error();
					continue;
				}

				relation.addMember(member, handler);
			}
		}

		const features = OverpassVectorFeatureProvider.getFeaturesFromHandlers([
			...nodeHandlersMap.values(),
			...wayHandlersMap.values(),
			...relationHandlersMap.values()
		]);
		const collection = getCollectionFromVectorFeatures(features);

		collection.areas = new VectorBuildingOutlinesCleaner().deleteBuildingOutlines(collection.areas);

		return collection;
	}

	private static getFeaturesFromHandlers(handlers: OSMHandler[]): VectorFeature[] {
		const features: VectorFeature[] = [];

		for (const handler of handlers) {
			features.push(...handler.getFeatures());
		}

		return features;
	}

	private async fetchOverpassTile(x: number, y: number, zoom: number): Promise<OverpassDataObject> {
		const body = getRequestBody(x, y, zoom);
		const key = `${zoom}/${x}/${y}/${hashString(body)}`;
		const cached = await cache.get(key);

		if (cached?.isFresh) {
			return cached.data;
		}

		try {
			const data = await OverpassVectorFeatureProvider.requestOverpass(this.overpassURL, body);

			// Do not wait for the write: the tile does not depend on it
			void cache.put(key, data);

			return data;
		} catch (error) {
			if (cached && this.allowStaleCache) {
				console.warn(`Overpass unavailable, using outdated cached data for tile ${x},${y}`, error);

				return cached.data;
			}

			throw error;
		}
	}

	private static async requestOverpass(url: string, body: string): Promise<OverpassDataObject> {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), FetchTimeoutMs);

		try {
			const response = await fetch(url, {
				method: 'POST',
				body: body,
				signal: controller.signal
			});

			if (!response.ok) {
				const retryAfter = Number(response.headers.get('Retry-After'));

				throw new OverpassRequestError(`${url} responded with HTTP ${response.status}`, {
					status: response.status,
					retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined
				});
			}

			const data = await response.json() as OverpassDataObject;

			// Overpass answers 200 with an empty or partial result and a remark when a query is cut short
			if (data.remark && /runtime error|timed out|out of memory/i.test(data.remark)) {
				throw new OverpassRequestError(`${url} could not finish the query: ${data.remark}`);
			}

			return data;
		} catch (error) {
			if (error instanceof OverpassRequestError) {
				throw error;
			}

			const reason = error?.name === 'AbortError' ? 'request timed out' : String(error?.message ?? error);

			throw new OverpassRequestError(`${url} request failed: ${reason}`);
		} finally {
			clearTimeout(timeoutId);
		}
	}

	private static classifyElements(elements: (NodeElement | WayElement | RelationElement)[]): {
		nodes: NodeElement[];
		ways: WayElement[];
		relations: RelationElement[];
	} {
		const nodes: NodeElement[] = [];
		const ways: WayElement[] = [];
		const relations: RelationElement[] = [];

		for (const el of elements) {
			switch (el.type) {
				case 'node':
					nodes.push(el);
					break;
				case 'way':
					ways.push(el);
					break;
				case 'relation':
					relations.push(el);
					break;
			}
		}

		return {nodes, ways, relations};
	}
}
