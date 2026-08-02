import {useRef, useState} from "react";
import {startDrag} from "@crabnebula/tauri-plugin-drag";
import {resolveResource} from "@tauri-apps/api/path";
import {revealItemInDir} from "@tauri-apps/plugin-opener";
import {DocumentBlank, Folder, FolderOpen, Script} from "@carbon/icons-react";
import ContextMenu, {ContextMenuPosition} from "@/components/ContextMenu.tsx";
import Modal from "@/components/Modal.tsx";
import {MenuItem} from "@/components/topmenu/AppMenu.tsx";
import {
    absoluteLocalPath,
    absoluteVehiclePath,
    createLocalDir,
    createLocalFile,
    createVehicleDir,
    createVehicleFile,
    deleteLocal,
    deleteVehicle,
    downloadFromVehicle,
    joinPath,
    parentPath,
    readLocalFile,
    readVehicleFile,
    renameLocal,
    renameVehicle,
    Root,
    uploadToVehicle,
    writeLocalFile,
    writeVehicleFile,
} from "@/lib/scripting/scriptFiles.ts";
import {FileTree as FileTreeState, nodeKey, TreeNode} from "@/lib/scripting/useFileTree.ts";
import {OpenFile} from "@/lib/scripting/useOpenScripts.ts";

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Resolved once and reused — every dragged-out file shows the same generic
 * app icon, there's no per-file preview. */
let dragIcon: Promise<string> | null = null;
function resolveDragIcon(): Promise<string> {
    if (!dragIcon) dragIcon = resolveResource("icons/32x32.png");
    return dragIcon;
}

/** Extension → icon for a file row. Folder rows get `Folder`/`FolderOpen`
 * directly in `Row`, keyed off expand state rather than a name. */
function fileIcon(name: string) {
    const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    if (ext === "lua") return Script;
    return DocumentBlank;
}

/** "name.ext" -> "name copy.ext", incrementing ("name copy 2.ext", ...)
 * until a free name is found in `dir`. */
function nextDuplicateName(tree: FileTreeState, root: Root, dir: string, name: string): string {
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let candidate = `${base} copy${ext}`;
    for (let n = 2; hasCollision(tree, root, dir, candidate); n++) {
        candidate = `${base} copy ${n}${ext}`;
    }
    return candidate;
}

interface DragItem {
    root: Root;
    path: string;
    name: string;
    isDir: boolean;
}

interface InlineInputProps {
    initial: string;
    onSubmit: (name: string) => void;
    onCancel: () => void;
    /** Selects only the text before the last "." on focus, leaving the
     * extension untouched — matches how OS file explorers handle renaming a
     * file, so typing immediately doesn't clobber ".lua" by accident. */
    selectBaseName?: boolean;
}

function InlineInput({initial, onSubmit, onCancel, selectBaseName}: InlineInputProps) {
    const [value, setValue] = useState(initial);
    return (
        <input
            autoFocus
            type="text"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onFocus={(event) => {
                const dot = initial.lastIndexOf(".");
                if (selectBaseName && dot > 0) event.target.setSelectionRange(0, dot);
                else event.target.select();
            }}
            onClick={(event) => event.stopPropagation()}
            onBlur={() => (value.trim() ? onSubmit(value.trim()) : onCancel())}
            onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                    event.preventDefault();
                    if (value.trim()) onSubmit(value.trim());
                    else onCancel();
                } else if (event.key === "Escape") {
                    onCancel();
                }
            }}
            className="h-6 w-full border border-border-strong bg-background px-1 font-mono text-label text-text-primary focus-visible:outline-none"
        />
    );
}

/** Blocked if the name is already in `dir`'s (already-loaded) children, or
 * if that folder hasn't been loaded yet — a drop has to land somewhere its
 * contents are actually known, not somewhere still collapsed. */
function hasCollision(tree: FileTreeState, root: Root, dir: string, name: string): boolean {
    return collisionKind(tree, root, dir, name) !== "none";
}

/** What (if anything) already sits at `dir/name` — `"unknown"` when that
 * folder hasn't loaded yet. Distinguishing file/dir matters because an
 * overwrite is only ever offered for a colliding *file*: overwriting a
 * folder would mean silently discarding whatever's inside it, which stays a
 * hard block regardless. */
function collisionKind(tree: FileTreeState, root: Root, dir: string, name: string): "none" | "file" | "dir" | "unknown" {
    const node = tree.nodes.get(nodeKey(root, dir));
    if (!node?.children) return "unknown";
    const existing = node.children.find((entry) => entry.name === name);
    if (!existing) return "none";
    return existing.isDir ? "dir" : "file";
}

/** Structural validity only — a folder can't become its own child, and
 * dropping something back where it already is is a no-op. Name collisions
 * are handled separately, at drop time (see `collisionKind`), since a
 * colliding target is still a *valid* place to drop — it just needs the
 * user to confirm an overwrite rather than being refused outright. */
function canAcceptDrop(dragging: DragItem, destRoot: Root, destDir: string): boolean {
    if (dragging.isDir && dragging.root === destRoot) {
        if (destDir === dragging.path || destDir.startsWith(`${dragging.path}/`)) return false;
    }
    if (dragging.root === destRoot && parentPath(dragging.path) === destDir) return false;
    return true;
}

type CreateKind = "file" | "folder" | "lua";

interface RowCtx {
    tree: FileTreeState;
    selected: OpenFile | null;
    dirtyPaths: Set<string>;
    dragging: DragItem | null;
    dragOverKey: string | null;
    setDragging: (item: DragItem | null) => void;
    setDragOverKey: (key: string | null) => void;
    /** Clears the drop-target highlight after a short delay rather than
     * immediately — the native-drag hover translation (see `onDragStart`)
     * can deliver a stray `dragleave` right before the `dragenter` that
     * should have followed it, and clearing on the spot would make the
     * highlight flicker off exactly when it should still be showing. */
    scheduleDragOverKeyClear: (key: string) => void;
    onOpenFile: (root: Root, path: string) => void;
    startCreating: (root: Root, dir: string, kind: CreateKind) => void;
    startRenaming: (root: Root, path: string, isDir: boolean) => void;
    handleDrop: (destRoot: Root, destDir: string) => void;
    handleOsDrop: (destRoot: Root, destDir: string, files: FileList) => void;
    /** Set right before a row starts an OS-native drag-out, so a drop that
     * lands back on our own tree (an internal move, rather than a drop onto
     * Explorer) can be told apart from a real Explorer import and finished
     * as a move instead of a copy. Backed by a plain ref, not state — the
     * browser's own dragstart/dragend cycle for that gesture gets cancelled
     * immediately (see `onDragStart` below), so it can't be used to time
     * when the native drag actually lands. */
    setLastNativeDrag: (item: DragItem | null) => void;
    handleDuplicate: (root: Root, path: string) => void;
    openMenu: (position: ContextMenuPosition, items: MenuItem[]) => void;
    creating: {root: Root; dir: string; kind: CreateKind} | null;
    renaming: {root: Root; path: string; isDir: boolean} | null;
    startDeleteConfirm: (root: Root, path: string, isDir: boolean) => void;
    submitCreate: (name: string) => void;
    cancelCreate: () => void;
    submitRename: (name: string) => void;
    cancelRename: () => void;
}

interface RowProps {
    ctx: RowCtx;
    root: Root;
    path: string;
    name: string;
    isDir: boolean;
    depth: number;
    isRoot?: boolean;
}

function Row({ctx, root, path, name, isDir, depth, isRoot}: RowProps) {
    const key = nodeKey(root, path);
    const node = ctx.tree.nodes.get(key);
    const expanded = isDir && (node?.expanded ?? false);
    const isSelected = !isDir && ctx.selected?.root === root && ctx.selected.path === path;
    const isDirty = !isDir && ctx.dirtyPaths.has(nodeKey(root, path));
    const isRenaming = ctx.renaming?.root === root && ctx.renaming.path === path;
    const isDropTarget = ctx.dragOverKey === key;
    // A drop landing on a file means "next to this file" — its parent is
    // the real destination, same as it would be for a folder row.
    const dropDestDir = isDir ? path : parentPath(path);
    const paddingLeft = `${depth * 14 + 8}px`;
    const FileIcon = isDir ? null : fileIcon(name);
    const DirIcon = isDir ? (expanded ? FolderOpen : Folder) : null;
    const resolveAbsolutePath = root === "local" ? absoluteLocalPath : absoluteVehiclePath;
    // "New ..." creates as a sibling of whatever was right-clicked, whether
    // that's a folder (create inside it) or a file (create next to it).
    const newTargetDir = isDir ? path : parentPath(path);

    // Copy Path / Reveal only make sense for a real entry, not the synthetic
    // "/local" or "/vehicle" root row — and for `/vehicle`, "reveal" opens
    // the local mirror cache copy, not anything on the aircraft itself.
    const pathMenuItems: MenuItem[] = isRoot
        ? []
        : [
              {
                  label: "Copy Relative Path",
                  action: () => void navigator.clipboard?.writeText(path),
                  separatorBefore: true,
              },
              {
                  label: "Copy Absolute Path",
                  action: () => void resolveAbsolutePath(path).then((abs) => navigator.clipboard?.writeText(abs)),
              },
              {
                  label: root === "local" ? "Reveal in File Explorer" : "Reveal in File Explorer (cached copy)",
                  action: () => void resolveAbsolutePath(path).then((abs) => revealItemInDir(abs)),
              },
          ];

    const newMenuItems: MenuItem[] = [
        {label: "New File", action: () => ctx.startCreating(root, newTargetDir, "file")},
        {label: "New Folder", action: () => ctx.startCreating(root, newTargetDir, "folder")},
        {label: "New Lua Script", action: () => ctx.startCreating(root, newTargetDir, "lua")},
    ];

    const menuItems: MenuItem[] = isDir
        ? [
              ...newMenuItems,
              ...(isRoot
                  ? []
                  : [
                        {label: "Rename", action: () => ctx.startRenaming(root, path, true), separatorBefore: true},
                        {label: "Delete", action: () => ctx.startDeleteConfirm(root, path, true)},
                    ]),
              ...pathMenuItems,
          ]
        : [
              ...newMenuItems,
              {label: "Rename", action: () => ctx.startRenaming(root, path, false), separatorBefore: true},
              {label: "Delete", action: () => ctx.startDeleteConfirm(root, path, false)},
              {label: "Duplicate", action: () => ctx.handleDuplicate(root, path)},
              ...pathMenuItems,
          ];

    return (
        <div>
            <div
                role="button"
                tabIndex={0}
                aria-current={isSelected}
                draggable={!isRenaming}
                data-row-key={key}
                style={{paddingLeft}}
                onClick={() => {
                    if (isDir) ctx.tree.toggle(root, path);
                    else ctx.onOpenFile(root, path);
                }}
                onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        if (isDir) ctx.tree.toggle(root, path);
                        else ctx.onOpenFile(root, path);
                        return;
                    }
                    if (!isRoot && event.key === "F2") {
                        event.preventDefault();
                        ctx.startRenaming(root, path, isDir);
                        return;
                    }
                    if (!isRoot && event.key === "Delete") {
                        event.preventDefault();
                        ctx.startDeleteConfirm(root, path, isDir);
                        return;
                    }
                    if (isDir && event.key === "ArrowRight") {
                        event.preventDefault();
                        if (!expanded) ctx.tree.toggle(root, path);
                        return;
                    }
                    if (isDir && event.key === "ArrowLeft") {
                        event.preventDefault();
                        if (expanded) ctx.tree.toggle(root, path);
                        return;
                    }
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                        event.preventDefault();
                        const container = event.currentTarget.closest("[data-scripting-tree]");
                        const rows = Array.from(container?.querySelectorAll<HTMLElement>("[data-row-key]") ?? []);
                        const index = rows.indexOf(event.currentTarget);
                        rows[index + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
                    }
                }}
                onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    ctx.openMenu({x: event.clientX, y: event.clientY}, menuItems);
                }}
                onDragStart={(event) => {
                    event.stopPropagation();
                    // Hands off to a native OS drag instead of the browser's
                    // own — that's what lets the OS side of the drag land in
                    // Explorer or another app. It replaces the browser drag
                    // for this gesture entirely (native and HTML5 drag can't
                    // both run at once), so an internal move has to be
                    // reconstructed from the other side, in `handleOsDrop`,
                    // using `lastNativeDrag` below. Skipped for the synthetic
                    // "/local"/"/vehicle" root rows — there's no single real
                    // entry there to hand the OS.
                    if (!isRoot) {
                        event.preventDefault();
                        const item: DragItem = {root, path, name, isDir};
                        ctx.setLastNativeDrag(item);
                        void (async () => {
                            try {
                                const [absPath, icon] = await Promise.all([resolveAbsolutePath(path), resolveDragIcon()]);
                                await startDrag({item: [absPath], icon});
                            } catch {
                                // Best-effort — failing to hand off to the OS shouldn't surface as an app error.
                            }
                        })();
                        return;
                    }
                    // Firefox refuses to start a drag at all without
                    // `setData` — Chromium is more lenient, but both need
                    // `effectAllowed` set here for `dropEffect` on the target
                    // to have any effect below. Only the root rows reach
                    // this now; dragging those was never really meaningful,
                    // left as-is since nothing depends on changing it.
                    event.dataTransfer.setData("text/plain", name);
                    event.dataTransfer.effectAllowed = "copyMove";
                    ctx.setDragging({root, path, name, isDir});
                }}
                onDragEnd={() => {
                    ctx.setDragging(null);
                    ctx.setDragOverKey(null);
                }}
                onDragEnter={(event) => {
                    // A drag carrying OS files (from Explorer) reports "Files"
                    // in `types` from the first `dragenter` — `dataTransfer.files`
                    // itself stays empty everywhere except `drop`, so `types` is
                    // the only way to tell an OS drag apart from an internal one
                    // before it lands.
                    if (event.dataTransfer.types.includes("Files")) {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "copy";
                        ctx.setDragOverKey(key);
                    } else if (ctx.dragging && canAcceptDrop(ctx.dragging, root, dropDestDir)) {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = ctx.dragging.root === root ? "move" : "copy";
                        ctx.setDragOverKey(key);
                    }
                }}
                onDragOver={(event) => {
                    // `preventDefault` alone doesn't reliably clear the
                    // "no-drop" cursor — `dropEffect` has to be set on
                    // every `dragover`, not just `dragenter`, since it's
                    // read fresh each time the browser repaints the cursor.
                    if (event.dataTransfer.types.includes("Files")) {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "copy";
                    } else if (ctx.dragging && canAcceptDrop(ctx.dragging, root, dropDestDir)) {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = ctx.dragging.root === root ? "move" : "copy";
                    }
                }}
                onDragLeave={() => {
                    ctx.scheduleDragOverKeyClear(key);
                }}
                onDrop={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    ctx.setDragOverKey(null);
                    if (event.dataTransfer.files.length > 0) ctx.handleOsDrop(root, dropDestDir, event.dataTransfer.files);
                    else ctx.handleDrop(root, dropDestDir);
                }}
                className={[
                    "flex w-full cursor-pointer items-center gap-1.5 py-1 pr-3 text-left text-label whitespace-nowrap",
                    isDropTarget
                        ? "bg-layer-hover-01 outline outline-1 outline-border-strong -outline-offset-1"
                        : isSelected
                          ? "bg-background text-text-primary"
                          : "text-text-secondary hover:bg-layer-hover-01 hover:text-text-primary",
                ].join(" ")}
            >
                <span className="pointer-events-none w-3 shrink-0 text-text-helper">{isDir ? (expanded ? "▾" : "▸") : ""}</span>
                {DirIcon && <DirIcon size={16} className="pointer-events-none shrink-0 text-text-helper"/>}
                {FileIcon && <FileIcon size={16} className="pointer-events-none shrink-0 text-text-helper"/>}
                {isRenaming ? (
                    <InlineInput initial={name} onSubmit={ctx.submitRename} onCancel={ctx.cancelRename} selectBaseName={!isDir}/>
                ) : (
                    <>
                        <span className={["pointer-events-none min-w-0 flex-1 truncate", isRoot ? "" : "font-mono"].join(" ")}>{name}</span>
                        {isDirty && (
                            <span aria-hidden="true" className="pointer-events-none w-1.5 shrink-0 text-state-warn">
                                ●
                            </span>
                        )}
                    </>
                )}
            </div>

            {isDir && expanded && ctx.creating?.root === root && ctx.creating.dir === path && (
                <div style={{paddingLeft: `${(depth + 1) * 14 + 8}px`}} className="flex items-center gap-1.5 py-0.5 pr-3">
                    <span className="w-3 shrink-0"/>
                    <span className="w-4 shrink-0"/>
                    <InlineInput
                        initial={ctx.creating.kind === "folder" ? "New Folder" : ctx.creating.kind === "lua" ? "script" : "new_file.lua"}
                        onSubmit={ctx.submitCreate}
                        onCancel={ctx.cancelCreate}
                        selectBaseName={ctx.creating.kind !== "folder"}
                    />
                </div>
            )}

            {isDir && expanded && node?.loading && !node.children && (
                <div style={{paddingLeft: `${(depth + 1) * 14 + 8}px`}} className="flex items-center gap-1.5 py-1 text-label text-text-helper">
                    <span className="w-3 shrink-0"/>
                    <span className="w-4 shrink-0"/>
                    <span>Loading…</span>
                </div>
            )}
            {isDir && expanded && node?.error && (
                <div style={{paddingLeft: `${(depth + 1) * 14 + 8}px`}} className="flex items-center gap-1.5 py-1 text-label text-state-danger">
                    <span className="w-3 shrink-0"/>
                    <span className="w-4 shrink-0"/>
                    <span>{node.error}</span>
                </div>
            )}
            {isDir && expanded && node?.children?.length === 0 && !ctx.creating && (
                <div style={{paddingLeft: `${(depth + 1) * 14 + 8}px`}} className="flex items-center gap-1.5 py-1 text-label text-text-helper">
                    <span className="w-3 shrink-0"/>
                    <span className="w-4 shrink-0"/>
                    <span>Empty</span>
                </div>
            )}
            {isDir &&
                expanded &&
                node?.children?.map((entry) => (
                    <Row
                        key={entry.name}
                        ctx={ctx}
                        root={root}
                        path={joinPath(path, entry.name)}
                        name={entry.name}
                        isDir={entry.isDir}
                        depth={depth + 1}
                    />
                ))}
        </div>
    );
}

interface FileTreeProps {
    tree: FileTreeState;
    /** Safe to list/open `/vehicle` — true only once its mirror has synced,
     * not merely once the link is up (see `useVehicleScriptSync`). */
    vehicleConnected: boolean;
    vehicleSyncing: boolean;
    vehicleSyncError: string | null;
    onRetryVehicleSync: () => void;
    selected: OpenFile | null;
    dirtyPaths: Set<string>;
    onOpenFile: (root: Root, path: string) => void;
    /** Fired for a file/folder (local or vehicle) that just got deleted,
     * renamed, or moved away — lets the editor forget any model it had open
     * under that path. */
    onPathRemoved: (root: Root, path: string, isDir: boolean) => void;
}

interface MoveHistoryEntry {
    root: Root;
    from: string;
    to: string;
    isDir: boolean;
}

/**
 * Two lazy trees, `/local` and `/vehicle`, in one view. Moving a file within
 * a root is a rename; dragging across roots is a copy (upload/download) —
 * both go through the same `performMove`, which only tells them apart by
 * whether the source and destination roots match. Dragging files in from
 * outside the app (Explorer, another window) goes through `handleOsDrop`
 * instead, since the browser only hands over a name and content for those,
 * never a path to move — the one exception is a row we just handed off to a
 * native OS drag ourselves landing back on our own tree, which `handleOsDrop`
 * detects via `lastNativeDrag` and finishes through `performMove` instead, so
 * it's a real move (correct for folders too) rather than a read-and-recreate
 * copy. A name collision at the destination that collides with a *file*
 * offers to overwrite it (via `askOverwrite`'s modal); a collision with a
 * folder is always a hard block, since overwriting one could silently
 * discard everything inside it.
 */
export default function FileTree({
    tree,
    vehicleConnected,
    vehicleSyncing,
    vehicleSyncError,
    onRetryVehicleSync,
    selected,
    dirtyPaths,
    onOpenFile,
    onPathRemoved,
}: FileTreeProps) {
    const [dragging, setDragging] = useState<DragItem | null>(null);
    const [dragOverKey, setDragOverKey] = useState<string | null>(null);
    const [menu, setMenu] = useState<(ContextMenuPosition & {items: MenuItem[]}) | null>(null);
    const [creating, setCreating] = useState<{root: Root; dir: string; kind: CreateKind} | null>(null);
    const [renaming, setRenaming] = useState<{root: Root; path: string; isDir: boolean} | null>(null);
    const [confirmingDelete, setConfirmingDelete] = useState<{root: Root; path: string; isDir: boolean} | null>(null);
    const [confirmingOverwrite, setConfirmingOverwrite] = useState<{root: Root; path: string} | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const lastNativeDragRef = useRef<DragItem | null>(null);
    const overwriteResolverRef = useRef<((confirmed: boolean) => void) | null>(null);
    const undoStack = useRef<MoveHistoryEntry[]>([]);
    const redoStack = useRef<MoveHistoryEntry[]>([]);
    const dragLeaveTimer = useRef<number | null>(null);

    const openMenu = (position: ContextMenuPosition, items: MenuItem[]) => setMenu({...position, items});

    const setDragOverKeyImmediate = (key: string | null) => {
        if (dragLeaveTimer.current !== null) {
            window.clearTimeout(dragLeaveTimer.current);
            dragLeaveTimer.current = null;
        }
        setDragOverKey(key);
    };

    const scheduleDragOverKeyClear = (key: string) => {
        if (dragLeaveTimer.current !== null) window.clearTimeout(dragLeaveTimer.current);
        dragLeaveTimer.current = window.setTimeout(() => {
            dragLeaveTimer.current = null;
            setDragOverKey((current) => (current === key ? null : current));
        }, 60);
    };

    const askOverwrite = (root: Root, path: string): Promise<boolean> =>
        new Promise((resolve) => {
            overwriteResolverRef.current = resolve;
            setConfirmingOverwrite({root, path});
        });

    const resolveOverwrite = (confirmed: boolean) => {
        setConfirmingOverwrite(null);
        overwriteResolverRef.current?.(confirmed);
        overwriteResolverRef.current = null;
    };

    const submitCreate = async (name: string) => {
        if (!creating) return;
        const {root, dir, kind} = creating;
        setCreating(null);
        const finalName = kind === "lua" && !name.toLowerCase().endsWith(".lua") ? `${name}.lua` : name;
        try {
            const path = joinPath(dir, finalName);
            if (root === "local") {
                if (kind === "folder") await createLocalDir(path);
                else await createLocalFile(path);
            } else if (kind === "folder") {
                await createVehicleDir(path);
            } else {
                await createVehicleFile(path);
            }
            if (kind !== "folder") onOpenFile(root, path);
            tree.refresh(root, dir);
        } catch (err) {
            setActionError(message(err));
        }
    };

    /** The one place a same-root rename actually happens — a typed rename
     * and a drag-drop move both funnel through this, so both get undo/redo
     * for free and neither can drift from the other's bookkeeping. */
    const performRename = async (root: Root, from: string, to: string, isDir: boolean, overwrite: boolean, recordHistory: boolean) => {
        const rename = root === "local" ? renameLocal : renameVehicle;
        await rename(from, to, overwrite);
        onPathRemoved(root, from, isDir);
        tree.refresh(root, parentPath(from));
        tree.refresh(root, parentPath(to));
        if (recordHistory) {
            undoStack.current.push({root, from, to, isDir});
            redoStack.current = [];
        }
    };

    const submitRename = async (name: string) => {
        if (!renaming) return;
        const {root, path, isDir} = renaming;
        setRenaming(null);
        const dir = parentPath(path);
        const newPath = joinPath(dir, name);
        if (newPath === path) return;
        const collision = collisionKind(tree, root, dir, name);
        try {
            if (collision === "none") {
                await performRename(root, path, newPath, isDir, false, true);
            } else if (collision === "file") {
                if (!(await askOverwrite(root, newPath))) return;
                await performRename(root, path, newPath, isDir, true, true);
            } else {
                setActionError(`"${name}" already exists there`);
            }
        } catch (err) {
            setActionError(message(err));
        }
    };

    const handleDelete = async (root: Root, path: string, isDir: boolean) => {
        try {
            if (root === "local") await deleteLocal(path);
            else await deleteVehicle(path, isDir);
            onPathRemoved(root, path, isDir);
            tree.refresh(root, parentPath(path));
        } catch (err) {
            setActionError(message(err));
        }
    };

    const startDeleteConfirm = (root: Root, path: string, isDir: boolean) => setConfirmingDelete({root, path, isDir});
    const cancelDeleteConfirm = () => setConfirmingDelete(null);
    const confirmDelete = async () => {
        if (!confirmingDelete) return;
        const {root, path, isDir} = confirmingDelete;
        setConfirmingDelete(null);
        await handleDelete(root, path, isDir);
    };

    const handleDuplicate = async (root: Root, path: string) => {
        const dir = parentPath(path);
        const name = path.slice(path.lastIndexOf("/") + 1);
        const newPath = joinPath(dir, nextDuplicateName(tree, root, dir, name));
        try {
            const content = root === "local" ? await readLocalFile(path) : await readVehicleFile(path);
            if (root === "local") {
                await createLocalFile(newPath);
                await writeLocalFile(newPath, content);
            } else {
                await createVehicleFile(newPath);
                await writeVehicleFile(newPath, content);
            }
            tree.refresh(root, dir);
            setRenaming({root, path: newPath, isDir: false});
        } catch (err) {
            setActionError(message(err));
        }
    };

    /** Shared by an internal drag-drop reorder and a native OS drag we
     * started ourselves landing back on our own tree (see `handleOsDrop`) —
     * both are "move this item to `destDir`", they just differ in whether
     * the source root matches the destination (a rename, going through
     * `performRename`) or not (an upload/download, which is always a copy —
     * the source is left in place). */
    const performMove = async (item: DragItem, destRoot: Root, destDir: string) => {
        if (!canAcceptDrop(item, destRoot, destDir)) return;
        const newPath = joinPath(destDir, item.name);
        const collision = collisionKind(tree, destRoot, destDir, item.name);
        if (collision === "dir") {
            setActionError(`"${item.name}" already exists there`);
            return;
        }
        let overwrite = false;
        if (collision === "file") {
            if (!(await askOverwrite(destRoot, newPath))) return;
            overwrite = true;
        }

        try {
            if (item.root === destRoot) {
                await performRename(destRoot, item.path, newPath, item.isDir, overwrite, true);
            } else if (item.root === "local") {
                await uploadToVehicle(item.path, newPath);
                tree.refresh("vehicle", destDir);
            } else {
                await downloadFromVehicle(item.path, newPath, overwrite);
                tree.refresh("local", destDir);
            }
        } catch (err) {
            setActionError(message(err));
        }
    };

    const handleDrop = async (destRoot: Root, destDir: string) => {
        if (!dragging) return;
        const item = dragging;
        setDragging(null);
        await performMove(item, destRoot, destDir);
    };

    /** Files dropped in from outside the app (Explorer, another window) — the
     * browser only ever hands over their name and content, never a path to
     * move, so each one is read and re-created (or, on a confirmed overwrite,
     * just rewritten) rather than moved. The one exception is a row we just
     * handed off to a native OS drag ourselves (see `onDragStart`): if that
     * lands back on our own tree instead of on Explorer, `lastNativeDrag` is
     * matched against the dropped names first and, on a match, finished
     * through `performMove` — a real rename, correct for folders too, rather
     * than a read-and-recreate that would silently turn a dragged-back
     * folder into an empty file. */
    const handleOsDrop = async (destRoot: Root, destDir: string, files: FileList) => {
        const movedFrom = lastNativeDragRef.current;
        lastNativeDragRef.current = null;
        const fileList = Array.from(files);

        if (movedFrom && fileList.some((file) => file.name === movedFrom.name)) {
            await performMove(movedFrom, destRoot, destDir);
            return;
        }

        for (const file of fileList) {
            const path = joinPath(destDir, file.name);
            const collision = collisionKind(tree, destRoot, destDir, file.name);
            if (collision === "dir") {
                setActionError(`"${file.name}" already exists there`);
                continue;
            }
            if (collision === "file" && !(await askOverwrite(destRoot, path))) {
                continue;
            }
            try {
                const content = await file.text();
                if (collision === "none") {
                    if (destRoot === "local") await createLocalFile(path);
                    else await createVehicleFile(path);
                }
                if (destRoot === "local") await writeLocalFile(path, content);
                else await writeVehicleFile(path, content);
            } catch (err) {
                setActionError(message(err));
            }
        }
        tree.refresh(destRoot, destDir);
    };

    const undo = async () => {
        const entry = undoStack.current.pop();
        if (!entry) return;
        if (hasCollision(tree, entry.root, parentPath(entry.from), entry.from.slice(entry.from.lastIndexOf("/") + 1))) {
            setActionError("Can't undo — something's already there");
            return;
        }
        try {
            await performRename(entry.root, entry.to, entry.from, entry.isDir, false, false);
            redoStack.current.push(entry);
        } catch (err) {
            setActionError(message(err));
        }
    };

    const redo = async () => {
        const entry = redoStack.current.pop();
        if (!entry) return;
        if (hasCollision(tree, entry.root, parentPath(entry.to), entry.to.slice(entry.to.lastIndexOf("/") + 1))) {
            setActionError("Can't redo — something's already there");
            return;
        }
        try {
            await performRename(entry.root, entry.from, entry.to, entry.isDir, false, false);
            undoStack.current.push(entry);
        } catch (err) {
            setActionError(message(err));
        }
    };

    const ctx: RowCtx = {
        tree,
        selected,
        dirtyPaths,
        dragging,
        dragOverKey,
        setDragging,
        setDragOverKey: setDragOverKeyImmediate,
        scheduleDragOverKeyClear,
        onOpenFile,
        startCreating: (root, dir, kind) => {
            if (!tree.nodes.get(nodeKey(root, dir))?.expanded) tree.toggle(root, dir);
            setCreating({root, dir, kind});
        },
        startRenaming: (root, path, isDir) => setRenaming({root, path, isDir}),
        handleDrop,
        handleOsDrop: (destRoot, destDir, files) => void handleOsDrop(destRoot, destDir, files),
        setLastNativeDrag: (item) => {
            lastNativeDragRef.current = item;
        },
        handleDuplicate: (root, path) => void handleDuplicate(root, path),
        openMenu,
        creating,
        renaming,
        startDeleteConfirm,
        submitCreate: (name) => void submitCreate(name),
        cancelCreate: () => setCreating(null),
        submitRename: (name) => void submitRename(name),
        cancelRename: () => setRenaming(null),
    };

    const vehicleNode: TreeNode | undefined = tree.nodes.get(nodeKey("vehicle", ""));

    return (
        <>
            <div
                data-scripting-tree
                className="flex h-full w-64 shrink-0 flex-col overflow-auto border-r border-border-subtle bg-layer-01"
                onContextMenu={(event) => event.preventDefault()}
                onKeyDown={(event) => {
                    const mod = event.ctrlKey || event.metaKey;
                    if (!mod) return;
                    if (event.key.toLowerCase() === "z") {
                        event.preventDefault();
                        if (event.shiftKey) void redo();
                        else void undo();
                    } else if (event.key.toLowerCase() === "y") {
                        event.preventDefault();
                        void redo();
                    }
                }}
            >
                <Row ctx={ctx} root="local" path="" name="local" isDir depth={0} isRoot/>
                {vehicleConnected ? (
                    <Row ctx={ctx} root="vehicle" path="" name="vehicle" isDir depth={0} isRoot/>
                ) : (
                    <div>
                        <div style={{paddingLeft: "8px"}} className="mt-2 flex w-full items-center gap-1.5 border-t border-border-subtle py-1 pr-3 text-label text-text-secondary">
                            <span className="w-3 shrink-0 text-text-helper">▾</span>
                            <FolderOpen size={16} className="shrink-0 text-text-helper"/>
                            <span className="min-w-0 flex-1 truncate">vehicle</span>
                        </div>
                        <div style={{paddingLeft: "22px"}} className="flex items-center gap-1.5 py-1 pr-3 text-label">
                            <span className="w-3 shrink-0"/>
                            <span className="w-4 shrink-0"/>
                            {vehicleSyncing ? (
                                <span className="text-text-helper">Loading…</span>
                            ) : vehicleSyncError ? (
                                <span className="text-state-danger">
                                    {vehicleSyncError}{" "}
                                    <button type="button" onClick={onRetryVehicleSync} className="text-state-info underline">
                                        Retry
                                    </button>
                                </span>
                            ) : (
                                <span className="text-text-helper">Not connected</span>
                            )}
                        </div>
                    </div>
                )}
                {vehicleConnected && vehicleNode?.error && (
                    <div className="px-2 py-1 text-label text-state-danger">{vehicleNode.error}</div>
                )}
                {actionError && (
                    <div className="border-t border-border-subtle px-2 py-1 text-label text-state-danger">{actionError}</div>
                )}
                {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)}/>}
            </div>

            {confirmingDelete && (
                <Modal title="Delete?" onClose={cancelDeleteConfirm}>
                    <p className="mb-4 text-label text-text-secondary">
                        Delete <span className="font-mono text-text-primary">{confirmingDelete.path}</span>
                        {confirmingDelete.isDir ? " and everything inside it" : ""}? This can't be undone.
                    </p>
                    <div className="flex justify-end gap-2">
                        <button
                            type="button"
                            onClick={cancelDeleteConfirm}
                            className="h-control-sm bg-layer-02 px-4 text-label text-text-primary hover:bg-layer-hover-02"
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={() => void confirmDelete()}
                            className="h-control-sm bg-red-60 px-4 text-label text-text-on-color hover:opacity-90"
                        >
                            Delete
                        </button>
                    </div>
                </Modal>
            )}

            {confirmingOverwrite && (
                <Modal title="Replace existing file?" onClose={() => resolveOverwrite(false)}>
                    <p className="mb-4 text-label text-text-secondary">
                        <span className="font-mono text-text-primary">{confirmingOverwrite.path}</span> already exists. Overwriting it can't
                        be undone.
                    </p>
                    <div className="flex justify-end gap-2">
                        <button
                            type="button"
                            onClick={() => resolveOverwrite(false)}
                            className="h-control-sm bg-layer-02 px-4 text-label text-text-primary hover:bg-layer-hover-02"
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={() => resolveOverwrite(true)}
                            className="h-control-sm bg-red-60 px-4 text-label text-text-on-color hover:opacity-90"
                        >
                            Overwrite
                        </button>
                    </div>
                </Modal>
            )}
        </>
    );
}
