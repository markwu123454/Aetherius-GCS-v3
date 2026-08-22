import {useState} from "react";
import {revealItemInDir} from "@tauri-apps/plugin-opener";
import {DocumentBlank, Folder, FolderOpen, Script} from "@carbon/icons-react";
import ContextMenu, {ContextMenuPosition} from "@/components/ContextMenu.tsx";
import Modal from "@/components/Modal.tsx";
import {MenuItem} from "@/components/topmenu/AppMenu.tsx";
import {
    createSdcardDir,
    createSdcardFile,
    deleteSdcard,
    joinPath,
    parentPath,
    readSdcardFile,
    renameSdcard,
    writeSdcardFile,
} from "@/lib/sdcard/sdcardFiles.ts";
import {SdCardTree} from "@/lib/sdcard/useSdCardTree.ts";

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** The chosen folder is a native OS path (backslash on Windows); relative
 * tree paths are always forward-slash. Joined here rather than by a Rust
 * round-trip, since it's only needed for clipboard/reveal actions, not
 * anything that touches the filesystem itself. */
function absolutePath(folder: string, relative: string): string {
    if (!relative) return folder;
    const sep = folder.includes("\\") ? "\\" : "/";
    return folder + sep + relative.split("/").join(sep);
}

function fileIcon(name: string) {
    const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    if (ext === "lua") return Script;
    return DocumentBlank;
}

/** "name.ext" -> "name copy.ext", incrementing until a free name is found
 * in `dir`. Same scheme as the live Scripting page's `FileTree.tsx`. */
function nextDuplicateName(tree: SdCardTree, dir: string, name: string): string {
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let candidate = `${base} copy${ext}`;
    for (let n = 2; hasCollision(tree, dir, candidate); n++) {
        candidate = `${base} copy ${n}${ext}`;
    }
    return candidate;
}

function collisionKind(tree: SdCardTree, dir: string, name: string): "none" | "file" | "dir" | "unknown" {
    const node = tree.nodes.get(dir);
    if (!node?.children) return "unknown";
    const existing = node.children.find((entry) => entry.name === name);
    if (!existing) return "none";
    return existing.isDir ? "dir" : "file";
}

function hasCollision(tree: SdCardTree, dir: string, name: string): boolean {
    return collisionKind(tree, dir, name) !== "none";
}

interface InlineInputProps {
    initial: string;
    onSubmit: (name: string) => void;
    onCancel: () => void;
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

type CreateKind = "file" | "folder" | "lua";

interface RowCtx {
    folder: string;
    tree: SdCardTree;
    selectedPath: string | null;
    dirty: boolean;
    onOpenFile: (path: string) => void;
    startCreating: (dir: string, kind: CreateKind) => void;
    startRenaming: (path: string, isDir: boolean) => void;
    handleDuplicate: (path: string) => void;
    openMenu: (position: ContextMenuPosition, items: MenuItem[]) => void;
    creating: {dir: string; kind: CreateKind} | null;
    renaming: {path: string; isDir: boolean} | null;
    startDeleteConfirm: (path: string, isDir: boolean) => void;
    submitCreate: (name: string) => void;
    cancelCreate: () => void;
    submitRename: (name: string) => void;
    cancelRename: () => void;
}

interface RowProps {
    ctx: RowCtx;
    path: string;
    name: string;
    isDir: boolean;
    depth: number;
    isRoot?: boolean;
}

function Row({ctx, path, name, isDir, depth, isRoot}: RowProps) {
    const node = ctx.tree.nodes.get(path);
    const expanded = isDir && (node?.expanded ?? false);
    const isSelected = !isDir && ctx.selectedPath === path;
    const isDirty = isSelected && ctx.dirty;
    const isRenaming = ctx.renaming?.path === path;
    const paddingLeft = `${depth * 14 + 8}px`;
    const FileIcon = isDir ? null : fileIcon(name);
    const DirIcon = isDir ? (expanded ? FolderOpen : Folder) : null;
    const newTargetDir = isDir ? path : parentPath(path);

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
                  action: () => void navigator.clipboard?.writeText(absolutePath(ctx.folder, path)),
              },
              {
                  label: "Reveal in File Explorer",
                  action: () => void revealItemInDir(absolutePath(ctx.folder, path)),
              },
          ];

    const newMenuItems: MenuItem[] = [
        {label: "New File", action: () => ctx.startCreating(newTargetDir, "file")},
        {label: "New Folder", action: () => ctx.startCreating(newTargetDir, "folder")},
        {label: "New Lua Script", action: () => ctx.startCreating(newTargetDir, "lua")},
    ];

    const menuItems: MenuItem[] = isDir
        ? [
              ...newMenuItems,
              ...(isRoot
                  ? []
                  : [
                        {label: "Rename", action: () => ctx.startRenaming(path, true), separatorBefore: true},
                        {label: "Delete", action: () => ctx.startDeleteConfirm(path, true)},
                    ]),
              ...pathMenuItems,
          ]
        : [
              ...newMenuItems,
              {label: "Rename", action: () => ctx.startRenaming(path, false), separatorBefore: true},
              {label: "Delete", action: () => ctx.startDeleteConfirm(path, false)},
              {label: "Duplicate", action: () => ctx.handleDuplicate(path)},
              ...pathMenuItems,
          ];

    return (
        <div>
            <div
                role="button"
                tabIndex={0}
                aria-current={isSelected}
                style={{paddingLeft}}
                onClick={() => {
                    if (isDir) ctx.tree.toggle(path);
                    else ctx.onOpenFile(path);
                }}
                onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        if (isDir) ctx.tree.toggle(path);
                        else ctx.onOpenFile(path);
                        return;
                    }
                    if (!isRoot && event.key === "F2") {
                        event.preventDefault();
                        ctx.startRenaming(path, isDir);
                        return;
                    }
                    if (!isRoot && event.key === "Delete") {
                        event.preventDefault();
                        ctx.startDeleteConfirm(path, isDir);
                    }
                }}
                onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    ctx.openMenu({x: event.clientX, y: event.clientY}, menuItems);
                }}
                className={[
                    "flex w-full cursor-pointer items-center gap-1.5 py-1 pr-3 text-left text-label whitespace-nowrap",
                    isSelected
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

            {isDir && expanded && ctx.creating?.dir === path && (
                <div style={{paddingLeft: `${(depth + 1) * 14 + 8}px`}} className="flex items-center gap-1.5 py-0.5 pr-3">
                    <span className="w-3 shrink-0"/>
                    <span className="w-4 shrink-0"/>
                    <InlineInput
                        initial={ctx.creating.kind === "folder" ? "New Folder" : ctx.creating.kind === "lua" ? "script.lua" : "new_file.txt"}
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
                    <Row key={entry.name} ctx={ctx} path={joinPath(path, entry.name)} name={entry.name} isDir={entry.isDir} depth={depth + 1}/>
                ))}
        </div>
    );
}

interface SdCardFileTreeProps {
    folder: string;
    tree: SdCardTree;
    selectedPath: string | null;
    dirty: boolean;
    onOpenFile: (path: string) => void;
    /** Fired for a file/folder that just got deleted or renamed — lets the
     * editor forget any content it had open under that path. */
    onPathRemoved: (path: string, isDir: boolean) => void;
}

/**
 * A single tree rooted at the chosen SD card folder — the same visual
 * language as the live Scripting page's `FileTree.tsx` (icons, inline
 * rename/create, right-click menu), trimmed to one root and no
 * drag-and-drop: there's nothing to drag a script to or from here, just
 * one folder to browse, create in, rename, and delete within.
 */
export default function SdCardFileTree({folder, tree, selectedPath, dirty, onOpenFile, onPathRemoved}: SdCardFileTreeProps) {
    const [menu, setMenu] = useState<(ContextMenuPosition & {items: MenuItem[]}) | null>(null);
    const [creating, setCreating] = useState<{dir: string; kind: CreateKind} | null>(null);
    const [renaming, setRenaming] = useState<{path: string; isDir: boolean} | null>(null);
    const [confirmingDelete, setConfirmingDelete] = useState<{path: string; isDir: boolean} | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);

    const openMenu = (position: ContextMenuPosition, items: MenuItem[]) => setMenu({...position, items});

    const submitCreate = async (name: string) => {
        if (!creating) return;
        const {dir, kind} = creating;
        setCreating(null);
        const finalName = kind === "lua" && !name.toLowerCase().endsWith(".lua") ? `${name}.lua` : name;
        try {
            const path = joinPath(dir, finalName);
            if (kind === "folder") await createSdcardDir(folder, path);
            else await createSdcardFile(folder, path);
            if (kind !== "folder") onOpenFile(path);
            tree.refresh(dir);
        } catch (err) {
            setActionError(message(err));
        }
    };

    const submitRename = async (name: string) => {
        if (!renaming) return;
        const {path, isDir} = renaming;
        setRenaming(null);
        const dir = parentPath(path);
        const newPath = joinPath(dir, name);
        if (newPath === path) return;
        if (hasCollision(tree, dir, name)) {
            setActionError(`"${name}" already exists there`);
            return;
        }
        try {
            await renameSdcard(folder, path, newPath);
            onPathRemoved(path, isDir);
            tree.refresh(dir);
        } catch (err) {
            setActionError(message(err));
        }
    };

    const confirmDelete = async () => {
        if (!confirmingDelete) return;
        const {path, isDir} = confirmingDelete;
        setConfirmingDelete(null);
        try {
            await deleteSdcard(folder, path);
            onPathRemoved(path, isDir);
            tree.refresh(parentPath(path));
        } catch (err) {
            setActionError(message(err));
        }
    };

    const handleDuplicate = async (path: string) => {
        const dir = parentPath(path);
        const name = path.slice(path.lastIndexOf("/") + 1);
        const newPath = joinPath(dir, nextDuplicateName(tree, dir, name));
        try {
            const content = await readSdcardFile(folder, path);
            await createSdcardFile(folder, newPath);
            await writeSdcardFile(folder, newPath, content);
            tree.refresh(dir);
            setRenaming({path: newPath, isDir: false});
        } catch (err) {
            setActionError(message(err));
        }
    };

    const ctx: RowCtx = {
        folder,
        tree,
        selectedPath,
        dirty,
        onOpenFile,
        startCreating: (dir, kind) => {
            if (!tree.nodes.get(dir)?.expanded) tree.toggle(dir);
            setCreating({dir, kind});
        },
        startRenaming: (path, isDir) => setRenaming({path, isDir}),
        handleDuplicate: (path) => void handleDuplicate(path),
        openMenu,
        creating,
        renaming,
        startDeleteConfirm: (path, isDir) => setConfirmingDelete({path, isDir}),
        submitCreate: (name) => void submitCreate(name),
        cancelCreate: () => setCreating(null),
        submitRename: (name) => void submitRename(name),
        cancelRename: () => setRenaming(null),
    };

    return (
        <div
            className="flex h-full w-48 shrink-0 flex-col overflow-auto border-r border-border-subtle bg-layer-01"
            onContextMenu={(event) => event.preventDefault()}
        >
            <Row ctx={ctx} path="" name={folder} isDir depth={0} isRoot/>
            {actionError && <div className="border-t border-border-subtle px-2 py-1 text-label text-state-danger">{actionError}</div>}
            {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)}/>}

            {confirmingDelete && (
                <Modal title="Delete?" onClose={() => setConfirmingDelete(null)}>
                    <p className="mb-4 text-label text-text-secondary">
                        Delete <span className="font-mono text-text-primary">{confirmingDelete.path}</span>
                        {confirmingDelete.isDir ? " and everything inside it" : ""}? This can't be undone.
                    </p>
                    <div className="flex justify-end gap-2">
                        <button
                            type="button"
                            onClick={() => setConfirmingDelete(null)}
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
        </div>
    );
}
