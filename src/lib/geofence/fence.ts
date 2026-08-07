export interface FenceVertex {
    id: number;
    lat: number;
    lon: number;
}

export interface DownloadedFence {
    /** Return point (idx 0) — where the vehicle goes on breach. */
    returnPoint: {lat: number; lon: number} | null;
    /** Polygon vertices (idx 1..N). */
    vertices: {lat: number; lon: number}[];
}
