import {useCallback, useEffect, useRef, useState} from "react";
import {check, Update} from "@tauri-apps/plugin-updater";
import {relaunch} from "@tauri-apps/plugin-process";

export type UpdateStatus =
    | "idle"
    | "checking"
    | "up-to-date"
    | "available"
    | "downloading"
    | "ready"
    | "error";

export interface UpdateCheck {
    status: UpdateStatus;
    /** Set once a check has run at least once, whether or not one was found. */
    currentVersion: string | null;
    /** Only set while `status` is `"available"`, `"downloading"`, or `"ready"`. */
    latestVersion: string | null;
    /** Release notes for the pending update, if the release provided any. */
    releaseNotes: string | null;
    /** Bytes downloaded so far, only meaningful while `status` is `"downloading"`. */
    downloadedBytes: number;
    /** Total bytes for the update package, if the server reported a length. */
    totalBytes: number | null;
    error: string | null;
    /** Looks for a new release. Resolves once `status` reflects the result. */
    checkNow: () => Promise<void>;
    /** Downloads and installs the pending update, then relaunches the app.
     * Only meaningful once `status` is `"available"`. */
    installAndRelaunch: () => Promise<void>;
}

function message(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return typeof error === "string" ? error : "Update check failed";
}

/**
 * Wraps `@tauri-apps/plugin-updater`, which itself talks to the GitHub
 * releases endpoint configured in `tauri.conf.json`. Holds the `Update`
 * resource between `checkNow` and `installAndRelaunch` — the plugin's
 * `download`/`install` methods live on that object, not as free functions.
 */
export function useUpdateCheck(): UpdateCheck {
    const [status, setStatus] = useState<UpdateStatus>("idle");
    const [currentVersion, setCurrentVersion] = useState<string | null>(null);
    const [latestVersion, setLatestVersion] = useState<string | null>(null);
    const [releaseNotes, setReleaseNotes] = useState<string | null>(null);
    const [downloadedBytes, setDownloadedBytes] = useState(0);
    const [totalBytes, setTotalBytes] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const updateRef = useRef<Update | null>(null);

    // The `Update` resource is backed by a handle on the Rust side — release
    // it if the component goes away with a checked-but-unapplied update still
    // held, rather than leaking it for the life of the app.
    useEffect(() => {
        return () => {
            void updateRef.current?.close();
        };
    }, []);

    const checkNow = useCallback(async () => {
        setStatus("checking");
        setError(null);

        try {
            await updateRef.current?.close();
            const result = await check();
            updateRef.current = result;

            if (result) {
                setCurrentVersion(result.currentVersion);
                setLatestVersion(result.version);
                setReleaseNotes(result.body ?? null);
                setStatus("available");
            } else {
                setLatestVersion(null);
                setReleaseNotes(null);
                setStatus("up-to-date");
            }
        } catch (cause) {
            setError(message(cause));
            setStatus("error");
        }
    }, []);

    const installAndRelaunch = useCallback(async () => {
        const update = updateRef.current;
        if (!update) return;

        setStatus("downloading");
        setDownloadedBytes(0);
        setTotalBytes(null);
        setError(null);

        try {
            await update.downloadAndInstall((event) => {
                if (event.event === "Started") {
                    setTotalBytes(event.data.contentLength ?? null);
                } else if (event.event === "Progress") {
                    setDownloadedBytes((prev) => prev + event.data.chunkLength);
                }
            });
            setStatus("ready");
            await relaunch();
        } catch (cause) {
            setError(message(cause));
            setStatus("error");
        }
    }, []);

    return {
        status,
        currentVersion,
        latestVersion,
        releaseNotes,
        downloadedBytes,
        totalBytes,
        error,
        checkNow,
        installAndRelaunch,
    };
}
