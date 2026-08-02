import * as monaco from "monaco-editor";

/**
 * Editor chrome only, pulled from `theme.css`'s Gray 100 tokens so the
 * editor's surface doesn't look like a foreign widget dropped onto the page.
 * Carbon has no opinion on syntax colors, so token colors stay whatever
 * Monaco's bundled "vs-dark" theme already uses.
 */
export const EDITOR_THEME_NAME = "aetherius-dark";

export function defineEditorTheme(): void {
    monaco.editor.defineTheme(EDITOR_THEME_NAME, {
        base: "vs-dark",
        inherit: true,
        rules: [],
        colors: {
            "editor.background": "#161616", // --color-background
            "editor.foreground": "#f4f4f4", // --color-text-primary
            "editorLineNumber.foreground": "#6f6f6f", // --color-border-strong
            "editorLineNumber.activeForeground": "#c6c6c6", // --color-text-secondary
            "editorCursor.foreground": "#ffffff", // --color-focus
            "editor.lineHighlightBackground": "#262626", // --color-layer-01
            "editor.selectionBackground": "#393939", // --color-border-subtle-base
            "editorIndentGuide.background": "#393939",
            "editorWhitespace.foreground": "#393939",
        },
    });
}
