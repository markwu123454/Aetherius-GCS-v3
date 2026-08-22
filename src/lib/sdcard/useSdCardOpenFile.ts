import {useCallback, useEffect, useRef, useState} from "react";
import * as monaco from "monaco-editor";
import {readSdcardFile, writeSdcardFile} from "./sdcardFiles.ts";

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export interface SdCardOpenFile {
    path: string | null;
    dirty: boolean;
    saving: boolean;
    error: string | null;
    select: (path: string) => void;
    save: () => Promise<void>;
    /** Drops the currently-open file if it's the one that just got deleted,
     * renamed, or moved out from under the editor — same trigger as the
     * live Scripting page's `onPathRemoved`, just simpler since there's
     * only ever one file open here. */
    forget: (path: string) => void;
}

/**
 * One Monaco model at a time for whichever SD-card script is open — unlike
 * the live Scripting page's `useOpenScripts`, which keeps a model per file
 * alive for the page's whole lifetime so switching between many open files
 * is instant and each keeps its own undo history. SD Card editing is
 * typically a couple of scripts off a card, not a large multi-file
 * session, so re-reading from disk on every switch (a local read, not a
 * MAVLink FTP fetch) is cheap enough to trade for the simpler lifecycle.
 */
export function useSdCardOpenFile(editor: monaco.editor.IStandaloneCodeEditor | null, folder: string | null): SdCardOpenFile {
    const [path, setPath] = useState<string | null>(null);
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const pathRef = useRef<string | null>(null);
    pathRef.current = path;

    // A folder change (a fresh `chooseFolder()` pick) invalidates whatever
    // was open under the old one rather than trying to keep it around.
    useEffect(() => {
        setPath(null);
        setDirty(false);
        setError(null);
        editor?.setValue("");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [folder]);

    useEffect(() => {
        if (!editor) return;
        const subscription = editor.onDidChangeModelContent(() => {
            if (pathRef.current) setDirty(true);
        });
        return () => subscription.dispose();
    }, [editor]);

    const select = useCallback(
        (nextPath: string) => {
            if (!editor || !folder) return;
            setError(null);
            setPath(nextPath);
            setDirty(false);
            // `try` around the call itself, not just a `.catch()` after it —
            // `readSdcardFile` throws synchronously (via `requireBackend`)
            // outside the desktop app, before there's a promise to attach
            // `.catch()` to.
            try {
                readSdcardFile(folder, nextPath)
                    .then((content) => editor.setValue(content))
                    .catch((err) => setError(message(err)));
            } catch (err) {
                setError(message(err));
            }
        },
        [editor, folder],
    );

    const save = useCallback(async () => {
        if (!editor || !folder || !pathRef.current) return;
        setSaving(true);
        setError(null);
        try {
            await writeSdcardFile(folder, pathRef.current, editor.getValue());
            setDirty(false);
        } catch (err) {
            setError(message(err));
        } finally {
            setSaving(false);
        }
    }, [editor, folder]);

    // Kept current via a ref rather than in `addAction`'s dependency array —
    // the action is registered once per editor instance, same reasoning as
    // `useOpenScripts`.
    const saveRef = useRef(save);
    saveRef.current = save;

    useEffect(() => {
        if (!editor) return;
        const action = editor.addAction({
            id: "aetherius.sdcard.save",
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
        (removedPath: string) => {
            if (pathRef.current !== removedPath) return;
            setPath(null);
            setDirty(false);
            editor?.setValue("");
        },
        [editor],
    );

    return {path, dirty, saving, error, select, save, forget};
}
