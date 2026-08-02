import {RefObject, useEffect, useRef, useState} from "react";
import * as monaco from "monaco-editor";
import "./monacoWorkers.ts";
import {defineEditorTheme, EDITOR_THEME_NAME} from "./monacoTheme.ts";

// Module-level, not per-hook-call: `defineTheme` registers globally on
// `monaco.editor` and only needs to run once no matter how many editors the
// page ever mounts.
let themeDefined = false;

export interface CodeEditor {
    containerRef: RefObject<HTMLDivElement | null>;
    /** `null` until the container has mounted and Monaco has attached to it. */
    editor: monaco.editor.IStandaloneCodeEditor | null;
}

/**
 * One Monaco instance for the container's lifetime — imperative like
 * `useBaseMap`, since past the container div, Monaco owns its own model of
 * the world. Deliberately takes no `value`/`language`: which file is open is
 * a multi-file concern (swapping `editor.setModel`), not something a single
 * generic "mount an editor here" hook should know about.
 */
export function useCodeEditor(): CodeEditor {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [editor, setEditor] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);

    useEffect(() => {
        if (!containerRef.current) return;

        if (!themeDefined) {
            defineEditorTheme();
            themeDefined = true;
        }

        const instance = monaco.editor.create(containerRef.current, {
            theme: EDITOR_THEME_NAME,
            fontFamily: "IBM Plex Mono",
            fontSize: 13,
            minimap: {enabled: false},
            automaticLayout: false,
        });

        const resizeObserver = new ResizeObserver(() => instance.layout());
        resizeObserver.observe(containerRef.current);

        setEditor(instance);

        return () => {
            resizeObserver.disconnect();
            instance.dispose();
            setEditor(null);
        };
    }, []);

    return {containerRef, editor};
}
