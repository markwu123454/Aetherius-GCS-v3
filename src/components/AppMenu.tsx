import {useEffect, useRef, useState} from "react";
import {Menu as MenuIcon} from "@carbon/icons-react";

export interface MenuItem {
    label: string;
    action?: () => void;
    disabled?: boolean;
    /** Rendered with a tick. Used for panels, which toggle open and closed. */
    checked?: boolean;
    separatorBefore?: boolean;
}

export interface Menu {
    label: string;
    items: MenuItem[];
}

interface AppMenuProps {
    menus: Menu[];
    expanded: boolean;
    onExpandedChange: (expanded: boolean) => void;
}

export default function AppMenu({menus, expanded, onExpandedChange}: AppMenuProps) {
    const [openMenu, setOpenMenu] = useState<string | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!expanded) {
            setOpenMenu(null);
            return;
        }

        const onPointerDown = (event: PointerEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) {
                onExpandedChange(false);
            }
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                onExpandedChange(false);
            }
        };

        window.addEventListener("pointerdown", onPointerDown);
        window.addEventListener("keydown", onKeyDown);
        return () => {
            window.removeEventListener("pointerdown", onPointerDown);
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [expanded, onExpandedChange]);

    return (
        <div ref={rootRef} className="relative flex h-full items-stretch">
            <button
                type="button"
                aria-label="Application menu"
                aria-expanded={expanded}
                onClick={() => onExpandedChange(!expanded)}
                className="flex w-8 items-center justify-center text-text-secondary hover:bg-layer-hover-01 hover:text-text-primary"
            >
                <MenuIcon size={16}/>
            </button>

            {expanded &&
                menus.map((menu) => (
                    <div key={menu.label} className="relative flex items-stretch">
                        <button
                            type="button"
                            onClick={() => setOpenMenu(openMenu === menu.label ? null : menu.label)}
                            onPointerEnter={() => openMenu && setOpenMenu(menu.label)}
                            className={[
                                "px-4 text-label whitespace-nowrap",
                                openMenu === menu.label
                                    ? "bg-layer-hover-01 text-text-primary"
                                    : "text-text-secondary hover:bg-layer-hover-01 hover:text-text-primary",
                            ].join(" ")}
                        >
                            {menu.label}
                        </button>

                        {openMenu === menu.label && (
                            <ul className="absolute top-full left-0 z-50 min-w-56 border border-border-subtle bg-layer-01 shadow-overlay">
                                {menu.items.map((item) => (
                                    <li
                                        key={item.label}
                                        className={item.separatorBefore ? "mt-1 border-t border-border-subtle pt-1" : ""}
                                    >
                                        <button
                                            type="button"
                                            disabled={item.disabled}
                                            onClick={() => {
                                                item.action?.();
                                                onExpandedChange(false);
                                            }}
                                            className="flex h-control-sm w-full items-center gap-2 px-4 text-left text-label text-text-secondary hover:bg-layer-hover-01 hover:text-text-primary disabled:text-text-helper"
                                        >
                                            <span className="w-3 shrink-0 text-state-info">
                                                {item.checked ? "✓" : ""}
                                            </span>
                                            {item.label}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                ))}
        </div>
    );
}
