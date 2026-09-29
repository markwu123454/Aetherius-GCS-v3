import {useEffect, useMemo, useRef, useState} from "react";
import {Close, Edit, Star, StarFilled} from "@carbon/icons-react";
import {ConnectionStatus, HISTORY_DISPLAY_LIMIT, ScannedLink} from "@/lib/vehicle/connection.ts";
import {Connection} from "@/lib/vehicle/useConnection.ts";
import {KnownBoard} from "@/lib/vehicle/boards.ts";

interface AvailableRowProps {
    entry: ScannedLink;
    board: KnownBoard | undefined;
    disabled: boolean;
    onSelect: () => void;
    onRename: (name: string | null) => void;
    onToggleAutoConnect: () => void;
}

/**
 * One scanned endpoint. Plain and unrecognizable-by-UID entries (SITL, or a
 * USB device whose serial doesn't look like a chip UID — see
 * `chibios_uid_from_serial`) get just the select button, same as before;
 * only entries with a `candidateUid` can have a saved profile at all, so
 * only those get the rename/auto-connect controls.
 */
function AvailableRow({entry, board, disabled, onSelect, onRename, onToggleAutoConnect}: AvailableRowProps) {
    const [renaming, setRenaming] = useState(false);
    const [draftName, setDraftName] = useState(board?.displayName ?? entry.label);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (renaming) {
            inputRef.current?.focus();
            inputRef.current?.select();
        }
    }, [renaming]);

    const startRename = () => {
        setDraftName(board?.displayName ?? entry.label);
        setRenaming(true);
    };

    const commitRename = () => {
        setRenaming(false);
        const trimmed = draftName.trim();
        onRename(trimmed.length > 0 ? trimmed : null);
    };

    const label = board?.displayName || entry.label;
    const recognizable = entry.candidateUid !== undefined;

    if (renaming) {
        return (
            <input
                ref={inputRef}
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                onBlur={commitRename}
                onKeyDown={(event) => {
                    if (event.key === "Enter") {
                        event.preventDefault();
                        commitRename();
                    } else if (event.key === "Escape") {
                        event.preventDefault();
                        setRenaming(false);
                    }
                }}
                className="h-control-sm w-full border-b border-border-strong bg-layer-02 px-1 font-mono text-label text-text-primary focus-visible:outline-none"
            />
        );
    }

    return (
        <div className="flex items-stretch">
            <button
                type="button"
                disabled={disabled}
                onClick={onSelect}
                title={board?.displayName ? entry.label : undefined}
                className="flex-1 truncate px-1 text-left font-mono text-label text-text-secondary hover:bg-layer-hover-01 hover:text-text-primary disabled:text-text-disabled"
            >
                {label}
            </button>
            {recognizable && (
                <>
                    <button
                        type="button"
                        aria-label={`Rename ${label}`}
                        disabled={disabled}
                        onClick={startRename}
                        className="flex items-center px-1.5 text-text-helper hover:text-text-primary disabled:text-text-disabled"
                    >
                        <Edit size={14}/>
                    </button>
                    <button
                        type="button"
                        aria-label={board?.autoConnect ? `Stop auto-connecting ${label}` : `Auto-connect ${label} from now on`}
                        title={board?.autoConnect ? "Auto-connects when plugged in — click to stop" : "Auto-connect this board when it's plugged in"}
                        disabled={disabled}
                        onClick={onToggleAutoConnect}
                        className={[
                            "flex items-center px-1.5 disabled:text-text-disabled",
                            board?.autoConnect ? "text-state-warn" : "text-text-helper hover:text-text-primary",
                        ].join(" ")}
                    >
                        {board?.autoConnect ? <StarFilled size={14}/> : <Star size={14}/>}
                    </button>
                </>
            )}
        </div>
    );
}

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
        reboot,
        knownBoards,
        saveBoard,
    } = connection;
    const boardsByUid = useMemo(
        () => new Map(knownBoards.map((board) => [board.uid, board])),
        [knownBoards],
    );
    const [open, setOpen] = useState(false);
    const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
    const [confirmingReboot, setConfirmingReboot] = useState(false);
    const [rebootPending, setRebootPending] = useState(false);
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
    // Also locked during rebooting — the backend owns reconnect in that state.
    const settingsLocked = live || status === "disconnecting" || status === "rebooting";

    useEffect(() => {
        // While cleanly disconnected, `useConnection`'s own background scan
        // loop already keeps `available` fresh continuously (it has to, for
        // auto-connect to notice a hot-plugged board without this dropdown
        // being open at all) — nothing to add here. "lost"/"error" aren't
        // covered by that loop, so this covers them for as long as the
        // dropdown stays open, same as scanning always used to work here.
        // Live/tearing-down is skipped either way: scanning would probe a
        // port that may already be in use by the active connection.
        if (!open || settingsLocked || status === "disconnected") {
            return;
        }

        void scan();
        const interval = window.setInterval(() => void scan(), 3_000);
        return () => window.clearInterval(interval);
    }, [open, settingsLocked, status, scan]);

    const STATUS_LABELS: Record<ConnectionStatus, string> = {
        connected: endpoint ?? "Connected",
        connecting: "Waiting for heartbeat…",
        losing: "No data",
        lost: "Connection lost",
        disconnecting: "Disconnecting…",
        disconnected: "Disconnected",
        error: "Failed",
        rebooting: "Rebooting — reconnecting…",
    };

    const STATUS_DOTS: Record<ConnectionStatus, string> = {
        connected: "bg-state-ok",
        connecting: "bg-state-warn",
        losing: "bg-state-warn",
        lost: "bg-state-danger",
        disconnecting: "bg-state-unknown",
        disconnected: "bg-state-unknown",
        error: "bg-state-danger",
        rebooting: "bg-state-warn",
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
        // Armed and confirmed: ArduPilot refuses an armed reboot unless it's
        // forced, so the confirmation is what sends the override.
        setRebootPending(true);
        try {
            await reboot(armed);
        } finally {
            setRebootPending(false);
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
                                    <AvailableRow
                                        key={entry.address}
                                        entry={entry}
                                        board={entry.candidateUid ? boardsByUid.get(entry.candidateUid) : undefined}
                                        disabled={settingsLocked}
                                        onSelect={() => setDraft(entry.address)}
                                        onRename={(name) => {
                                            if (entry.candidateUid) {
                                                void saveBoard(entry.candidateUid, {displayName: name});
                                            }
                                        }}
                                        onToggleAutoConnect={() => {
                                            if (entry.candidateUid) {
                                                const current = boardsByUid.get(entry.candidateUid);
                                                void saveBoard(entry.candidateUid, {autoConnect: !current?.autoConnect});
                                            }
                                        }}
                                    />
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
                            disabled={status === "disconnecting" || status === "rebooting" || (!live && !draft.trim())}
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
                                    ? "Reconnect"
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
                                    disabled={rebootPending}
                                    onClick={() => void handleReboot()}
                                    className={[
                                        "h-control-sm w-full text-label",
                                        confirmingReboot
                                            ? "bg-red-60 text-text-on-color hover:bg-red-50"
                                            : "bg-layer-02 text-text-primary hover:bg-layer-hover-02",
                                    ].join(" ")}
                                >
                                    {rebootPending ? "Waiting for the vehicle…" : confirmingReboot ? "Confirm Reboot" : "Reboot Vehicle"}
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
