import {useCallback, useEffect, useState} from "react";
import {FsEntry, listLocalDir, listVehicleDir, Root} from "./scriptFiles.ts";

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

/**
 * Two independent lazy trees sharing one node map, keyed by `root:path`.
 * Local loads eagerly — it's a local disk read, nothing to wait on. Vehicle
 * only loads once connected, and is dropped entirely on disconnect rather
 * than left showing a listing from whatever was last plugged in.
 */
export function useFileTree(vehicleConnected: boolean): FileTree {
    const [nodes, setNodes] = useState<Map<string, TreeNode>>(new Map());

    const load = useCallback(async (root: Root, path: string) => {
        const key = nodeKey(root, path);
        setNodes((prev) => {
            const next = new Map(prev);
            next.set(key, {expanded: true, children: prev.get(key)?.children ?? null, loading: true, error: null});
            return next;
        });
        try {
            const children = root === "local" ? await listLocalDir(path) : await listVehicleDir(path);
            children.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
            setNodes((prev) => new Map(prev).set(key, {expanded: true, children, loading: false, error: null}));
        } catch (err) {
            setNodes((prev) => new Map(prev).set(key, {expanded: true, children: null, loading: false, error: message(err)}));
        }
    }, []);

    const toggle = useCallback(
        (root: Root, path: string) => {
            const key = nodeKey(root, path);
            const existing = nodes.get(key);
            if (existing?.expanded) {
                setNodes((prev) => new Map(prev).set(key, {...existing, expanded: false}));
            } else if (existing?.children) {
                setNodes((prev) => new Map(prev).set(key, {...existing, expanded: true}));
            } else {
                void load(root, path);
            }
        },
        [nodes, load],
    );

    const refresh = useCallback((root: Root, path: string) => void load(root, path), [load]);

    useEffect(() => {
        void load("local", "");
    }, [load]);

    useEffect(() => {
        if (vehicleConnected) {
            void load("vehicle", "");
            return;
        }
        setNodes((prev) => {
            const next = new Map(prev);
            for (const key of next.keys()) {
                if (key.startsWith("vehicle:")) next.delete(key);
            }
            return next;
        });
    }, [vehicleConnected, load]);

    return {nodes, toggle, refresh};
}
