import {useEffect} from "react";
import {setCollapseThreshold} from "@/lib/console/consoleStore.ts";

/**
 * Keeps the console store's collapse threshold in sync with the persisted
 * preference. The store is module-level, not React state — mounted before
 * `useSettings()` has necessarily finished loading, and read by lines coming
 * from outside the component tree — so the setting has to be pushed into it
 * rather than read out of it directly.
 */
export function useApplyConsoleSettings(collapseThreshold: number): void {
    useEffect(() => {
        setCollapseThreshold(collapseThreshold);
    }, [collapseThreshold]);
}
