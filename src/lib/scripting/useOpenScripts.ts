import {useCallback, useEffect, useRef, useState} from "react";
import * as monaco from "monaco-editor";
import {readLocalFile, readVehicleFile, Root, writeLocalFile, writeVehicleFile} from "./scriptFiles.ts";
import {nodeKey} from "./useFileTree.ts";

interface OpenModel {
    model: monaco.editor.ITextModel;
    subscription: monaco.IDisposable;
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export interface OpenFile {
    root: Root;
    path: string;
}

export interface OpenScripts {
    selected: OpenFile | null;
    /** Keyed by `nodeKey(root, path)` — edits not yet written back. */
    dirty: Set<string>;
    saving: boolean;
    error: string | null;
    select: (root: Root, path: string) => void;
    save: () => Promise<void>;
    /** Drops a file's in-memory model — used when it's deleted, renamed, or
     * moved out from under the editor, not a normal "close tab" action. */
    forget: (root: Root, path: string) => void;
}

/**
 * One Monaco model per opened file, local or vehicle, kept alive for the
 * page's lifetime so switching between files preserves undo history and
 * cursor position instead of re-fetching and re-tokenizing every click.
 * `editor` swaps its attached model on `select` rather than owning content
 * itself. A vehicle file is read straight into memory over MAVLink FTP and
 * saved the same way on Ctrl+S — local and vehicle differ only in where
 * `select`/`save` read from and write to.
 */
export function useOpenScripts(editor: monaco.editor.IStandaloneCodeEditor | null): OpenScripts {
    const modelsRef = useRef<Map<string, OpenModel>>(new Map());
    const [selected, setSelected] = useState<OpenFile | null>(null);
    const [dirty, setDirty] = useState<Set<string>>(new Set());
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Every model this page opens is Monaco's to keep, not React's — disposed
    // only when the page itself unmounts, not on every file switch.
    useEffect(() => {
        return () => {
            modelsRef.current.forEach(({model, subscription}) => {
                subscription.dispose();
                model.dispose();
            });
            modelsRef.current.clear();
        };
    }, []);

    const select = useCallback(
        (root: Root, path: string) => {
            if (!editor) return;
            setError(null);
            const key = nodeKey(root, path);
            let open = modelsRef.current.get(key);
            if (!open) {
                // A blank placeholder attaches immediately so switching feels
                // instant; the real content swaps in once the read resolves.
                // A real URI (rather than a bare language id) is what lets
                // Monaco pick the right language from the extension itself —
                // "lua" for a script, "json" for a config file, plain text
                // for anything it doesn't recognize — instead of this hook
                // having to maintain its own extension-to-language table.
                const model = monaco.editor.createModel("", undefined, monaco.Uri.parse(`inmemory://${root}/${path}`));
                const subscription = model.onDidChangeContent(() => {
                    setDirty((prev) => new Set(prev).add(key));
                });
                open = {model, subscription};
                modelsRef.current.set(key, open);

                const opened = open;
                const read = root === "local" ? readLocalFile(path) : readVehicleFile(path);
                read
                    .then((content) => {
                        // Discarded if `forget` already replaced this entry
                        // (e.g. the file was deleted) before the read landed.
                        if (modelsRef.current.get(key) !== opened) return;
                        opened.model.setValue(content);
                        setDirty((prev) => {
                            const next = new Set(prev);
                            next.delete(key);
                            return next;
                        });
                    })
                    .catch((err) => setError(message(err)));
            }
            editor.setModel(open.model);
            setSelected({root, path});
        },
        [editor],
    );

    const save = useCallback(async () => {
        if (!selected) return;
        const key = nodeKey(selected.root, selected.path);
        const open = modelsRef.current.get(key);
        if (!open) return;
        setSaving(true);
        setError(null);
        try {
            const content = open.model.getValue();
            if (selected.root === "local") await writeLocalFile(selected.path, content);
            else await writeVehicleFile(selected.path, content);
            setDirty((prev) => {
                const next = new Set(prev);
                next.delete(key);
                return next;
            });
        } catch (err) {
            setError(message(err));
        } finally {
            setSaving(false);
        }
    }, [selected]);

    // Kept current via a ref rather than in `addAction`'s dependency array —
    // the action is registered once per editor instance, so the callback it
    // invokes has to reach today's `save` some other way.
    const saveRef = useRef(save);
    saveRef.current = save;

    useEffect(() => {
        if (!editor) return;
        // `addAction`, not `addCommand` — this app has no toolbar Save
        // button, so Ctrl+S is not the only way in: this also puts "Save"
        // into Monaco's own right-click menu, which is the closest thing to
        // a blur-to-save gesture an editor like this has.
        const action = editor.addAction({
            id: "aetherius.save",
            label: "Save",
            keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
            contextMenuGroupId: "9_aetherius",
            contextMenuOrder: 1,
            run: () => {
                void saveRef.current();
            },
        });
        return () => action.dispose();
    }, [editor]);

    const forget = useCallback(
        (root: Root, path: string) => {
            const key = nodeKey(root, path);
            const open = modelsRef.current.get(key);
            if (open) {
                open.subscription.dispose();
                open.model.dispose();
                modelsRef.current.delete(key);
            }
            setDirty((prev) => {
                if (!prev.has(key)) return prev;
                const next = new Set(prev);
                next.delete(key);
                return next;
            });
            if (selected && nodeKey(selected.root, selected.path) === key) {
                setSelected(null);
                editor?.setModel(null);
            }
        },
        [editor, selected],
    );

    return {selected, dirty, saving, error, select, save, forget};
}
