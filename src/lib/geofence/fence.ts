export interface FenceVertex {
    id: number;
    lat: number;
    lon: number;
}

export interface DownloadedFence {
    /** Inclusion polygon vertices. */
    vertices: {lat: number; lon: number}[];
}
