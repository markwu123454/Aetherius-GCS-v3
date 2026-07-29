import {useEffect} from "react";
import {DisplayMode} from "./settings";
import {applyDisplayMode} from "./applyDisplayMode";

/**
 * Keeps the actual OS window in sync with the persisted preference — once on
 * mount, so a saved choice takes effect at launch rather than only after the
 * operator revisits Settings, and again on every change after that.
 */
export function useApplyDisplayMode(mode: DisplayMode): void {
    useEffect(() => {
        applyDisplayMode(mode).catch(() => {
            // No Tauri window API in a plain browser tab; nothing to apply.
        });
    }, [mode]);
}
