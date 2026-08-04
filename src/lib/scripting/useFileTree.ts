import {useSyncExternalStore} from "react";
import {createStore} from "@/lib/store.ts";
import {FsEntry, listLocalDir, listVehicleDir, Root} from "./scriptFiles.ts";
import {getVehicleScriptSync, subscribeVehicleScriptSync} from "./useVehicleScriptSync.ts";

export interface TreeNode {
    expanded: boolean;
    /** `null` until the first successful load. */
    children: FsEntry[] | null;
    loading: boolean;
    error: string | null;
}

export function nodeKey(root: Root, path: string): string {
    return `${root}:${path}`;
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export interface FileTree {
    nodes: Map<string, TreeNode>;
    /** Expands a folder, fetching its children on first expand; collapses it
     * if already open. Both roots load their top level on their own (see
     * below), so this only ever fires for a folder someone actually opened. */
    toggle: (root: Root, path: string) => void;
    /** Re-fetches a folder's children in place — call after anything that
     * changes what's in it (create/delete/rename/move) so the tree reflects
     * the result without collapsing or losing the rest of the tree's state. */
    refresh: (root: Root, path: string) => void;
}

const treeStore = createStore<Map<string, TreeNode>>(new Map());

async function load(root: Root, path: string): Promise<void> {
    const key = nodeKey(root, path);
    treeStore.update((prev) => {
        const next = new Map(prev);
        next.set(key, {expanded: true, children: prev.get(key)?.children ?? null, loading: true, error: null});
        return next;
    });
    try {
        const children = root === "local" ? await listLocalDir(path) : await listVehicleDir(path);
        children.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
        treeStore.update((prev) => new Map(prev).set(key, {expanded: true, children, loading: false, error: null}));
    } catch (err) {
        treeStore.update((prev) => new Map(prev).set(key, {expanded: true, children: null, loading: false, error: message(err)}));
    }
}

function toggle(root: Root, path: string): void {
    const key = nodeKey(root, path);
    const existing = treeStore.getSnapshot().get(key);
    if (existing?.expanded) {
        treeStore.update((prev) => new Map(prev).set(key, {...existing, expanded: false}));
    } else if (existing?.children) {
        treeStore.update((prev) => new Map(prev).set(key, {...existing, expanded: true}));
    } else {
        void load(root, path);
    }
}

function refresh(root: Root, path: string): void {
    void load(root, path);
}

function clearVehicleNodes(): void {
    treeStore.update((prev) => {
        const next = new Map(prev);
        for (const key of next.keys()) {
            if (key.startsWith("vehicle:")) next.delete(key);
        }
        return next;
    });
}

// Local loads once at module load — it's a local disk read with nothing to
// wait on, and doesn't depend on a vehicle connection.
void load("local", "");

// Reacts to the vehicle scripts mirror's own ready/not-ready edge (see
// `useVehicleScriptSync`) rather than raw connection status — the vehicle
// side of this tree isn't safe to list until that mirror has actually
// synced. Subscribed once, at module load, so the tree is already populated
// by the time the Scripting page is opened rather than starting fresh every
// visit; vehicle nodes are dropped entirely when the mirror goes away rather
// than left showing a listing from whatever was last plugged in.
let wasReady = false;
subscribeVehicleScriptSync(() => {
    const ready = getVehicleScriptSync().ready;
    if (ready === wasReady) return;
    wasReady = ready;
    if (ready) {
        void load("vehicle", "");
    } else {
        clearVehicleNodes();
    }
});

/**
 * Two independent lazy trees sharing one node map, keyed by `root:path` — a
 * persistent module-scope store (see `store.ts`) rather than per-component
 * state, so the tree is already populated whether or not the Scripting page
 * happened to be open when the vehicle connected.
 */
export function useFileTree(): FileTree {
    const nodes = useSyncExternalStore(treeStore.subscribe, treeStore.getSnapshot);
    return {nodes, toggle, refresh};
}
