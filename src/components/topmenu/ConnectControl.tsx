import {useEffect, useRef, useState} from "react";
import {Close} from "@carbon/icons-react";
import {ConnectionStatus, HISTORY_DISPLAY_LIMIT} from "@/lib/vehicle/connection.ts";
import {Connection} from "@/lib/vehicle/useConnection.ts";

interface ConnectControlProps {
    connection: Connection;
    /** Disconnecting a flying vehicle is confirmed rather than one click. */
    armed: boolean;
    /** Operator preference: can be switched off in Settings. */
    confirmDisconnectWhenArmed: boolean;
}

export default function ConnectControl({connection, armed, confirmDisconnectWhenArmed}: ConnectControlProps) {
    const {
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
    } = connection;
    const [open, setOpen] = useState(false);
    const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) {
            setConfirmingDisconnect(false);
            return;
        }

        const onPointerDown = (event: PointerEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) {
                setOpen(false);
            }
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setOpen(false);
            }
        };

        window.addEventListener("pointerdown", onPointerDown);
        window.addEventListener("keydown", onKeyDown);
        return () => {
            window.removeEventListener("pointerdown", onPointerDown);
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [open]);

    const connected = status === "connected";

    // States still holding a transport open. `lost` is deliberately excluded:
    // there is no longer a socket to tear down, so its action is to reconnect
    // rather than to disconnect.
    const live = connected || status === "connecting" || status === "losing";
    const settingsLocked = live || status === "disconnecting";

    useEffect(() => {
        // Scanning while a link is live/tearing down would probe a port that
        // may already be in use by the active connection — pointless at best,
        // contended at worst — and the fields are disabled anyway, so there's
        // nothing to fill in from a result.
        if (!open || settingsLocked) {
            return;
        }

        void scan();
        const interval = window.setInterval(() => void scan(), 3_000);
        return () => window.clearInterval(interval);
    }, [open, settingsLocked, scan]);

    const STATUS_LABELS: Record<ConnectionStatus, string> = {
        connected: endpoint ?? "Connected",
        connecting: "Waiting for heartbeat…",
        // The link is still open — this is a vehicle that has gone quiet, and
        // waiting is a reasonable thing to do. Worded so it does not read as
        // final, because it is not.
        losing: "No data",
        // Deliberately not "Disconnected". This was not asked for, and unlike
        // `losing` it will not recover on its own.
        lost: "Connection lost",
        disconnecting: "Disconnecting…",
        disconnected: "Disconnected",
        error: "Failed",
    };

    const STATUS_DOTS: Record<ConnectionStatus, string> = {
        connected: "bg-state-ok",
        connecting: "bg-state-warn",
        losing: "bg-state-warn",
        lost: "bg-state-danger",
        disconnecting: "bg-state-unknown",
        disconnected: "bg-state-unknown",
        error: "bg-state-danger",
    };

    const statusLabel = STATUS_LABELS[status];
    const dot = STATUS_DOTS[status];

    const handleDisconnect = () => {
        // The whole point of the guard is that it cannot be clicked through.
        if (confirmDisconnectWhenArmed && armed && !confirmingDisconnect) {
            setConfirmingDisconnect(true);
            return;
        }
        setConfirmingDisconnect(false);
        void disconnect();
    };

    return (
        <div ref={rootRef} className="relative flex items-stretch">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
                className="flex h-full items-center gap-2 border-l border-border-subtle px-3 text-label whitespace-nowrap text-text-secondary hover:bg-layer-hover-01 hover:text-text-primary"
            >
                <span className={`size-2 shrink-0 ${dot}`} aria-hidden="true"/>
                {connected ? (endpoint ?? statusLabel) : statusLabel}
            </button>

            {open && (
                <div className="absolute top-full right-0 z-50 w-72 border border-border-subtle bg-layer-01 shadow-overlay">
                    <div className="flex flex-col gap-3 p-3">
                        <label className="flex flex-col gap-1">
                            <span className="text-micro text-text-helper uppercase">Address</span>
                            <input
                                disabled={settingsLocked}
                                value={draft}
                                onChange={(event) => setDraft(event.target.value)}
                                placeholder="tcp:127.0.0.1:5760"
                                spellCheck={false}
                                className="h-control-sm w-full border-b border-border-strong bg-layer-02 px-2 font-mono text-label text-text-primary disabled:text-text-disabled"
                            />
                        </label>

                        {history.length > 0 && (
                            <div className="flex flex-col gap-1">
                                <span className="text-micro text-text-helper uppercase">Recent</span>
                                {history.slice(0, HISTORY_DISPLAY_LIMIT).map((entry) => (
                                    <div key={entry} className="flex items-stretch">
                                        <button
                                            type="button"
                                            disabled={settingsLocked}
                                            onClick={() => setDraft(entry)}
                                            className="flex-1 truncate px-1 text-left font-mono text-label text-text-secondary hover:bg-layer-hover-01 hover:text-text-primary disabled:text-text-disabled"
                                        >
                                            {entry}
                                        </button>
                                        <button
                                            type="button"
                                            aria-label={`Remove ${entry} from recent`}
                                            disabled={settingsLocked}
                                            onClick={() => removeFromHistory(entry)}
                                            className="flex items-center px-2 text-text-helper hover:text-text-primary disabled:text-text-disabled"
                                        >
                                            <Close size={14}/>
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}

                        {available.length > 0 && (
                            <div className="flex flex-col gap-1">
                                <span className="text-micro text-text-helper uppercase">Available</span>
                                {available.map((entry) => (
                                    <button
                                        key={entry}
                                        type="button"
                                        disabled={settingsLocked}
                                        onClick={() => setDraft(entry)}
                                        className="truncate px-1 text-left font-mono text-label text-text-secondary hover:bg-layer-hover-01 hover:text-text-primary disabled:text-text-disabled"
                                    >
                                        {entry}
                                    </button>
                                ))}
                            </div>
                        )}

                        {error && <p className="text-label text-state-danger">{error}</p>}

                        {confirmingDisconnect && (
                            <p className="text-label text-state-warn">
                                The vehicle is armed. Disconnect anyway?
                            </p>
                        )}

                        <button
                            type="button"
                            disabled={status === "disconnecting" || (!live && !draft.trim())}
                            onClick={() => (live ? handleDisconnect() : void connect())}
                            className={[
                                "h-control-sm w-full text-label text-text-on-color disabled:opacity-50",
                                confirmingDisconnect
                                    ? "bg-red-60 hover:bg-red-50"
                                    : settingsLocked
                                      ? "bg-layer-02 text-text-primary hover:bg-layer-hover-02"
                                      : "bg-blue-60 hover:bg-blue-50",
                            ].join(" ")}
                        >
                            {confirmingDisconnect
                                ? "Confirm Disconnect"
                                : status === "connecting"
                                  ? "Cancel"
                                  : status === "lost"
                                    ? // The transport is gone, so the only thing
                                      // left to do about it is open a new one.
                                      "Reconnect"
                                    : live
                                      ? "Disconnect"
                                      : "Connect"}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
