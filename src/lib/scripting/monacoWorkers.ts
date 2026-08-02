import EditorWorker from "monaco-editor/editor/editor.worker?worker";

/**
 * Monaco asks for a worker per language; Lua has none of its own (its
 * Monarch tokenizer runs on the main thread), so every request gets the same
 * base editor worker, which just handles things like bracket matching.
 * Imported once for this side effect before any editor is created.
 */
self.MonacoEnvironment = {
    getWorker: () => new EditorWorker(),
};
