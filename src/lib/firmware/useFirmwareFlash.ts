import {useCallback, useState} from "react";
import {useTauriEvent} from "@/lib/tauriEvent.ts";
import {FlashProgress, FlashResult, startFlash} from "./firmwareFlash.ts";

export type FlashStage =
    | "idle"
    | "waitingForBootloader"
    | "identify"
    | "erase"
    | "program"
    | "verify"
    | "reboot"
    | "done"
    | "error";

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Drives one flash attempt from `flash-progress`/`flash-result` events —
 * `flash_start` itself only confirms the background thread started (see
 * `firmwareFlash.ts`), so this is the only place that knows how far along
 * it actually is. Shape mirrors `useAccelCalibration`: a phase enum plus
 * whatever detail the current phase carries, driven entirely by events
 * rather than polling.
 */
export function useFirmwareFlash() {
    const [stage, setStage] = useState<FlashStage>("idle");
    const [programProgress, setProgramProgress] = useState<{done: number; total: number} | null>(null);
    const [error, setError] = useState<string | null>(null);

    useTauriEvent<FlashProgress>("flash-progress", (payload) => {
        setStage(payload.stage);
        setProgramProgress(payload.stage === "program" ? {done: payload.done, total: payload.total} : null);
    });

    useTauriEvent<FlashResult>("flash-result", (payload) => {
        if (payload.ok) {
            setStage("done");
            setError(null);
        } else {
            setStage("error");
            setError(payload.message ?? "Flashing failed.");
        }
    });

    const start = useCallback((port: string, url: string, force: boolean) => {
        setStage("waitingForBootloader");
        setProgramProgress(null);
        setError(null);
        return startFlash(port, url, force).catch((cause: unknown) => {
            setStage("error");
            setError(message(cause));
        });
    }, []);

    const reset = useCallback(() => {
        setStage("idle");
        setProgramProgress(null);
        setError(null);
    }, []);

    const flashing = stage !== "idle" && stage !== "done" && stage !== "error";

    return {stage, programProgress, error, flashing, start, reset};
}
