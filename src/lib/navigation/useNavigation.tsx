import {createContext, ReactNode, useContext} from "react";
import {PageId} from "./navigation.ts";

export interface NavigationApi {
    /** Opens a panel by id — docks it at its remembered spot, or floats fresh. */
    openPanel: (id: string) => void;
    closePanel: (id: string) => void;
    /** Swaps the workspace for a full-screen page. */
    openPage: (id: PageId) => void;
    /** Returns to the workspace. */
    closePage: () => void;
}

const NavigationContext = createContext<NavigationApi | null>(null);

export function NavigationProvider({value, children}: {value: NavigationApi; children: ReactNode}) {
    return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

/**
 * Reachable from anywhere in the tree — a panel's own content, a page's own
 * content, the top bar — so opening one thing from deep inside another never
 * needs threading through every component in between. The low-level docking
 * mechanics (dock/float/resize/activate) are deliberately not exposed here;
 * those stay internal to `Workspace`'s own drag-and-drop handling.
 */
export function useNavigation(): NavigationApi {
    const value = useContext(NavigationContext);
    if (!value) {
        throw new Error("useNavigation() called outside a NavigationProvider");
    }
    return value;
}
