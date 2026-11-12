import earcut from 'earcut';
import TileSource from "./TileSource";
import AbstractMesh from "~/lib/renderer/abstract-renderer/AbstractMesh";
import Config from "~/app/Config";
import {
	fetchOpenFreeMapTemplate,
	fetchOpenFreeMapTile,
	getOpenFreeMapSourceTile
} from "~/lib/tile-processing/vector/providers/OpenFreeMapTiles";
import {Tile as proto} from "~/lib/tile-processing/vector/providers/pbf/vector_tile";
import WaterMask from "../../objects/WaterMask";
import AbstractRenderer from "~/lib/renderer/abstract-renderer/AbstractRenderer";
import PBFGeometryParser, {PBFPolygon, PBFRing} from "~/lib/tile-processing/vector/providers/pbf/PBFGeometryParser";

const Pbf = require('pbf');
const PolygonGeometryType = 3;

export default class WaterTileSource extends TileSource<Float32Array> {
	private mask: WaterMask = null;

	public constructor(x: number, y: number, zoom: number) {
		super(x, y, zoom);
	}

	/**
	 * Water polygons of the tile in tile-relative coordinates (0..1), taken from OpenFreeMap.
	 * Without them the mask is simply empty.
	 */
	private async fetchPolygons(x: number, y: number, zoom: number): Promise<PBFPolygon[]> {
		const polygons: PBFPolygon[] = [];

		try {
			const template = await fetchOpenFreeMapTemplate(Config.OpenFreeMapTileJSON);

			if (!template) {
				return polygons;
			}

			const source = getOpenFreeMapSourceTile(x, y, zoom);
			const buffer = await fetchOpenFreeMapTile(template, source.x, source.y, source.zoom);

			if (!buffer) {
				return polygons;
			}

			// Tiles of deeper zoom levels are cut from their parent tile
			const shift = zoom - source.zoom;
			const scale = 1 << shift;
			const offsetX = x - (source.x << shift);
			const offsetY = y - (source.y << shift);
			const layers = proto.read(new Pbf(buffer)).layers;

			for (const layer of layers) {
				if (layer.name !== 'water') {
					continue;
				}

				for (const feature of layer.features) {
					if (feature.type !== PolygonGeometryType || WaterTileSource.isSwimmingPool(layer, feature)) {
						continue;
					}

					// The parser divides by (extent - 1), while MVT coordinates span the whole extent
					const polygon = PBFGeometryParser.convertCommandsToPolygon(feature.geometry, layer.extent + 1, 1)
						.map(ring => ring.map(([px, py]): [number, number] => [px * scale - offsetX, py * scale - offsetY]));

					polygons.push(polygon);
				}
			}
		} catch (e) {
			console.warn(`Failed to load water mask for tile ${zoom}/${x}/${y}:`, e);
		}

		return polygons;
	}

	private static isSwimmingPool(layer: {keys: string[]; values: {string_value?: string}[]}, feature: {tags: number[]}): boolean {
		for (let i = 0; i < feature.tags.length; i += 2) {
			if (layer.keys[feature.tags[i]] === 'class') {
				return layer.values[feature.tags[i + 1]].string_value === 'swimming_pool';
			}
		}

		return false;
	}

	public async load(): Promise<void> {
		const polygons = await this.fetchPolygons(this.x, this.y, this.zoom);
		const tris = this.polygonsToTriangles(polygons, 0, 0);
		this.data = new Float32Array(tris);
	}

	private polygonsToTriangles(polygons: PBFPolygon[], offsetX: number, offsetY: number): number[] {
		const vertices: number[] = [];

		for (const polygon of polygons) {
			const types: number[] = [];

			for (const ring of polygon) {
				types.push(WaterTileSource.isRingClockwise(ring) ? 0 : 1);
			}

			for (let i = 0; i < types.length; i++) {
				const outer = polygon[i].flat();
				const holeIndices: number[] = [];
				let index = outer.length / 2;

				for (let j = i + 1; j < types.length; j++) {
					if (types[j] === 1) {
						const inner = polygon[j].flat()

						holeIndices.push(index);
						index += inner.length / 2;
						outer.push(...inner);
						++i;
					} else {
						break;
					}
				}

				const triangles = earcut(outer, holeIndices).reverse();

				for (let j = 0; j < triangles.length; j++) {
					vertices.push(
						outer[triangles[j] * 2 + 1] + offsetX,
						outer[triangles[j] * 2] + offsetY
					);
				}
			}
		}

		return vertices;
	}

	public getMesh(renderer: AbstractRenderer): AbstractMesh {
		if (!this.data) {
			throw new Error();
		}

		if (!this.mask) {
			this.mask = new WaterMask(this.data);
			this.mask.updateMesh(renderer);
		}

		return this.mask.mesh;
	}

	private static isRingClockwise(ring: PBFRing): boolean {
		let sum = 0;

		for (let i = 0; i < ring.length; i++) {
			const point1 = ring[i];
			const point2 = ring[i + 1] ?? ring[0];
			sum += (point2[0] - point1[0]) * (point2[1] + point1[1]);
		}

		return sum < 0;
	}

	public delete(): void {
		this.deleted = true;

		if (this.mask) {
			this.mask.delete();
		}
	}
}