import {getCurrentWindow} from "@tauri-apps/api/window";
import {DisplayMode} from "./settings";

/**
 * Pushes a display preference onto the actual OS window. Fullscreen and
 * decorations are independent window properties, so leaving fullscreen has
 * to explicitly restore decorations rather than assuming they come back on
 * their own.
 */
export async function applyDisplayMode(mode: DisplayMode): Promise<void> {
    const window = getCurrentWindow();

    if (mode === "fullscreen") {
        await window.setFullscreen(true);
        return;
    }

    await window.setFullscreen(false);
    await window.setDecorations(mode === "windowed");
}
