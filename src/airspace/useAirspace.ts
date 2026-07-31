import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {AIRSPACE_CLASSES, type AirspaceClass, type AirspaceClassSettings} from "./classes";
import {loadAirspaceClass, loadAirspaceManifest, type AirspaceGeometry} from "./airspace";
import {logConsole} from "../console/consoleStore";
import type {SettingsApi} from "../settings/useSettings";

/** NASR is published on the 28-day AIRAC cycle. Past one full cycle the data on
 * screen has been superseded, and nothing else in the app would ever say so. */
const CYCLE_DAYS = 28;

export interface AirspaceState {
    /** Per-class presentation, straight from preferences. */
    classes: Record<AirspaceClass, AirspaceClassSettings>;
    /** Expanded geometry, by class. Populated lazily and then kept: expanding
     * Class E's arcs is seconds of work, and toggling it off and back on should
     * not repeat that. */
    loaded: ReadonlyMap<AirspaceClass, AirspaceGeometry>;
    /** Classes whose file is absent — Class E on a fresh clone. Surfaced so the
     * UI can say so rather than offering a control that does nothing. */
    unavailable: ReadonlySet<AirspaceClass>;
    pending: ReadonlySet<AirspaceClass>;
    setClass: (id: AirspaceClass, patch: Partial<AirspaceClassSettings>) => void;
    toggle: (id: AirspaceClass) => void;
}

/**
 * Owns the airspace geometry and reads its presentation from preferences.
 *
 * Visibility lives in `settings`, not here, so the Settings page and the View
 * menu are the same switch rather than two that can disagree. What this hook
 * keeps is the loaded geometry, which is cache, not preference.
 */
export function useAirspace(settings: SettingsApi): AirspaceState {
    const [loaded, setLoaded] = useState<ReadonlyMap<AirspaceClass, AirspaceGeometry>>(new Map());
    const [unavailable, setUnavailable] = useState<ReadonlySet<AirspaceClass>>(new Set());
    const [pending, setPending] = useState<ReadonlySet<AirspaceClass>>(new Set());

    const classes = settings.airspace;

    // Holds the in-flight request per class, so toggling off and straight back
    // on does not start a second fetch.
    //
    // Deliberately no `cancelled` flag gating the handlers below. Under
    // StrictMode the effect runs, is cleaned up, and runs again: a cancelled
    // flag would strand the first run's handlers, while the second run would
    // find the class already in this map and return early — leaving it stuck on
    // "loading…" forever with its data sitting in a resolved promise nobody
    // reads. Settling unconditionally is simpler and correct; a late update
    // after unmount is a no-op in React 18+.
    const inFlight = useRef(new Map<AirspaceClass, Promise<unknown>>());

    useEffect(() => {
        for (const definition of AIRSPACE_CLASSES) {
            const id = definition.id;
            if (!classes[id]?.visible || inFlight.current.has(id)) continue;

            setPending((current) => new Set(current).add(id));
            const request = loadAirspaceClass(id)
                .then((geometry) => {
                    if (geometry === null) {
                        setUnavailable((current) => new Set(current).add(id));
                    } else {
                        setLoaded((current) => new Map(current).set(id, geometry));
                    }
                })
                .catch((error: unknown) => {
                    console.error(`airspace: failed to load class ${id}`, error);
                    setUnavailable((current) => new Set(current).add(id));
                })
                .finally(() => {
                    setPending((current) => {
                        const next = new Set(current);
                        next.delete(id);
                        return next;
                    });
                });

            inFlight.current.set(id, request);
        }
    }, [classes]);

    // Reported once at startup. Which cycle is on screen is exactly the kind of
    // thing that is invisible until it matters, and by then you are standing in
    // a field looking at boundaries that moved two cycles ago.
    useEffect(() => {
        loadAirspaceManifest()
            .then((manifest) => {
                if (!manifest) {
                    logConsole("warn", "app", "Airspace data missing — run npm run build:airspace");
                    return;
                }

                const built = Object.entries(manifest.classes)
                    .map(([id, info]) => `${id.toUpperCase()} ${info.features}`)
                    .join(", ");
                logConsole("info", "app", `Airspace NASR ${manifest.cycle ?? "unknown cycle"} (${built})`);

                if (!manifest.cycle) return;
                const ageDays = (Date.now() - Date.parse(manifest.cycle)) / 86_400_000;
                if (ageDays > CYCLE_DAYS) {
                    logConsole(
                        "warn",
                        "app",
                        `Airspace cycle ${manifest.cycle} is ${Math.floor(ageDays)} days old ` +
                        `(${Math.floor(ageDays / CYCLE_DAYS)} cycle(s) behind) — boundaries may have changed`,
                    );
                }
            })
            .catch(() => {});
    }, []);

    const setClass = useCallback(
        (id: AirspaceClass, patch: Partial<AirspaceClassSettings>) => {
            settings.set("airspace", {
                ...settings.airspace,
                [id]: {...settings.airspace[id], ...patch},
            });
        },
        [settings],
    );

    const toggle = useCallback(
        (id: AirspaceClass) => setClass(id, {visible: !settings.airspace[id].visible}),
        [setClass, settings],
    );

    return useMemo(
        () => ({classes, loaded, unavailable, pending, setClass, toggle}),
        [classes, loaded, unavailable, pending, setClass, toggle],
    );
}
