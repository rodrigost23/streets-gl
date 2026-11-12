import VectorFeatureProvider from "~/lib/tile-processing/vector/providers/VectorFeatureProvider";
import VectorFeatureCollection from "~/lib/tile-processing/vector/features/VectorFeatureCollection";
import VectorArea from "~/lib/tile-processing/vector/features/VectorArea";
import PBFGeometryParser, {PBFPolygon} from "~/lib/tile-processing/vector/providers/pbf/PBFGeometryParser";
import MapboxAreaHandler from "~/lib/tile-processing/vector/handlers/MapboxAreaHandler";
import {VectorAreaDescriptor} from "~/lib/tile-processing/vector/qualifiers/descriptors";
import {
	fetchOpenFreeMapTile,
	getOpenFreeMapSourceTile
} from "~/lib/tile-processing/vector/providers/OpenFreeMapTiles";

const Pbf = require('pbf');
const proto = require('./pbf/vector_tile.js').Tile;

const PolygonGeometryType = 3;
// Same margin as the one used for Overpass requests
const TileMargin = 0.05;

interface PBFValue {
	string_value?: string;
}

interface PBFLayerFeature {
	type: number;
	tags: number[];
	geometry: number[];
}

interface PBFLayer {
	name: string;
	extent: number;
	keys: string[];
	values: PBFValue[];
	features: PBFLayerFeature[];
}

type AreaType = VectorAreaDescriptor['type'];

/**
 * Provides large areas (water, forests, shrubs, farmland) that are not taken from OSM data directly.
 * The tiles use the OpenMapTiles schema.
 */
export default class OpenFreeMapVectorFeatureProvider extends VectorFeatureProvider {
	public constructor(private readonly tileTemplate: string) {
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
		const collection: VectorFeatureCollection = {nodes: [], polylines: [], areas: []};
		const source = getOpenFreeMapSourceTile(x, y, zoom);
		const buffer = await fetchOpenFreeMapTile(this.tileTemplate, source.x, source.y, source.zoom);

		if (!buffer) {
			return collection;
		}

		const sourceSize = 40075016.68 / (1 << source.zoom);
		const tileSize = 40075016.68 / (1 << zoom);
		// Position of the requested tile inside of the source tile
		const shift = zoom - source.zoom;
		const offsetX = (x - (source.x << shift)) * tileSize;
		const offsetY = (y - (source.y << shift)) * tileSize;
		const margin = tileSize * TileMargin;

		const layers: PBFLayer[] = proto.read(new Pbf(buffer)).layers;

		for (const layer of layers) {
			for (const feature of layer.features) {
				if (feature.type !== PolygonGeometryType) {
					continue;
				}

				const areaType = OpenFreeMapVectorFeatureProvider.getAreaType(layer, feature);

				if (!areaType) {
					continue;
				}

				// The parser divides by (extent - 1), while MVT coordinates span the whole extent
				const polygon = PBFGeometryParser.convertCommandsToPolygon(feature.geometry, layer.extent + 1, sourceSize)
					.map(ring => ring.map(([px, py]): [number, number] => [px - offsetX, py - offsetY]));

				// A feature can be a multipolygon, so every part has to be checked on its own
				for (const area of OpenFreeMapVectorFeatureProvider.createAreas(polygon, areaType)) {
					if (OpenFreeMapVectorFeatureProvider.isAreaNearTile(area, tileSize, margin)) {
						collection.areas.push(area);
					}
				}
			}
		}

		return collection;
	}

	private static createAreas(polygon: PBFPolygon, type: AreaType): VectorArea[] {
		try {
			const handler = new MapboxAreaHandler({type});

			for (const ring of polygon) {
				if (ring.length >= 4) {
					handler.addRing(ring);
				}
			}

			return handler.getFeatures();
		} catch (e) {
			// A single broken polygon must not break the tile
			console.warn('Skipped an invalid OpenFreeMap polygon:', e);

			return [];
		}
	}

	private static getAreaType(layer: PBFLayer, feature: PBFLayerFeature): AreaType | null {
		const tags = OpenFreeMapVectorFeatureProvider.getTags(layer, feature);

		switch (layer.name) {
			case 'water':
				return 'water';
			case 'landcover':
				if (tags.class === 'wood') {
					return 'forest';
				}

				if (tags.subclass === 'scrub') {
					return 'shrubbery';
				}

				if (tags.class === 'farmland') {
					return 'farmland';
				}

				return null;
			default:
				return null;
		}
	}

	private static getTags(layer: PBFLayer, feature: PBFLayerFeature): Record<string, string> {
		const tags: Record<string, string> = {};

		for (let i = 0; i < feature.tags.length; i += 2) {
			tags[layer.keys[feature.tags[i]]] = layer.values[feature.tags[i + 1]].string_value;
		}

		return tags;
	}

	private static isAreaNearTile(area: VectorArea, tileSize: number, margin: number): boolean {
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;

		// Holes are inside of the outer ring, so it is enough to look at the outer one
		for (const node of area.rings[0].nodes) {
			minX = Math.min(minX, node.x);
			minY = Math.min(minY, node.y);
			maxX = Math.max(maxX, node.x);
			maxY = Math.max(maxY, node.y);
		}

		return maxX >= -margin && minX <= tileSize + margin && maxY >= -margin && minY <= tileSize + margin;
	}
}
