import {useEffect, useRef} from "react";
import {MenuItem} from "./topmenu/AppMenu.tsx";

export interface ContextMenuPosition {
    x: number;
    y: number;
}

interface ContextMenuProps extends ContextMenuPosition {
    items: MenuItem[];
    onClose: () => void;
}

const MENU_WIDTH = 208;
const ITEM_HEIGHT = 32;

/**
 * A right-click menu, positioned at the cursor rather than anchored to a
 * button — everything else about it (styling, dismissal) matches `AppMenu`'s
 * dropdowns, since this is the same interaction with a different trigger.
 * Clamped to the viewport since, unlike a menu bar, the cursor can land
 * anywhere, including a few pixels from the window's own edge.
 */
export default function ContextMenu({x, y, items, onClose}: ContextMenuProps) {
    const rootRef = useRef<HTMLUListElement>(null);

    useEffect(() => {
        // `pointerdown`, not `click`: a context menu opens on the mouse-down
        // half of a right-click, so the matching `click`/`contextmenu` on
        // release would otherwise close it in the same gesture that opened it.
        const onOutsidePointerDown = (event: PointerEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) {
                onClose();
            }
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                onClose();
            }
        };
        window.addEventListener("pointerdown", onOutsidePointerDown);
        window.addEventListener("keydown", onKeyDown);
        return () => {
            window.removeEventListener("pointerdown", onOutsidePointerDown);
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [onClose]);

    const left = Math.min(x, window.innerWidth - MENU_WIDTH - 8);
    const top = Math.min(y, window.innerHeight - items.length * ITEM_HEIGHT - 8);

    return (
        <ul
            ref={rootRef}
            style={{left, top, width: MENU_WIDTH}}
            className="fixed z-50 border border-border-subtle bg-layer-01 shadow-overlay"
        >
            {items.map((item) => (
                <li key={item.label} className={item.separatorBefore ? "mt-1 border-t border-border-subtle pt-1" : ""}>
                    <button
                        type="button"
                        disabled={item.disabled}
                        title={item.title}
                        onClick={() => {
                            item.action?.();
                            onClose();
                        }}
                        className="flex h-control-sm w-full items-center px-4 text-left text-label text-text-secondary hover:bg-layer-hover-01 hover:text-text-primary disabled:text-text-disabled"
                    >
                        {item.label}
                    </button>
                </li>
            ))}
        </ul>
    );
}
