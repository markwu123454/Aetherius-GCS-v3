import {useCallback, useState} from "react";
import {rebootVehicle} from "./connection.ts";

function message(error: unknown): string {
    if (error instanceof Error) return error.message;
    return typeof error === "string" ? error : "Reboot failed";
}

/**
 * A reboot button's own state: whether the request is still waiting on the
 * vehicle's answer, and why it failed if it did. For pages that offer a
 * reboot (calibration, frame, servo setup) — the top bar's connection menu
 * has its own. See `rebootVehicle` for what the call does.
 */
export function useReboot() {
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const reboot = useCallback(async (force = false) => {
        setPending(true);
        setError(null);
        try {
            await rebootVehicle(force);
        } catch (cause) {
            setError(message(cause));
        } finally {
            setPending(false);
        }
    }, []);

    return {reboot, pending, error};
}
