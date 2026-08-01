import {useCallback, useEffect, useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {useTauriEvent} from "@/lib/tauriEvent.ts";
import {ConnectionStatus, loadHistory, saveHistory, scanLinks, withAttempt, withoutAttempt} from "./connection.ts";

export interface Connection {
    /** The address currently typed into the connect field, not yet submitted. */
    draft: string;
    setDraft: (value: string) => void;
    /** Recently attempted addresses, most recent first — deeper than what's shown. */
    history: string[];
    removeFromHistory: (endpoint: string) => void;
    /** Endpoints found by the last `scan()`, in whatever order the backend returned them. */
    available: string[];
    /** Re-runs the scan. Resolves once `available` is updated; never rejects. */
    scan: () => Promise<void>;
    status: ConnectionStatus;
    /** The address the transport was asked to open. */
    endpoint: string | null;
    error: string | null;
    connect: () => Promise<void>;
    disconnect: () => Promise<void>;
}

function message(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return typeof error === "string" ? error : "Connection failed";
}

/**
 * Reflects the link. It does not decide anything about it.
 *
 * The backend owns the state machine, because only it knows whether a socket
 * opened, whether a request was superseded, and how long ago the last heartbeat
 * was. This hook holds the last status the backend published and forwards user
 * intent to it.
 */
export function useConnection(): Connection {
    const [history, setHistory] = useState<string[]>(loadHistory);
    const [draft, setDraftState] = useState<string>(() => history[0] ?? "");
    const [available, setAvailable] = useState<string[]>([]);
    const [status, setStatus] = useState<ConnectionStatus>("disconnected");
    const [endpoint, setEndpoint] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        saveHistory(history);
    }, [history]);

    // A component can mount well after the link already changed state — this
    // hook's own default of "disconnected" is only a placeholder until the
    // *next* transition, since `link-status` is an event, not a subscribable
    // current value. This fills in whatever is already true instead of
    // assuming nothing has happened yet.
    useEffect(() => {
        invoke<ConnectionStatus | null>("link_status")
            .then((current) => {
                if (current) {
                    setStatus(current);
                }
            })
            .catch(() => {});
    }, []);

    const scan = useCallback(async () => {
        try {
            setAvailable(await scanLinks());
        } catch {
            // No backend, or the probe itself failed — either way, nothing found.
            setAvailable([]);
        }
    }, []);

    useTauriEvent<ConnectionStatus>("link-status", setStatus);

    const setDraft = useCallback((value: string) => {
        setDraftState(value);
    }, []);

    const removeFromHistory = useCallback((address: string) => {
        setHistory((prev) => withoutAttempt(prev, address));
    }, []);

    const connect = useCallback(async () => {
        setError(null);

        const address = draft.trim();
        if (!address) {
            setError("Enter an address to connect to.");
            return;
        }

        setEndpoint(address);
        setHistory((prev) => withAttempt(prev, address));

        // Show the status the backend is about to publish, so the button reacts
        // to the click rather than to the IPC round trip. This is a cache of an
        // imminent value, not a second opinion — the next `link-status` event
        // overwrites it either way, including with `error`.
        setStatus("connecting");

        try {
            await invoke("connect_link", {endpoint: address});
        } catch (cause) {
            setError(message(cause));
        }
    }, [draft]);

    const disconnect = useCallback(async () => {
        // Same reasoning: covers the round trip, and is superseded on arrival.
        setStatus("disconnecting");

        try {
            await invoke("disconnect_link");
        } catch (cause) {
            setError(message(cause));
        } finally {
            setEndpoint(null);
        }
    }, []);

    return {
        draft,
        setDraft,
        history,
        removeFromHistory,
        available,
        scan,
        status,
        endpoint,
        error,
        connect,
        disconnect,
    };
}
