export interface FenceVertex {
    id: number;
    lat: number;
    lon: number;
}

export interface FencePolygon {
    id: number;
    vertices: FenceVertex[];
}

/**
 * A circular inclusion fence, defined by two real points rather than a
 * center + a stored radius: `center` and `edge`. The radius is always
 * `distanceMeters(center, edge)` — derived, never stored — so the edge
 * marker can be dragged to any bearing and just works, instead of always
 * snapping back to some fixed direction. Both are `null` until the user
 * places them (first map click sets `center`, second sets `edge`); either
 * being `null` is the "incomplete, can't upload yet" marker, mirroring how
 * a polygon with fewer than 3 vertices can't upload either.
 */
export interface FenceCircle {
    id: number;
    center: {lat: number; lon: number} | null;
    edge: {lat: number; lon: number} | null;
}

export interface DownloadedFence {
    polygons: {vertices: {lat: number; lon: number}[]}[];
    circles: {center: {lat: number; lon: number}; radiusM: number}[];
}

const EARTH_RADIUS_M = 6371000;

function toRad(deg: number): number {
    return (deg * Math.PI) / 180;
}

function toDeg(rad: number): number {
    return (rad * 180) / Math.PI;
}

/** Great-circle distance between two lat/lon points, in meters. */
export function distanceMeters(
    a: {lat: number; lon: number},
    b: {lat: number; lon: number},
): number {
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(Math.min(1, h)));
}

/** Point `distanceM` meters from `origin` along compass bearing `bearingDeg`. */
export function destinationPoint(
    origin: {lat: number; lon: number},
    bearingDeg: number,
    distanceM: number,
): {lat: number; lon: number} {
    const angularDistance = distanceM / EARTH_RADIUS_M;
    const bearing = toRad(bearingDeg);
    const lat1 = toRad(origin.lat);
    const lon1 = toRad(origin.lon);

    const lat2 = Math.asin(
        Math.sin(lat1) * Math.cos(angularDistance) +
            Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing),
    );
    const lon2 =
        lon1 +
        Math.atan2(
            Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
            Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
        );

    return {lat: toDeg(lat2), lon: toDeg(lon2)};
}

/** Polygon approximation of a circle, as [lon, lat] pairs, closed (first === last). */
export function circleRingCoords(
    center: {lat: number; lon: number},
    radiusM: number,
    steps = 64,
): [number, number][] {
    const coords: [number, number][] = [];
    for (let i = 0; i <= steps; i++) {
        const pt = destinationPoint(center, (360 * i) / steps, radiusM);
        coords.push([pt.lon, pt.lat]);
    }
    return coords;
}
