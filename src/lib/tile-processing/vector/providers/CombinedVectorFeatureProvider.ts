import VectorFeatureProvider from "~/lib/tile-processing/vector/providers/VectorFeatureProvider";
import VectorFeatureCollection from "~/lib/tile-processing/vector/features/VectorFeatureCollection";
import OverpassVectorFeatureProvider from "~/lib/tile-processing/vector/providers/OverpassVectorFeatureProvider";
import {Tile3DProviderParams} from "~/lib/tile-processing/tile3d/providers/Tile3DFromVectorProvider";

/**
 * Vector data source used by the tile pipeline. Data is fetched directly from a public Overpass instance.
 */
export default class CombinedVectorFeatureProvider extends VectorFeatureProvider {
	private readonly overpassProvider: OverpassVectorFeatureProvider;

	public constructor(params: Tile3DProviderParams) {
		super();

		this.overpassProvider = new OverpassVectorFeatureProvider(params.overpassEndpoint);
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
		return this.overpassProvider.getCollection({x, y, zoom});
	}
}
