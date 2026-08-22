/** One rally point being edited — `id` is a frontend-only React key, same
 * role as `FenceVertex.id` in `geofence/fence.ts`. */
export interface RallyPointDraft {
    id: number;
    lat: number;
    lon: number;
    /** Meters, relative to home — matches what the backend uploads/downloads. */
    alt: number;
}

export interface DownloadedRallyPoint {
    lat: number;
    lon: number;
    alt: number;
}
