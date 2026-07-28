import {ReactNode, useEffect, useRef, useState} from "react";
import {BAUD_RATES, ConnectionStatus, LinkKind, describeLink} from "../vehicle/connection";
import {Connection} from "../vehicle/useConnection";

const KINDS: {kind: LinkKind; label: string}[] = [
    {kind: "sitl", label: "SITL"},
    {kind: "serial", label: "Serial"},
    {kind: "udp", label: "UDP"},
    {kind: "tcp", label: "TCP"},
];

const FIELD =
    "h-control-sm w-full border-b border-border-strong bg-layer-02 px-2 text-label text-text-primary";

function Field({label, children}: {label: string; children: ReactNode}) {
    return (
        <label className="flex flex-col gap-1">
            <span className="text-micro text-text-helper uppercase">{label}</span>
            {children}
        </label>
    );
}

interface ConnectControlProps {
    connection: Connection;
    /** Disconnecting a flying vehicle is confirmed rather than one click. */
    armed: boolean;
}

export default function ConnectControl({connection, armed}: ConnectControlProps) {
    const {config, setConfig, status, endpoint, error, connect, disconnect} = connection;
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
        if (armed && !confirmingDisconnect) {
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
                {connected ? describeLink(config) : statusLabel}
            </button>

            {open && (
                <div className="absolute top-full right-0 z-50 w-72 border border-border-subtle bg-layer-01 shadow-overlay">
                    <div className="flex border-b border-border-subtle">
                        {KINDS.map(({kind, label}) => (
                            <button
                                key={kind}
                                type="button"
                                disabled={settingsLocked}
                                onClick={() => setConfig({...config, kind})}
                                className={[
                                    "h-control-sm flex-1 text-label",
                                    config.kind === kind
                                        ? "bg-layer-02 text-text-primary"
                                        : "text-text-secondary hover:bg-layer-hover-01 hover:text-text-primary",
                                    "disabled:text-text-disabled",
                                ].join(" ")}
                            >
                                {label}
                            </button>
                        ))}
                    </div>

                    <div className="flex flex-col gap-3 p-3">
                        {config.kind === "sitl" && (
                            <>
                                <p className="text-label text-text-helper">
                                    Attaches to a simulator you have already started. Run{" "}
                                    <code className="font-mono text-text-secondary">
                                        sim_vehicle.py -v ArduPlane --no-mavproxy
                                    </code>{" "}
                                    first.
                                </p>
                                <Field label="Host">
                                    <input
                                        disabled={settingsLocked}
                                        value={config.sitlHost}
                                        onChange={(event) => setConfig({...config, sitlHost: event.target.value})}
                                        className={FIELD}
                                    />
                                </Field>
                                <Field label="Port">
                                    <input
                                        type="number"
                                        disabled={settingsLocked}
                                        value={config.sitlPort}
                                        onChange={(event) =>
                                            setConfig({...config, sitlPort: Number(event.target.value)})
                                        }
                                        className={FIELD}
                                    />
                                </Field>
                            </>
                        )}

                        {config.kind === "serial" && (
                            <>
                                <Field label="Port">
                                    <input
                                        disabled={settingsLocked}
                                        value={config.serialPort}
                                        placeholder="COM3"
                                        onChange={(event) => setConfig({...config, serialPort: event.target.value})}
                                        className={FIELD}
                                    />
                                </Field>
                                <Field label="Baud">
                                    <select
                                        disabled={settingsLocked}
                                        value={config.baud}
                                        onChange={(event) => setConfig({...config, baud: Number(event.target.value)})}
                                        className={FIELD}
                                    >
                                        {BAUD_RATES.map((baud) => (
                                            <option key={baud}>{baud}</option>
                                        ))}
                                    </select>
                                </Field>
                            </>
                        )}

                        {config.kind === "udp" && (
                            <Field label="Local Port">
                                <input
                                    type="number"
                                    disabled={settingsLocked}
                                    value={config.udpPort}
                                    onChange={(event) => setConfig({...config, udpPort: Number(event.target.value)})}
                                    className={FIELD}
                                />
                            </Field>
                        )}

                        {config.kind === "tcp" && (
                            <>
                                <Field label="Host">
                                    <input
                                        disabled={settingsLocked}
                                        value={config.tcpHost}
                                        onChange={(event) => setConfig({...config, tcpHost: event.target.value})}
                                        className={FIELD}
                                    />
                                </Field>
                                <Field label="Port">
                                    <input
                                        type="number"
                                        disabled={settingsLocked}
                                        value={config.tcpPort}
                                        onChange={(event) =>
                                            setConfig({...config, tcpPort: Number(event.target.value)})
                                        }
                                        className={FIELD}
                                    />
                                </Field>
                            </>
                        )}

                        {error && <p className="text-label text-state-danger">{error}</p>}

                        {confirmingDisconnect && (
                            <p className="text-label text-state-warn">
                                The vehicle is armed. Disconnect anyway?
                            </p>
                        )}

                        <button
                            type="button"
                            disabled={status === "disconnecting"}
                            onClick={() => (live ? handleDisconnect() : void connect())}
                            className={[
                                "h-control-sm w-full text-label text-text-on-color",
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
