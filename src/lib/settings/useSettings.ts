import {useCallback, useEffect, useState} from "react";
import {load, Store} from "@tauri-apps/plugin-store";
import {DEFAULT_SETTINGS, Settings} from "./settings.ts";

const STORE_FILE = "settings.json";
/** The whole object lives under one key, mirroring how `layout.ts` and
 * `connection.ts` persist a single blob rather than one entry per field. */
const SETTINGS_KEY = "settings";

/** One store handle shared by every `useSettings()` call, rather than a
 * separate file open per component that reads a preference. */
let storePromise: Promise<Store> | null = null;

function openStore(): Promise<Store> {
    storePromise ??= load(STORE_FILE, {autoSave: false});
    return storePromise;
}

async function readSettings(): Promise<Settings> {
    const store = await openStore();
    const saved = await store.get<Partial<Settings>>(SETTINGS_KEY);
    return {
        ...DEFAULT_SETTINGS,
        ...saved,
        // Merged a level deeper than the rest. A settings file written before a
        // new airspace class existed has an `airspace` object without it, and a
        // plain spread would take that object wholesale — leaving the new class
        // undefined and every read of it throwing.
        airspace: {...DEFAULT_SETTINGS.airspace, ...saved?.airspace},
        mapRegionalLayers: {...DEFAULT_SETTINGS.mapRegionalLayers, ...saved?.mapRegionalLayers},
    };
}

async function persist(settings: Settings): Promise<void> {
    const store = await openStore();
    await store.set(SETTINGS_KEY, settings);
    // Store writes are otherwise batched to disk on an interval; preferences
    // are rare and worth flushing immediately so a crash right after can't
    // lose one.
    await store.save();
}

// Shared in-memory state — all useSettings() instances read from and write to
// this single object so a change in the Settings panel propagates live to the
// map and every other consumer without a page reload.
let current: Settings = DEFAULT_SETTINGS;
const listeners = new Set<(s: Settings) => void>();
let loadPromise: Promise<void> | null = null;

function emit(settings: Settings): void {
    current = settings;
    for (const fn of listeners) fn(settings);
}

function ensureLoaded(): void {
    loadPromise ??= readSettings()
        .then(emit)
        // No Tauri backend in a plain browser tab; defaults stand.
        .catch(() => {});
}

export interface SettingsApi extends Settings {
    set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

/**
 * Preferences persisted to a real file on disk via `tauri-plugin-store`
 * (`AppData/<app>/settings.json`), not `localStorage` — a webview storage
 * reset or a "reset app data" shouldn't silently revert the operator's
 * choices.
 *
 * All hook instances share a single in-memory snapshot (`current`) and a
 * listener set so that a `set()` call in one component immediately propagates
 * to every other consumer without a reload.
 */
export function useSettings(): SettingsApi {
    const [settings, setSettings] = useState<Settings>(current);

    useEffect(() => {
        listeners.add(setSettings);
        ensureLoaded();
        return () => {
            listeners.delete(setSettings);
        };
    }, []);

    const set = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
        const next = {...current, [key]: value};
        persist(next).catch(() => {});
        emit(next);
    }, []);

    return {...settings, set};
}
