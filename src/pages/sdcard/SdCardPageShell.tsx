import {ReactNode} from "react";
import {Folder} from "@carbon/icons-react";
import {useSdCard} from "@/lib/sdcard/useSdCard.ts";

interface SdCardPageShellProps {
    /** What this page lists — only used in the empty-state copy ("Choose a
     * folder to see its scripts."). */
    noun: string;
    children: (folder: string) => ReactNode;
}

/**
 * Shared chrome for the three SD Card pages: a folder-path strip with a way
 * to change it, and a common empty state before any folder has been chosen —
 * so Logs/Parameters/Scripts under SD Card don't each reimplement the same
 * "no folder yet" screen `LogsPage` already has an equivalent for with "no
 * vehicle connected".
 */
export default function SdCardPageShell({noun, children}: SdCardPageShellProps) {
    const sdCard = useSdCard();

    if (!sdCard.folder) {
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-label text-text-helper">
                <Folder size={32} />
                <p>Choose a folder to see its {noun}.</p>
                <button
                    type="button"
                    onClick={sdCard.chooseFolder}
                    className="h-control-sm w-fit border border-border-subtle px-3 text-label text-text-primary hover:bg-layer-hover-01"
                >
                    Choose Folder…
                </button>
            </div>
        );
    }

    return (
        <div className="flex h-full w-full flex-col">
            <div className="flex h-control-sm shrink-0 items-center gap-2 border-b border-border-subtle px-3">
                <Folder size={16} className="shrink-0 text-text-helper" />
                <span className="min-w-0 flex-1 truncate text-label text-text-secondary" title={sdCard.folder}>
                    {sdCard.folder}
                </span>
                <button
                    type="button"
                    onClick={sdCard.chooseFolder}
                    className="h-control-sm w-fit shrink-0 border border-border-subtle px-3 text-label text-text-primary hover:bg-layer-hover-01"
                >
                    Change…
                </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">{children(sdCard.folder)}</div>
        </div>
    );
}
