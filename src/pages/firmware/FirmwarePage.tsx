import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {useConnection} from "@/lib/vehicle/useConnection.ts";
import {useVehicle} from "@/lib/vehicle/useVehicle.ts";
import {scanLinks, ScannedLink} from "@/lib/vehicle/connection.ts";
import {sendVehicleCommand} from "@/lib/vehicle/commands.ts";
import Modal from "@/components/Modal.tsx";
import {
    ApjSummary,
    FirmwareOption,
    frameLabel,
    ManifestVehicleType,
    matchesBoard,
    prepareFirmware,
} from "@/lib/firmware/firmwareFlash.ts";
import {retryFirmwareManifest, useFirmwareManifest} from "@/lib/firmware/useFirmwareManifest.ts";
import {useFirmwareFlash} from "@/lib/firmware/useFirmwareFlash.ts";

type PrepareState =
    | {status: "idle"}
    | {status: "preparing"}
    | {status: "ready"; summary: ApjSummary}
    | {status: "error"; message: string};

const STAGE_LABEL: Record<string, string> = {
    waitingForBootloader: "Waiting for the board to enter bootloader mode…",
    identify: "Identifying the board…",
    erase: "Erasing flash…",
    program: "Writing firmware…",
    verify: "Verifying…",
    reboot: "Rebooting the board…",
    done: "Done.",
    error: "Failed.",
};

/** How long to keep looking for the board after a successful flash before
 * leaving it to the operator, and how often to look. USB re-enumeration
 * after the bootloader's REBOOT is typically a couple of seconds. */
const RECONNECT_TIMEOUT_MS = 20_000;
const RECONNECT_POLL_MS = 1_000;

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** `connection.endpoint` is `serial:PORT:BAUD` for a serial link — anything
 * else (`tcp:`/`udp:` for SITL or a telemetry radio bridge) isn't a port
 * flashing could ever open directly. */
function serialPortOf(endpoint: string | null): string | null {
    if (!endpoint?.startsWith("serial:")) return null;
    return endpoint.split(":")[1] ?? null;
}

function FirmwareRow({
    option,
    active,
    onSelect,
}: {
    option: FirmwareOption;
    active: boolean;
    onSelect: () => void;
}) {
    return (
        <button
            type="button"
            aria-current={active}
            onClick={onSelect}
            className={[
                "flex w-full flex-col items-start gap-0.5 border-b border-border-subtle-base px-3 py-2 text-left",
                active ? "bg-background" : "hover:bg-layer-hover-01",
            ].join(" ")}
        >
            <span className="text-label text-text-primary">{option.platform}</span>
            {/* The frame class is not decoration: every Copter board
                publishes a multirotor and a traditional-helicopter build
                sharing a platform, a version, and a board_id. Without this
                line the two rows are byte-identical on screen and the
                board_id check downstream can't tell them apart either. */}
            <span className="text-micro text-text-helper">
                {option.version} · {option.versionType} · {frameLabel(option.mavType)}
                {option.brandName ? ` · ${option.brandName}` : ""}
            </span>
        </button>
    );
}

/**
 * ArduCopter/ArduPlane firmware flashing — this app's equivalent of
 * QGroundControl's Firmware setup page (and, going back further, PX4's
 * airframe-preset picker: ArduPilot has no such preset system, so this is
 * just "pick a board+version from ArduPilot's own catalog, write it").
 *
 * Deliberately not gated on `useConnection().status === "connected"` like
 * every other page in this app — a board that needs flashing usually has no
 * firmware to connect to yet. A currently-connected vehicle is only used as
 * a convenience (pre-filling vehicle type and offering to reboot it into
 * bootloader mode automatically); the whole flow works with nothing
 * connected at all, same as ArduPilot's own `uploader.py`.
 */
export default function FirmwarePage() {
    const connection = useConnection();
    const vehicle = useVehicle();
    const flash = useFirmwareFlash();

    const [vehicleType, setVehicleType] = useState<ManifestVehicleType>(
        vehicle.vehicleKind === "plane" ? "Plane" : "Copter",
    );
    const manifest = useFirmwareManifest(vehicleType);
    const [query, setQuery] = useState("");
    const [selected, setSelected] = useState<FirmwareOption | null>(null);
    const [prepareState, setPrepareState] = useState<PrepareState>({status: "idle"});
    // Downloads are a few MB and can finish out of order, so a click on
    // board A resolving after a click on board B must not leave A's summary
    // sitting under B's heading. (`flash_start` independently refuses to
    // write an image whose URL isn't the one being confirmed — this keeps
    // the screen honest, that keeps the board safe.)
    const prepareToken = useRef(0);
    const [confirming, setConfirming] = useState(false);

    const [ports, setPorts] = useState<ScannedLink[]>([]);
    const [selectedPort, setSelectedPort] = useState<string | null>(null);
    const [force, setForce] = useState(false);
    const [rebooting, setRebooting] = useState(false);
    const [reconnecting, setReconnecting] = useState(false);
    const [showAllBoards, setShowAllBoards] = useState(false);

    const refreshPorts = useCallback(async () => {
        try {
            const all = await scanLinks();
            // Radios, RTK GPS units, etc. show up in the same USB scan the
            // connect dropdown uses — none of them speak the bootloader
            // protocol, so they're left out here rather than offered as a
            // flashable target that would just time out.
            const flashable = all.filter((link) => link.class === "pixhawk");
            setPorts(flashable);
            // Auto-select when there's no ambiguity. A board exposing
            // several CDC interfaces (a Pixhawk 6C shows up as two COM
            // ports) counts as several entries, so this only fires when
            // there is exactly one — otherwise the operator picks.
            setSelectedPort((current) => {
                if (current && flashable.some((link) => link.portName === current)) return current;
                return flashable.length === 1 ? (flashable[0].portName ?? null) : null;
            });
        } catch {
            setPorts([]);
        }
    }, []);

    /// The USB identity of whatever board is plugged in, used to narrow the
    /// firmware list to builds that are actually for it.
    const detectedBoard = useMemo(() => {
        const withIds = ports.find((link) => link.vid !== undefined && link.pid !== undefined);
        return withIds ? {vid: withIds.vid!, pid: withIds.pid!, label: withIds.label} : null;
    }, [ports]);

    useEffect(() => {
        void refreshPorts();
    }, [refreshPorts]);

    // A fresh vehicle type invalidates whatever was picked/prepared for the
    // old one — a Plane .apj is never a valid answer while browsing Copter.
    // Bumping the token discards an in-flight download for the old type too,
    // which would otherwise land and present itself as ready.
    useEffect(() => {
        prepareToken.current += 1;
        setSelected(null);
        setPrepareState({status: "idle"});
    }, [vehicleType]);

    // Narrowed to the plugged-in board when one is detected — the whole list
    // is ~300 boards per vehicle type, and picking the wrong one is the
    // mistake with the worst consequences. `showAllBoards` is the escape
    // hatch for a board this can't identify, or for flashing one that isn't
    // currently attached.
    const boardMatches = useMemo(() => {
        const options = manifest.status === "ready" ? manifest.options : [];
        if (!detectedBoard) return null;
        const matches = options.filter((option) => matchesBoard(option, detectedBoard.vid, detectedBoard.pid));
        return matches.length > 0 ? matches : null;
    }, [manifest, detectedBoard]);

    const filtered = useMemo(() => {
        const all = manifest.status === "ready" ? manifest.options : [];
        const options = boardMatches && !showAllBoards ? boardMatches : all;
        const q = query.trim().toLowerCase();
        if (!q) return options;
        return options.filter(
            (option) =>
                option.platform.toLowerCase().includes(q) || (option.brandName ?? "").toLowerCase().includes(q),
        );
    }, [manifest, query, boardMatches, showAllBoards]);

    const handleSelect = async (option: FirmwareOption) => {
        const token = ++prepareToken.current;
        setSelected(option);
        setPrepareState({status: "preparing"});
        try {
            const summary = await prepareFirmware(option.url);
            if (prepareToken.current !== token) return;
            setPrepareState({status: "ready", summary});
        } catch (error) {
            if (prepareToken.current !== token) return;
            setPrepareState({status: "error", message: message(error)});
        }
    };

    const connectedPort = serialPortOf(connection.endpoint);

    // ArduPilot's own docs advertise no way to cancel a reboot once sent —
    // same reasoning `AccelCalibrationPanel` documents for its own
    // uncancellable reboot. This just waits a fixed grace period for the
    // USB re-enumeration to settle before re-scanning, rather than polling.
    const handleRebootToBootloader = async () => {
        setRebooting(true);
        try {
            await sendVehicleCommand({type: "rebootToBootloader"}).catch(() => {
                // The board may reboot before an ack ever arrives — a
                // timeout here doesn't mean the command didn't land.
            });
            await connection.disconnect();
            await new Promise((resolve) => setTimeout(resolve, 1500));
            await refreshPorts();
            if (connectedPort) {
                setSelectedPort(connectedPort);
            }
        } finally {
            setRebooting(false);
        }
    };

    // `connection` is a fresh object every render, so the reconnect effect
    // below reads `connect` through a ref rather than depending on it —
    // otherwise it would re-fire on every render and start a second
    // reconnect over the top of the first.
    const connectRef = useRef(connection.connect);
    connectRef.current = connection.connect;
    const handledFlashDone = useRef(false);

    // `upload` ends by telling the bootloader to REBOOT, so the board comes
    // straight up on the firmware just written — but as a *new* USB device,
    // which takes a few seconds to enumerate and may land on a different
    // port than the one flashed. Polled rather than slept-on: enumeration
    // time varies with the machine, and a fixed wait is either wrong or
    // needlessly slow.
    useEffect(() => {
        if (flash.stage !== "done") {
            handledFlashDone.current = false;
            return;
        }
        if (handledFlashDone.current) return;
        handledFlashDone.current = true;

        let cancelled = false;
        void (async () => {
            setReconnecting(true);
            try {
                const deadline = Date.now() + RECONNECT_TIMEOUT_MS;
                while (!cancelled && Date.now() < deadline) {
                    await new Promise((resolve) => setTimeout(resolve, RECONNECT_POLL_MS));
                    if (cancelled) return;
                    const all = await scanLinks().catch(() => [] as ScannedLink[]);
                    if (cancelled) return;
                    const board = all.find((link) => link.class === "pixhawk");
                    if (board) {
                        setPorts(all.filter((link) => link.class === "pixhawk"));
                        await connectRef.current(board.address).catch(() => {
                            // Firmware is written either way — a failed
                            // reconnect is the operator's to retry, not a
                            // reason to report the flash as failed.
                        });
                        return;
                    }
                }
            } finally {
                if (!cancelled) setReconnecting(false);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [flash.stage]);

    const canFlash = prepareState.status === "ready" && selectedPort !== null && !flash.flashing;

    return (
        <div className="flex h-full w-full">
            <div className="flex w-80 shrink-0 flex-col border-r border-border-subtle bg-layer-01">
                <div className="flex shrink-0 items-center gap-1 border-b border-border-subtle p-2 text-micro">
                    {(["Copter", "Plane"] as const).map((kind) => (
                        <button
                            key={kind}
                            type="button"
                            aria-pressed={vehicleType === kind}
                            onClick={() => setVehicleType(kind)}
                            className={[
                                "border px-2 py-1",
                                vehicleType === kind
                                    ? "border-border-strong text-text-primary"
                                    : "border-transparent text-text-helper hover:text-text-primary",
                            ].join(" ")}
                        >
                            {kind}
                        </button>
                    ))}
                </div>
                <div className="shrink-0 border-b border-border-subtle p-2">
                    <input
                        type="text"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Filter boards…"
                        className="h-control-sm w-full border border-border-subtle bg-background px-2 text-body text-text-primary placeholder:text-text-helper focus-visible:outline-none"
                    />
                </div>
                {boardMatches && (
                    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border-subtle px-2 py-1.5">
                        <span className="text-micro text-text-helper">
                            {showAllBoards
                                ? `All boards — ${detectedBoard?.label} detected`
                                : `Showing builds for ${detectedBoard?.label}`}
                        </span>
                        <button
                            type="button"
                            onClick={() => setShowAllBoards((value) => !value)}
                            className="shrink-0 text-micro text-state-info underline"
                        >
                            {showAllBoards ? "Only mine" : "Show all"}
                        </button>
                    </div>
                )}
                <div className="min-h-0 flex-1 overflow-auto">
                    {manifest.status === "loading" && (
                        <p className="p-3 text-label text-text-helper">Loading ArduPilot's firmware catalog…</p>
                    )}
                    {manifest.status === "error" && (
                        <p className="p-3 text-label text-state-danger">
                            {manifest.message}{" "}
                            <button
                                type="button"
                                onClick={() => retryFirmwareManifest(vehicleType)}
                                className="text-state-info underline"
                            >
                                Retry
                            </button>
                        </p>
                    )}
                    {manifest.status === "ready" &&
                        filtered.map((option) => (
                            <FirmwareRow
                                key={`${option.platform}:${option.versionType}:${option.url}`}
                                option={option}
                                active={selected?.url === option.url}
                                onSelect={() => void handleSelect(option)}
                            />
                        ))}
                    {manifest.status === "ready" && filtered.length === 0 && (
                        <p className="p-3 text-label text-text-helper">No boards match "{query}".</p>
                    )}
                </div>
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-6">
                <div className="flex max-w-lg flex-col gap-6">
                    <div>
                        <h2 className="text-heading text-text-primary">Firmware</h2>
                        <p className="text-body text-text-secondary">
                            Writes an official ArduPilot build to a board sitting in bootloader mode. Reference:{" "}
                            <a
                                href="https://ardupilot.org/copter/docs/common-loading-firmware-onto-pixhawk.html"
                                target="_blank"
                                rel="noreferrer"
                                className="text-state-info underline"
                            >
                                ArduPilot's Loading Firmware docs
                            </a>
                            .
                        </p>
                    </div>

                    {!selected && <p className="text-label text-text-helper">Pick a board from the list to begin.</p>}

                    {selected && (
                        <div className="flex flex-col gap-2 border-t border-border-subtle-base pt-4">
                            <span className="text-label text-text-secondary">
                                {selected.platform} — {selected.version} ({selected.versionType})
                            </span>
                            {prepareState.status === "preparing" && (
                                <p className="text-label text-text-helper">Downloading…</p>
                            )}
                            {prepareState.status === "error" && (
                                <p className="text-label text-state-danger">{prepareState.message}</p>
                            )}
                            {prepareState.status === "ready" && (
                                <p className="text-label text-state-ok">
                                    Ready — board_id {prepareState.summary.boardId}, rev{" "}
                                    {prepareState.summary.boardRevision}, {(prepareState.summary.imageSize / 1024).toFixed(0)} KB
                                </p>
                            )}
                        </div>
                    )}

                    <div className="flex flex-col gap-2 border-t border-border-subtle-base pt-4">
                        <div className="flex items-center justify-between">
                            <span className="text-label text-text-helper">Port</span>
                            <button
                                type="button"
                                onClick={() => void refreshPorts()}
                                className="text-micro text-state-info underline"
                            >
                                Refresh
                            </button>
                        </div>
                        <select
                            value={selectedPort ?? ""}
                            onChange={(event) => setSelectedPort(event.target.value || null)}
                            className="h-control-sm w-full border border-border-subtle bg-background px-2 text-body text-text-primary focus-visible:outline-none"
                        >
                            <option value="" disabled>
                                {ports.length === 0 ? "— no boards found —" : "— select a port —"}
                            </option>
                            {ports.map((port) => (
                                <option key={port.address} value={port.portName ?? ""}>
                                    {port.label} ({port.portName})
                                </option>
                            ))}
                        </select>

                        {connection.status === "connected" && connectedPort && (
                            <div className="flex flex-col gap-1">
                                <button
                                    type="button"
                                    disabled={rebooting}
                                    onClick={() => void handleRebootToBootloader()}
                                    className="h-control-sm w-fit border border-border-subtle px-3 text-label text-text-primary hover:enabled:bg-layer-hover-01 disabled:text-text-disabled"
                                >
                                    {rebooting ? "Rebooting…" : `Reboot connected vehicle (${connectedPort}) into bootloader`}
                                </button>
                                <p className="text-micro text-text-helper">
                                    Disconnects the current link and reboots the vehicle straight into its bootloader,
                                    so you don't have to unplug it by hand.
                                </p>
                            </div>
                        )}
                        {!(connection.status === "connected" && connectedPort) && (
                            <p className="text-micro text-text-helper">
                                Not connected to a vehicle — plug the board in now (or reset it) and its bootloader
                                should appear here within a few seconds.
                            </p>
                        )}
                    </div>

                    <div className="flex flex-col gap-1 border-t border-border-subtle-base pt-4">
                        <label className="flex items-center gap-2 text-label text-state-warn">
                            <input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)}/>
                            Force — flash even if the board reports a different board ID
                        </label>
                        <p className="text-micro text-text-helper">
                            Leave this off. It exists for boards ArduPilot's own compatible-ID list doesn't cover;
                            using it on a genuinely different board writes firmware built for different hardware.
                        </p>
                    </div>

                    <div className="flex flex-col gap-3 border-t border-border-subtle-base pt-4">
                        <button
                            type="button"
                            disabled={!canFlash}
                            onClick={() => setConfirming(true)}
                            className="h-control-sm w-fit bg-blue-60 px-4 text-label text-text-on-color hover:enabled:bg-blue-50 disabled:opacity-50"
                        >
                            {flash.flashing ? "Flashing…" : "Flash"}
                        </button>

                        {flash.stage !== "idle" && (
                            <div className="flex flex-col gap-2">
                                <p className={`text-label ${flash.stage === "error" ? "text-state-danger" : flash.stage === "done" ? "text-state-ok" : "text-state-info"}`}>
                                    {STAGE_LABEL[flash.stage]}
                                </p>
                                {flash.stage === "program" && flash.programProgress && (
                                    <div className="h-1.5 w-full bg-layer-02">
                                        <div
                                            className="h-full bg-state-info"
                                            style={{
                                                width: `${Math.round((flash.programProgress.done / Math.max(1, flash.programProgress.total)) * 100)}%`,
                                            }}
                                        />
                                    </div>
                                )}
                                {flash.stage === "error" && flash.error && (
                                    <p className="text-label text-state-danger">{flash.error}</p>
                                )}
                                {flash.stage === "done" && reconnecting && (
                                    <p className="text-label text-text-helper">
                                        Waiting for the board to come back up, then reconnecting…
                                    </p>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* A chip erase is the first thing the bootloader is told to do,
                so by the time anything has gone wrong the board's existing
                firmware is already gone. One click shouldn't be able to
                start that, and the frame class gets repeated here because
                picking the heli build for a multirotor is the mistake this
                screen makes easiest. */}
            {confirming && selected && prepareState.status === "ready" && selectedPort && (
                <Modal title="Erase and write firmware?" onClose={() => setConfirming(false)}>
                    <div className="mb-4 flex flex-col gap-2 text-label text-text-secondary">
                        <p>
                            Writing <span className="text-text-primary">{selected.platform}</span>{" "}
                            <span className="text-text-primary">{selected.version}</span> (
                            {frameLabel(selected.mavType)}, {selected.versionType}) to{" "}
                            <span className="font-mono text-text-primary">{selectedPort}</span>.
                        </p>
                        <p>
                            This erases the board's current firmware before it writes. It can't be undone, and a
                            board interrupted mid-write needs recovering over its bootloader.
                        </p>
                        {force && (
                            <p className="text-state-warn">
                                Force is on — the board ID check that would stop firmware for different hardware
                                is disabled.
                            </p>
                        )}
                    </div>
                    <div className="flex justify-end gap-2">
                        <button
                            type="button"
                            onClick={() => setConfirming(false)}
                            className="h-control-sm bg-layer-02 px-4 text-label text-text-primary hover:bg-layer-hover-02"
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                setConfirming(false);
                                void flash.start(selectedPort, selected.url, force);
                            }}
                            className="h-control-sm bg-red-60 px-4 text-label text-text-on-color hover:opacity-90"
                        >
                            Erase and write
                        </button>
                    </div>
                </Modal>
            )}
        </div>
    );
}
