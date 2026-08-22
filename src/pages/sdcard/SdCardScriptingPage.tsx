import {useEffect, useState} from "react";
import {Folder} from "@carbon/icons-react";
import {useCodeEditor} from "@/lib/scripting/useCodeEditor.ts";
import {useSdCardTree} from "@/lib/sdcard/useSdCardTree.ts";
import {useSdCardOpenFile} from "@/lib/sdcard/useSdCardOpenFile.ts";
import {createSdcardScriptsDir, resolveSdcardScriptsDir, ScriptsDirResolution} from "@/lib/sdcard/sdcardFiles.ts";
import SdCardFileTree from "./SdCardFileTree.tsx";
import SdCardPageShell from "./SdCardPageShell.tsx";

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function ScriptingArea({folder}: {folder: string}) {
    const {containerRef, editor} = useCodeEditor();
    const tree = useSdCardTree(folder);
    const open = useSdCardOpenFile(editor, folder);

    // A file deleted or renamed out from under the editor closes it rather
    // than leaving it pointing at a path that no longer holds that content.
    const handlePathRemoved = (path: string, isDir: boolean) => {
        if (!open.path) return;
        const affected = isDir ? open.path === path || open.path.startsWith(`${path}/`) : open.path === path;
        if (affected) open.forget(open.path);
    };

    return (
        <div className="flex h-full min-h-0 flex-1">
            <SdCardFileTree
                folder={folder}
                tree={tree}
                selectedPath={open.path}
                dirty={open.dirty}
                onOpenFile={open.select}
                onPathRemoved={handlePathRemoved}
            />

            <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex h-control-sm shrink-0 items-center justify-between border-b border-border-subtle px-3">
                    <span className="font-mono text-label text-text-secondary">
                        {open.path ? open.path : "No file open"}
                        {open.path && open.dirty ? " •" : ""}
                    </span>
                    {open.error && <span className="text-label text-state-danger">{open.error}</span>}
                </div>

                <div className="relative min-h-0 flex-1">
                    <div ref={containerRef} className="absolute inset-0"/>
                    {!open.path && (
                        <div className="absolute inset-0 flex items-center justify-center bg-background text-center text-label text-text-helper">
                            Right-click the folder to create a file, or click a file to open it.
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

/**
 * Resolves where scripts actually live under the chosen folder before
 * `ScriptingArea` ever mounts — `resolveSdcardScriptsDir` tries the real SD
 * card layout (`APM/scripts`) first, so the common case skips straight past
 * the rest of the card instead of handing the operator the whole tree to
 * click through. `exists: false` means ArduPilot's own convention wasn't
 * found on this card yet, so the tree stays hidden behind a "Create It"
 * step rather than opening onto an empty root that happens to be the wrong
 * folder.
 */
function ScriptsRoot({folder}: {folder: string}) {
    const [resolution, setResolution] = useState<ScriptsDirResolution | null>(null);
    const [resolveError, setResolveError] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [createError, setCreateError] = useState<string | null>(null);

    const resolve = async () => {
        setResolveError(null);
        try {
            setResolution(await resolveSdcardScriptsDir(folder));
        } catch (err) {
            setResolveError(message(err));
        }
    };

    // A folder change (a fresh `chooseFolder()` pick) re-resolves from
    // scratch — the old resolution belonged to the old card.
    useEffect(() => {
        setResolution(null);
        void resolve();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [folder]);

    const createDir = async () => {
        if (!resolution) return;
        setCreating(true);
        setCreateError(null);
        try {
            await createSdcardScriptsDir(resolution.path);
            setResolution({...resolution, exists: true});
        } catch (err) {
            setCreateError(message(err));
        } finally {
            setCreating(false);
        }
    };

    if (resolveError) {
        return <div className="flex h-full w-full items-center justify-center text-label text-state-danger">{resolveError}</div>;
    }

    if (!resolution) {
        return <div className="flex h-full w-full items-center justify-center text-label text-text-helper">Looking for a scripts folder…</div>;
    }

    if (!resolution.exists) {
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-center text-label text-text-helper">
                <Folder size={32}/>
                <p>
                    No scripts folder found on this card — ArduPilot keeps Lua scripts at
                    <br/>
                    <span className="font-mono text-text-secondary">{resolution.path}</span>
                </p>
                {createError && <p className="text-state-danger">{createError}</p>}
                <button
                    type="button"
                    onClick={() => void createDir()}
                    disabled={creating}
                    className="h-control-sm w-fit border border-border-subtle px-3 text-label text-text-primary hover:enabled:bg-layer-hover-01 disabled:text-text-disabled"
                >
                    {creating ? "Creating…" : "Create It"}
                </button>
            </div>
        );
    }

    return <ScriptingArea folder={resolution.path}/>;
}

/**
 * Scripts browsed and edited directly from a chosen folder instead of the
 * live vehicle's `/APM/scripts` (see the live Scripting page's
 * `FileTree.tsx`) — one root instead of two, since there's no vehicle side
 * to mirror or drag files to/from here. Rooted at that folder's `APM/scripts`
 * rather than the folder itself (see `ScriptsRoot`), the same convention the
 * live vehicle mirror uses. Saving is Ctrl+S or the editor's own right-click
 * menu, same as the live page.
 */
export default function SdCardScriptingPage() {
    return <SdCardPageShell noun="scripts">{(folder) => <ScriptsRoot folder={folder}/>}</SdCardPageShell>;
}
