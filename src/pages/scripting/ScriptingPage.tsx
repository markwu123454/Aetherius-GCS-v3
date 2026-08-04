import {useCodeEditor} from "@/lib/scripting/useCodeEditor.ts";
import {useOpenScripts} from "@/lib/scripting/useOpenScripts.ts";
import {useFileTree, nodeKey} from "@/lib/scripting/useFileTree.ts";
import {useVehicleScriptSync} from "@/lib/scripting/useVehicleScriptSync.ts";
import {Root} from "@/lib/scripting/scriptFiles.ts";
import {useConnection} from "@/lib/vehicle/useConnection.ts";
import {useLiveParams} from "@/lib/params/useLiveParams.ts";
import FileTree from "./FileTree.tsx";

/** ArduPilot doesn't publish a hard minimum for `SCR_HEAP_SIZE` — this is a
 * conservative line below which scripts commonly fail to allocate memory,
 * not a value ArduPilot itself enforces. */
const SCR_HEAP_TOO_SMALL = 40_000;

/**
 * `/local` (`$APPDATA/scripts`) and `/vehicle` (mirrored from `/APM/scripts`
 * over MAVLink FTP, see `useVehicleScriptSync`) as one browsable tree. Both
 * are editable in place. Saving is Ctrl+S or the editor's own right-click
 * menu; moving a file within a root or copying one across roots is
 * drag-and-drop — there is no toolbar here on purpose, everything else lives
 * in the tree's own right-click menu. Rebooting the vehicle (needed after
 * changing `SCR_ENABLE`/`SCR_HEAP_SIZE`) lives in the top menu's connection
 * control, not here, since it also has to drive the reconnect afterward.
 */
export default function ScriptingPage() {
    const {containerRef, editor} = useCodeEditor();
    const open = useOpenScripts(editor);
    const connection = useConnection();
    const connected = connection.status === "connected";
    const vehicleSync = useVehicleScriptSync();
    // The vehicle side of the tree isn't safe to list until its mirror has
    // actually synced — `connected` alone (link up) isn't enough.
    const vehicleReady = connected && vehicleSync.ready;
    const tree = useFileTree();
    const live = useLiveParams();

    const scrEnable = live.values.get("SCR_ENABLE")?.value;
    const scrHeapSize = live.values.get("SCR_HEAP_SIZE")?.value;
    const scriptingWarning =
        scrEnable === 0
            ? "Scripting is disabled (SCR_ENABLE = 0) — enable it in Parameters, then reboot the vehicle."
            : scrHeapSize !== undefined && scrHeapSize < SCR_HEAP_TOO_SMALL
              ? `SCR_HEAP_SIZE is only ${scrHeapSize} bytes — scripts may fail to allocate memory.`
              : null;

    // A file deleted, renamed, or moved out from under the editor closes it
    // rather than leaving it pointing at a path that no longer holds that
    // content — the operator re-opens it from wherever it ended up.
    const handlePathRemoved = (root: Root, path: string, isDir: boolean) => {
        if (!open.selected || open.selected.root !== root) return;
        const affected = isDir
            ? open.selected.path === path || open.selected.path.startsWith(`${path}/`)
            : open.selected.path === path;
        if (affected) open.forget(open.selected.root, open.selected.path);
    };

    return (
        <div className="flex h-full w-full flex-col">
            {connected && scriptingWarning && (
                <div className="flex h-control-sm shrink-0 items-center border-b border-border-subtle bg-layer-01 px-3">
                    <span className="text-label text-state-warn">{scriptingWarning}</span>
                </div>
            )}

            <div className="flex min-h-0 flex-1">
                <FileTree
                    tree={tree}
                    vehicleConnected={vehicleReady}
                    vehicleSyncing={connected && vehicleSync.syncing}
                    vehicleSyncError={connected ? vehicleSync.error : null}
                    onRetryVehicleSync={vehicleSync.retry}
                    selected={open.selected}
                    dirtyPaths={open.dirty}
                    onOpenFile={open.select}
                    onPathRemoved={handlePathRemoved}
                />

                <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex h-control-sm shrink-0 items-center justify-between border-b border-border-subtle px-3">
                        <span className="font-mono text-label text-text-secondary">
                            {open.selected ? `/${open.selected.root}/${open.selected.path}` : "No file open"}
                            {open.selected && open.dirty.has(nodeKey(open.selected.root, open.selected.path)) ? " •" : ""}
                        </span>
                        {open.error && <span className="text-label text-state-danger">{open.error}</span>}
                    </div>

                    <div className="relative min-h-0 flex-1">
                        <div ref={containerRef} className="absolute inset-0"/>
                        {!open.selected && (
                            <div className="absolute inset-0 flex items-center justify-center bg-background text-center text-label text-text-helper">
                                Right-click /local or /vehicle to create a file, or click a file to open it.
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
