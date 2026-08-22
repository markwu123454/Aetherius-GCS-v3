import {useCallback, useEffect, useState} from "react";
import {FsEntry, listSdcardDir} from "./sdcardFiles.ts";

export interface TreeNode {
    expanded: boolean;
    /** `null` until the first successful load. */
    children: FsEntry[] | null;
    loading: boolean;
    error: string | null;
}

export interface SdCardTree {
    nodes: Map<string, TreeNode>;
    /** Expands a folder, fetching its children on first expand; collapses
     * it if already open. */
    toggle: (path: string) => void;
    /** Re-fetches a folder's children in place — call after anything that
     * changes what's in it. */
    refresh: (path: string) => void;
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * A single lazy tree rooted at whatever folder SD Card mode currently
 * points at. Page-local state rather than a module-scope store like the
 * live Scripting page's `treeStore` (see `useFileTree.ts`) — there's no
 * "already populated before the page opens" requirement here, and the root
 * itself can change out from under it (a fresh `chooseFolder()` pick),
 * which just means starting over rather than reconciling in place.
 */
export function useSdCardTree(folder: string | null): SdCardTree {
    const [nodes, setNodes] = useState<Map<string, TreeNode>>(new Map());

    const load = useCallback(
        async (path: string) => {
            if (!folder) return;
            setNodes((prev) => new Map(prev).set(path, {expanded: true, children: prev.get(path)?.children ?? null, loading: true, error: null}));
            try {
                const children = await listSdcardDir(folder, path);
                children.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
                setNodes((prev) => new Map(prev).set(path, {expanded: true, children, loading: false, error: null}));
            } catch (err) {
                setNodes((prev) => new Map(prev).set(path, {expanded: true, children: null, loading: false, error: message(err)}));
            }
        },
        [folder],
    );

    // A new folder starts the tree over rather than trying to reconcile —
    // whatever was expanded belonged to the old one.
    useEffect(() => {
        setNodes(new Map());
        if (folder) void load("");
        // `load` is already keyed on `folder` in its own deps, so depending
        // on `folder` alone here still reloads the root the moment a new
        // one is picked.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [folder]);

    const toggle = (path: string) => {
        const existing = nodes.get(path);
        if (existing?.expanded) {
            setNodes((prev) => new Map(prev).set(path, {...existing, expanded: false}));
        } else if (existing?.children) {
            setNodes((prev) => new Map(prev).set(path, {...existing, expanded: true}));
        } else {
            void load(path);
        }
    };

    const refresh = (path: string) => void load(path);

    return {nodes, toggle, refresh};
}
