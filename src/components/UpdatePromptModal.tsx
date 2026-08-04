import Modal from "@/components/Modal.tsx";
import {UpdateCheck} from "@/lib/update/useUpdateCheck.ts";

interface UpdatePromptModalProps {
    update: UpdateCheck;
    /** Closes the prompt for the rest of this session — nothing is
     * persisted, so it simply asks again on the next launch. */
    onDismiss: () => void;
}

/**
 * Shown once, right after the launch-time check finds something newer.
 * Reuses the app's one `Update` resource — this is a second view onto the
 * same `useUpdateCheck` state the About page reads, not a separate check.
 */
export default function UpdatePromptModal({update, onDismiss}: UpdatePromptModalProps) {
    const downloading = update.status === "downloading";

    return (
        <Modal title="Update available" onClose={downloading ? () => {} : onDismiss}>
            <div className="flex flex-col gap-3">
                <p className="text-body text-text-secondary">
                    v{update.currentVersion} → v{update.latestVersion}
                </p>

                {downloading && (
                    <p className="text-label text-text-helper">
                        Downloading update
                        {update.totalBytes
                            ? ` — ${Math.round((update.downloadedBytes / update.totalBytes) * 100)}%`
                            : "…"}
                    </p>
                )}

                {update.status === "ready" && (
                    <p className="text-label text-text-helper">Installed. Relaunching…</p>
                )}

                {update.status === "error" && (
                    <p className="text-label text-state-danger">{update.error}</p>
                )}

                <div className="flex justify-end gap-2 pt-1">
                    <button
                        type="button"
                        disabled={downloading}
                        onClick={onDismiss}
                        className="h-control-sm px-3 text-label text-text-secondary hover:bg-layer-hover-02 hover:text-text-primary disabled:opacity-50"
                    >
                        Remind me next time
                    </button>
                    <button
                        type="button"
                        disabled={downloading}
                        onClick={() => void update.installAndRelaunch()}
                        className="h-control-sm bg-blue-60 px-3 text-label text-text-on-color hover:bg-blue-50 disabled:opacity-50"
                    >
                        {update.status === "error" ? "Try Again" : downloading ? "Updating…" : "Update"}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
