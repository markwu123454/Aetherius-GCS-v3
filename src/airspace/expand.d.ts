import type {Feature, FeatureCollection, Polygon, MultiPolygon, Position} from "geojson";

/** `["a", centreLon, centreLat, radiusMetres, startBearing, sweep]` */
export type ArcPrimitive = ["a", number, number, number, number, number];

/** `["l", lon, lat]` — a straight run to a single point. */
export type LinePrimitive = ["l", number, number];

/** `["p", lon, lat, lon, lat, …]` — points kept verbatim, flattened. Used for
 * boundaries with no recoverable arc structure (offshore Class E6, mostly). */
export type PointsPrimitive = ["p", ...number[]];

export type AirspacePrimitive = ArcPrimitive | LinePrimitive | PointsPrimitive;

/** A ring: where it starts, then primitives that each continue from the cursor. */
export interface EncodedRing {
    s: Position;
    d: AirspacePrimitive[];
}

export interface EncodedFeature {
    p: Record<string, string | number | null>;
    /** 1 when the geometry is a MultiPolygon. */
    m: 0 | 1;
    /** Polygons, each an array of rings — outer first, then holes. */
    g: EncodedRing[][];
}

export interface EncodedCollection {
    format: string;
    cycle: string | null;
    class: string;
    features: EncodedFeature[];
}

export function expandRing(ring: EncodedRing, sagittaMetres?: number): Position[];

export function expandFeature(
    feature: EncodedFeature,
    sagittaMetres?: number,
): Feature<Polygon | MultiPolygon>;

export function expandCollection(
    encoded: EncodedCollection,
    sagittaMetres?: number,
): FeatureCollection<Polygon | MultiPolygon>;
