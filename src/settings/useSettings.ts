import {useCallback, useEffect, useState} from "react";
import {load, Store} from "@tauri-apps/plugin-store";
import {DEFAULT_SETTINGS, Settings} from "./settings";

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
    return {...DEFAULT_SETTINGS, ...saved};
}

async function persist(settings: Settings): Promise<void> {
    const store = await openStore();
    await store.set(SETTINGS_KEY, settings);
    // Store writes are otherwise batched to disk on an interval; preferences
    // are rare and worth flushing immediately so a crash right after can't
    // lose one.
    await store.save();
}

export interface SettingsApi extends Settings {
    set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

/**
 * Preferences persisted to a real file on disk via `tauri-plugin-store`
 * (`AppData/<app>/settings.json`), not `localStorage` — a webview storage
 * reset or a "reset app data" shouldn't silently revert the operator's
 * choices.
 */
export function useSettings(): SettingsApi {
    const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

    useEffect(() => {
        let disposed = false;

        readSettings()
            .then((loaded) => {
                if (!disposed) {
                    setSettings(loaded);
                }
            })
            // No Tauri backend in a plain browser tab; defaults stand.
            .catch(() => {});

        return () => {
            disposed = true;
        };
    }, []);

    const set = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
        setSettings((current) => {
            const next = {...current, [key]: value};
            persist(next).catch(() => {});
            return next;
        });
    }, []);

    return {...settings, set};
}
