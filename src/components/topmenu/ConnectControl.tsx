import {useEffect, useRef, useState} from "react";
import {Close} from "@carbon/icons-react";
import {ConnectionStatus, HISTORY_DISPLAY_LIMIT} from "@/lib/vehicle/connection.ts";
import {Connection} from "@/lib/vehicle/useConnection.ts";
import {sendVehicleCommand} from "@/lib/vehicle/commands.ts";

interface ConnectControlProps {
    connection: Connection;
    /** Disconnecting a flying vehicle is confirmed rather than one click. */
    armed: boolean;
    /** Operator preference: can be switched off in Settings. */
    confirmDisconnectWhenArmed: boolean;
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** How often to retry connecting after a reboot, and how many tries before
 * giving up and leaving it to the operator — a real board can take anywhere
 * from a few seconds (SITL) to over ten (USB re-enumeration) to come back. */
const RECONNECT_INTERVAL_MS = 3_000;
const RECONNECT_MAX_ATTEMPTS = 20;

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
    const [confirmingReboot, setConfirmingReboot] = useState(false);
    const [rebooting, setRebooting] = useState(false);
    const [rebootError, setRebootError] = useState<string | null>(null);
    // Drives the post-reboot reconnect retries. `hasDropped` gates the very
    // first "connected" reading out of the loop — right after sending the
    // command the link is still the pre-reboot one, and treating that as
    // "back already" would cancel the retry before the vehicle ever left.
    const [awaitingReconnect, setAwaitingReconnect] = useState(false);
    const reconnectTargetRef = useRef<string | null>(null);
    const reconnectAttemptsRef = useRef(0);
    const hasDroppedRef = useRef(false);
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) {
            setConfirmingDisconnect(false);
            setConfirmingReboot(false);
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

    // Retries `connect()` against the pre-reboot endpoint until the vehicle
    // comes back or the attempt budget runs out. Runs independently of the
    // panel being open — a reboot kicked off before closing the dropdown
    // should still reconnect in the background.
    useEffect(() => {
        if (!awaitingReconnect) {
            return;
        }
        if (!hasDroppedRef.current) {
            if (status === "connected") {
                // Still the pre-reboot link — wait for it to actually drop
                // before treating a "connected" reading as the reboot
                // having come full circle.
                return;
            }
            hasDroppedRef.current = true;
        }
        if (status === "connected") {
            setAwaitingReconnect(false);
            hasDroppedRef.current = false;
            reconnectAttemptsRef.current = 0;
            return;
        }
        if (status === "connecting") {
            // A `connect()` attempt is already in flight — wait for it to settle.
            return;
        }
        if (reconnectAttemptsRef.current >= RECONNECT_MAX_ATTEMPTS) {
            setAwaitingReconnect(false);
            hasDroppedRef.current = false;
            setRebootError("Vehicle did not come back after reboot — reconnect manually.");
            return;
        }
        const target = reconnectTargetRef.current;
        if (!target) {
            setAwaitingReconnect(false);
            return;
        }
        const timer = window.setTimeout(() => {
            reconnectAttemptsRef.current += 1;
            void connect(target);
        }, RECONNECT_INTERVAL_MS);
        return () => window.clearTimeout(timer);
    }, [awaitingReconnect, status, connect]);

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

    const handleReboot = async () => {
        // Same reasoning as disconnect: armed is the one state where this
        // shouldn't be a single click.
        if (armed && !confirmingReboot) {
            setConfirmingReboot(true);
            return;
        }
        setConfirmingReboot(false);
        setRebooting(true);
        setRebootError(null);
        try {
            await sendVehicleCommand({type: "reboot"});
            reconnectTargetRef.current = endpoint;
            hasDroppedRef.current = false;
            reconnectAttemptsRef.current = 0;
            setAwaitingReconnect(true);
        } catch (err) {
            setRebootError(message(err));
        } finally {
            setRebooting(false);
        }
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
                                        key={entry.address}
                                        type="button"
                                        disabled={settingsLocked}
                                        onClick={() => setDraft(entry.address)}
                                        className="truncate px-1 text-left font-mono text-label text-text-secondary hover:bg-layer-hover-01 hover:text-text-primary disabled:text-text-disabled"
                                    >
                                        {entry.label}
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

                        {connected && (
                            <div className="flex flex-col gap-2 border-t border-border-subtle pt-3">
                                {confirmingReboot && (
                                    <p className="text-label text-state-warn">The vehicle is armed. Reboot anyway?</p>
                                )}
                                <button
                                    type="button"
                                    disabled={rebooting || awaitingReconnect}
                                    onClick={() => void handleReboot()}
                                    className={[
                                        "h-control-sm w-full text-label disabled:opacity-50",
                                        confirmingReboot
                                            ? "bg-red-60 text-text-on-color hover:bg-red-50"
                                            : "bg-layer-02 text-text-primary hover:bg-layer-hover-02",
                                    ].join(" ")}
                                >
                                    {confirmingReboot
                                        ? "Confirm Reboot"
                                        : awaitingReconnect
                                          ? "Rebooting — waiting to reconnect…"
                                          : rebooting
                                            ? "Rebooting…"
                                            : "Reboot Vehicle"}
                                </button>
                                {rebootError && <p className="text-label text-state-danger">{rebootError}</p>}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
