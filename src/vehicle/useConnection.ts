import {useCallback, useEffect, useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {ConnectionStatus, LinkConfig, endpointOf, loadLink, saveLink} from "./connection";

export interface Connection {
    config: LinkConfig;
    setConfig: (config: LinkConfig) => void;
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
    const [config, setConfigState] = useState<LinkConfig>(loadLink);
    const [status, setStatus] = useState<ConnectionStatus>("disconnected");
    const [endpoint, setEndpoint] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        saveLink(config);
    }, [config]);

    useEffect(() => {
        let disposed = false;
        let unlisten: (() => void) | undefined;

        listen<ConnectionStatus>("link-status", (event) => setStatus(event.payload))
            .then((stop) => (disposed ? stop() : (unlisten = stop)))
            // No backend in a plain browser tab; the link stays disconnected.
            .catch(() => {});

        return () => {
            disposed = true;
            unlisten?.();
        };
    }, []);

    const setConfig = useCallback((next: LinkConfig) => {
        setConfigState(next);
    }, []);

    const connect = useCallback(async () => {
        setError(null);

        const address = endpointOf(config);
        setEndpoint(address);

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
    }, [config]);

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

    return {config, setConfig, status, endpoint, error, connect, disconnect};
}
