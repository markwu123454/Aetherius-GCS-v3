import {useEffect, useMemo, useRef, useState} from "react";
import {useVehicle} from "@/lib/vehicle/useVehicle.ts";
import {useConnection} from "@/lib/vehicle/useConnection.ts";
import {isLinkIdle} from "@/lib/vehicle/connection.ts";

/** 2 hours at 1 Hz. */
const MAX_POINTS = 7200;
const SAMPLE_MS = 1000;

interface TrackPoint {
    lon: number;
    lat: number;
    armed: boolean;
}

export interface TrackFeature {
    type: "Feature";
    properties: Record<string, never>;
    geometry: {type: "MultiLineString"; coordinates: [number, number][][]};
}

export interface VehicleTrack {
    disarmed: TrackFeature;
    armed: TrackFeature;
}

function emptyFeature(): TrackFeature {
    return {type: "Feature", properties: {}, geometry: {type: "MultiLineString", coordinates: []}};
}

function buildTrack(points: TrackPoint[]): VehicleTrack {
    if (points.length === 0) return {disarmed: emptyFeature(), armed: emptyFeature()};

    const disarmedSegments: [number, number][][] = [];
    const armedSegments: [number, number][][] = [];

    let current: [number, number][] = [];
    let currentArmed = points[0].armed;

    for (const pt of points) {
        if (pt.armed !== currentArmed) {
            if (current.length >= 2) (currentArmed ? armedSegments : disarmedSegments).push(current);
            current = [];
            currentArmed = pt.armed;
        }
        current.push([pt.lon, pt.lat]);
    }
    if (current.length >= 2) (currentArmed ? armedSegments : disarmedSegments).push(current);

    return {
        disarmed: {type: "Feature", properties: {}, geometry: {type: "MultiLineString", coordinates: disarmedSegments}},
        armed:    {type: "Feature", properties: {}, geometry: {type: "MultiLineString", coordinates: armedSegments}},
    };
}

/**
 * Accumulates the vehicle's GPS track for the current connection at 1 Hz,
 * split into disarmed (gray) and armed (blue) segments.
 *
 * The track resets on disconnect — the vehicle's own logs are the right place
 * to review historical flight paths; this is only for the current session.
 *
 * Points where lat and lon are both exactly 0 are dropped. This is not a
 * robust GPS-fix check (the Gulf of Guinea is real), but it is the simplest
 * way to avoid plotting the default no-fix position.
 */
export function useVehicleTrack(): VehicleTrack {
    const vehicle = useVehicle();
    const connection = useConnection();

    const positionRef = useRef(vehicle.position);
    const armedRef = useRef(vehicle.armed);
    useEffect(() => { positionRef.current = vehicle.position; }, [vehicle.position]);
    useEffect(() => { armedRef.current = vehicle.armed; }, [vehicle.armed]);

    const [points, setPoints] = useState<TrackPoint[]>([]);

    // Entire GCS state resets on disconnect, track included.
    const idle = isLinkIdle(connection.status);
    useEffect(() => {
        if (idle) setPoints([]);
    }, [idle]);

    useEffect(() => {
        const id = setInterval(() => {
            const pos = positionRef.current;
            if (!pos) return;
            if (pos.lat === 0 && pos.lon === 0) return;

            setPoints(prev => {
                const next = [...prev, {lon: pos.lon, lat: pos.lat, armed: armedRef.current}];
                return next.length > MAX_POINTS ? next.slice(1) : next;
            });
        }, SAMPLE_MS);
        return () => clearInterval(id);
    }, []);

    return useMemo(() => buildTrack(points), [points]);
}
