import VectorFeatureProvider from "~/lib/tile-processing/vector/providers/VectorFeatureProvider";
import VectorFeatureCollection from "~/lib/tile-processing/vector/features/VectorFeatureCollection";
import OverpassVectorFeatureProvider from "~/lib/tile-processing/vector/providers/OverpassVectorFeatureProvider";
import OpenFreeMapVectorFeatureProvider from "~/lib/tile-processing/vector/providers/OpenFreeMapVectorFeatureProvider";
import {Tile3DProviderParams} from "~/lib/tile-processing/tile3d/providers/Tile3DFromVectorProvider";

/**
 * Vector data source used by the tile pipeline.
 * Buildings, roads and small objects come directly from a public Overpass instance (always up to date).
 * Water, forests, shrubs and farmland come from static OpenFreeMap tiles.
 */
export default class CombinedVectorFeatureProvider extends VectorFeatureProvider {
	private readonly overpassProvider: OverpassVectorFeatureProvider;
	private readonly openFreeMapProvider: OpenFreeMapVectorFeatureProvider | null;

	public constructor(params: Tile3DProviderParams) {
		super();

		this.overpassProvider = new OverpassVectorFeatureProvider(params.overpassEndpoint, params.allowStaleCache);
		this.openFreeMapProvider = params.openFreeMapTemplate
			? new OpenFreeMapVectorFeatureProvider(params.openFreeMapTemplate)
			: null;
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
		const [overpass, openFreeMap] = await Promise.all([
			this.overpassProvider.getCollection({x, y, zoom}),
			this.getOpenFreeMapCollection({x, y, zoom})
		]);

		// Large areas go first so that they are below everything else
		return {
			nodes: [...openFreeMap.nodes, ...overpass.nodes],
			polylines: [...openFreeMap.polylines, ...overpass.polylines],
			areas: [...openFreeMap.areas, ...overpass.areas]
		};
	}

	private async getOpenFreeMapCollection(
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
		const empty: VectorFeatureCollection = {nodes: [], polylines: [], areas: []};

		if (!this.openFreeMapProvider) {
			return empty;
		}

		try {
			return await this.openFreeMapProvider.getCollection({x, y, zoom});
		} catch (e) {
			// Missing water and forests are not worth losing the whole tile
			console.warn(`OpenFreeMap data is unavailable for tile ${x},${y}:`, e);

			return empty;
		}
	}
}
