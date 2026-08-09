import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import {CheckmarkFilled, CircleFilled, InProgress, RadioButton, Checkmark, Warning} from "@carbon/icons-react";
import {useConnection} from "@/lib/vehicle/useConnection.ts";
import {useVehicle} from "@/lib/vehicle/useVehicle.ts";
import {scanLinks, ScannedLink} from "@/lib/vehicle/connection.ts";
import {sendVehicleCommand} from "@/lib/vehicle/commands.ts";
import {firmwareVersionLabel} from "@/lib/vehicle/vehicle.ts";
import {
    ApjSummary,
    FirmwareOption,
    matchesBoard,
    prepareFirmware,
} from "@/lib/firmware/firmwareFlash.ts";
import {retryFirmwareManifest, useFirmwareManifest} from "@/lib/firmware/useFirmwareManifest.ts";
import {useFirmwareFlash} from "@/lib/firmware/useFirmwareFlash.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

type UserVehicleType = "plane" | "multirotor" | "helicopter";
type PrepareState =
    | {status: "idle"}
    | {status: "preparing"}
    | {status: "ready"; summary: ApjSummary}
    | {status: "error"; message: string};
type StepStatus = "pending" | "active" | "done" | "error";

// ── Constants ─────────────────────────────────────────────────────────────────

const VEHICLE_OPTS: {type: UserVehicleType; label: string; sub: string}[] = [
    {type: "plane", label: "ArduPlane", sub: "Fixed wing"},
    {type: "multirotor", label: "ArduCopter", sub: "Multirotor"},
    {type: "helicopter", label: "ArduCopter", sub: "Helicopter"},
];

// ArduPilot's manifest spells these "OFFICIAL"/"BETA"/"RC"/"DEV" (see
// `mav-firmware-version-type` in flash.rs) — lowercased for comparison here.
// "stable" was never a value the backend actually sends; matching on it left
// every "official"-only filter finding nothing.
const VERSION_ORDER = ["official", "rc", "beta", "dev"];
const RECONNECT_TIMEOUT_MS = 20_000;
const RECONNECT_POLL_MS = 1_000;

const FLASH_STAGES: {stage: string; label: string}[] = [
    {stage: "waitingForBootloader", label: "Enter bootloader"},
    {stage: "identify", label: "Identify board"},
    {stage: "erase", label: "Erase flash"},
    {stage: "program", label: "Write firmware"},
    {stage: "verify", label: "Verify"},
    {stage: "reboot", label: "Reboot board"},
];
const FLASH_STAGE_ORDER = [
    "waitingForBootloader", "identify", "erase", "program", "verify", "reboot", "done", "error",
];

// ── Pure helpers ──────────────────────────────────────────────────────────────

function manifestTypeOf(v: UserVehicleType | null): "Copter" | "Plane" {
    return v === "plane" ? "Plane" : "Copter";
}

/** Name for the firmware currently running, from HEARTBEAT's `vehicleKind` —
 * distinct from `UserVehicleType`, which also splits out helicopter and only
 * exists to pick a manifest entry, not to describe what's already flashed. */
function runningFirmwareName(kind: "plane" | "multirotor" | "other" | null): string {
    if (kind === "plane") return "ArduPlane";
    if (kind === "multirotor") return "ArduCopter";
    return "ArduPilot";
}

function mavTypeOf(v: UserVehicleType): string {
    if (v === "plane") return "FIXED_WING";
    if (v === "helicopter") return "HELICOPTER";
    return "Copter";
}

function sortVersionTypes(types: string[]): string[] {
    return [...types].sort((a, b) => {
        const ai = VERSION_ORDER.indexOf(a.toLowerCase());
        const bi = VERSION_ORDER.indexOf(b.toLowerCase());
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
}

function versionLabel(v: string): string {
    const m: Record<string, string> = {official: "Stable", rc: "RC", beta: "Beta", dev: "Dev"};
    return m[v.toLowerCase()] ?? v;
}

function serialPortOf(endpoint: string | null): string | null {
    if (!endpoint?.startsWith("serial:")) return null;
    return endpoint.split(":")[1] ?? null;
}

function errMsg(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// ── UI components ─────────────────────────────────────────────────────────────

function StepDot({status}: {status: StepStatus}) {
    const base = "flex h-5 w-5 shrink-0 items-center justify-center";
    switch (status) {
        case "done":
            return <span className={`${base} bg-blue-60 text-text-on-color`}><Checkmark size={12} /></span>;
        case "active":
            return <span className={`${base} bg-blue-60 text-text-on-color`}><CircleFilled size={10} /></span>;
        case "error":
            return <span className={`${base} bg-red-60 text-text-on-color`}><Warning size={12} /></span>;
        default:
            return <span className={`${base} border border-border-subtle`} />;
    }
}

function Step({
    title,
    status,
    doneSummary,
    children,
    alwaysChildren,
}: {
    title: string;
    status: StepStatus;
    doneSummary?: string;
    children?: React.ReactNode;
    /** Rendered below children even when the step is pending. */
    alwaysChildren?: React.ReactNode;
}) {
    const isPending = status === "pending";
    return (
        <div className="border-b border-border-subtle py-6">
            <div className="flex items-start gap-3">
                <StepDot status={status} />
                <div className="min-w-0 flex-1">
                    <div className="mb-3 flex items-baseline gap-2">
                        <span
                            className={`text-label font-semibold ${isPending ? "text-text-disabled" : "text-text-primary"}`}
                        >
                            {title}
                        </span>
                        {status === "done" && doneSummary && (
                            <span className="text-micro text-text-helper">{doneSummary}</span>
                        )}
                    </div>
                    {!isPending && children}
                    {alwaysChildren}
                </div>
            </div>
        </div>
    );
}

function FlashItem({
    label,
    done,
    active,
    children,
}: {
    label: string;
    done: boolean;
    active: boolean;
    children?: React.ReactNode;
}) {
    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
                {done ? (
                    <CheckmarkFilled size={16} className="shrink-0 text-state-ok" />
                ) : active ? (
                    // Spins so a step with no other progress signal (erase, in
                    // particular, sits here silently for several seconds)
                    // still visibly shows something is happening.
                    <InProgress size={16} className="shrink-0 animate-spin text-text-primary" />
                ) : (
                    <RadioButton size={16} className="shrink-0 text-text-disabled" />
                )}
                <span className={`text-label ${done || active ? "text-text-primary" : "text-text-disabled"}`}>
                    {label}
                </span>
            </div>
            {active && children && <div className="ml-6">{children}</div>}
        </div>
    );
}

function BoardRow({
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
            <span className="text-micro text-text-helper">
                {option.version} · {option.versionType}
                {option.brandName ? ` · ${option.brandName}` : ""}
            </span>
        </button>
    );
}

// ── Main page ─────────────────────────────────────────────────────────────────

/**
 * Checklist-based firmware flashing flow.
 *
 * Simple mode: connect → pick vehicle type → pick version → download → flash.
 * Board is auto-detected from USB scan; version list is narrowed to what's
 * actually available for that board + vehicle type combination.
 *
 * Advanced mode: raw port picker, full board catalog, force flag.
 */
export default function FirmwarePage() {
    const connection = useConnection();
    const vehicle = useVehicle();
    const flash = useFirmwareFlash();

    const [advanced, setAdvanced] = useState(false);

    // Step: vehicle type — pre-fill from active MAVLink connection
    const [vehicleType, setVehicleType] = useState<UserVehicleType | null>(() => {
        if (vehicle.vehicleKind === "plane") return "plane";
        if (vehicle.vehicleKind === "multirotor") return "multirotor";
        return null;
    });

    // Both manifests are pre-fetched at module load; hooks can't be conditional.
    const copterManifest = useFirmwareManifest("Copter");
    const planeManifest = useFirmwareManifest("Plane");
    const manifest = vehicleType === "plane" ? planeManifest : copterManifest;

    const [selectedVersion, setSelectedVersion] = useState<string | null>(null);

    // Prepare / download state
    const [prepareState, setPrepareState] = useState<PrepareState>({status: "idle"});
    const prepareToken = useRef(0);
    const [preparedOption, setPreparedOption] = useState<FirmwareOption | null>(null);

    // Port scan
    const [ports, setPorts] = useState<ScannedLink[]>([]);
    const [selectedPort, setSelectedPort] = useState<string | null>(null);

    // Advanced extras
    const [advancedBoard, setAdvancedBoard] = useState<FirmwareOption | null>(null);
    const [boardQuery, setBoardQuery] = useState("");
    const [showAllVersions, setShowAllVersions] = useState(false);
    const [force, setForce] = useState(false);

    // Inline flash confirmation
    const [confirmingFlash, setConfirmingFlash] = useState(false);

    const [rebooting, setRebooting] = useState(false);
    const [reconnecting, setReconnecting] = useState(false);

    // ── Board scan ────────────────────────────────────────────────────────────

    const refreshPorts = useCallback(async () => {
        try {
            const all = await scanLinks();
            const flashable = all.filter((link) => link.class === "pixhawk");
            setPorts(flashable);
            setSelectedPort((current) => {
                if (current && flashable.some((link) => link.portName === current)) return current;
                return flashable.length === 1 ? (flashable[0].portName ?? null) : null;
            });
        } catch {
            setPorts([]);
        }
    }, []);

    useEffect(() => {
        void refreshPorts();
    }, [refreshPorts]);

    const detectedBoard = useMemo(() => {
        const withIds = ports.find((link) => link.vid !== undefined && link.pid !== undefined);
        return withIds
            ? {vid: withIds.vid!, pid: withIds.pid!, label: withIds.label, portName: withIds.portName}
            : null;
    }, [ports]);

    // ── Firmware options ──────────────────────────────────────────────────────

    // Options matching the selected vehicle type + frame (mav type).
    const typeFilteredOptions = useMemo(() => {
        if (!vehicleType || manifest.status !== "ready") return [];
        const mav = mavTypeOf(vehicleType);
        return manifest.options.filter((o) => o.mavType === mav);
    }, [manifest, vehicleType]);

    // In simple mode: narrowed to detected board.
    // In advanced mode: narrowed to the board the user explicitly picked.
    const candidateOptions = useMemo(() => {
        if (advanced) {
            if (!advancedBoard) return typeFilteredOptions;
            return typeFilteredOptions.filter(
                (o) =>
                    o.platform === advancedBoard.platform ||
                    (advancedBoard.usbid.length > 0 && o.usbid.some((id) => advancedBoard.usbid.includes(id))),
            );
        }
        if (detectedBoard) {
            const matched = typeFilteredOptions.filter((o) =>
                matchesBoard(o, detectedBoard.vid, detectedBoard.pid),
            );
            if (matched.length > 0) return matched;
        }
        return typeFilteredOptions;
    }, [typeFilteredOptions, advanced, advancedBoard, detectedBoard]);

    const availableVersions = useMemo(() => {
        const types = [...new Set(candidateOptions.map((o) => o.versionType.toLowerCase()))];
        return sortVersionTypes(types);
    }, [candidateOptions]);

    // Auto-select "official" (shown as "Stable") or the first available when
    // the version list changes.
    useEffect(() => {
        if (availableVersions.length === 0) return;
        if (selectedVersion && availableVersions.includes(selectedVersion.toLowerCase())) return;
        setSelectedVersion(availableVersions.find((v) => v === "official") ?? availableVersions[0] ?? null);
    }, [availableVersions]);

    // The single option that matches all selections.
    const targetOption = useMemo(() => {
        if (!selectedVersion) return null;
        return (
            candidateOptions.find((o) => o.versionType.toLowerCase() === selectedVersion) ?? null
        );
    }, [candidateOptions, selectedVersion]);

    // Reset download when the target changes.
    useEffect(() => {
        prepareToken.current += 1;
        setPrepareState({status: "idle"});
        setPreparedOption(null);
        setConfirmingFlash(false);
    }, [targetOption?.url]);

    // Reset version + board when vehicle type changes.
    useEffect(() => {
        setAdvancedBoard(null);
        setSelectedVersion(null);
    }, [vehicleType]);

    // ── Download ──────────────────────────────────────────────────────────────

    const handleDownload = async () => {
        if (!targetOption) return;
        const token = ++prepareToken.current;
        setPrepareState({status: "preparing"});
        try {
            const summary = await prepareFirmware(targetOption.url);
            if (prepareToken.current !== token) return;
            setPrepareState({status: "ready", summary});
            setPreparedOption(targetOption);
        } catch (error) {
            if (prepareToken.current !== token) return;
            setPrepareState({status: "error", message: errMsg(error)});
        }
    };

    // ── Reboot to bootloader ──────────────────────────────────────────────────

    const connectedPort = serialPortOf(connection.endpoint);

    const handleRebootToBootloader = async () => {
        setRebooting(true);
        try {
            await sendVehicleCommand({type: "rebootToBootloader"}).catch(() => {});
            await connection.disconnect();
            await new Promise((resolve) => setTimeout(resolve, 1500));
            await refreshPorts();
            if (connectedPort) setSelectedPort(connectedPort);
        } finally {
            setRebooting(false);
        }
    };

    // ── Reconnect after flash ─────────────────────────────────────────────────

    const connectRef = useRef(connection.connect);
    connectRef.current = connection.connect;
    const handledFlashDone = useRef(false);

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
                        await connectRef.current(board.address).catch(() => {});
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

    // ── Derived step states ───────────────────────────────────────────────────

    const mavlinkConnected = connection.status === "connected" && connectedPort !== null;
    // Step 1: a port is selected, or the vehicle is reachable via MAVLink and
    // can be rebooted into bootloader from step 5.
    const boardReady = selectedPort !== null || mavlinkConnected;
    const vehicleReady = vehicleType !== null;
    const boardPickReady = !advanced || advancedBoard !== null;
    const versionReady = selectedVersion !== null && targetOption !== null;
    const downloadReady = prepareState.status === "ready" && preparedOption !== null;
    const flashing = flash.flashing;
    const flashDone = flash.stage === "done";
    const flashError = flash.stage === "error";
    const flashStarted = flash.stage !== "idle";

    function flashItemStatus(stage: string): {done: boolean; active: boolean} {
        const si = FLASH_STAGE_ORDER.indexOf(stage);
        const ci = FLASH_STAGE_ORDER.indexOf(flash.stage);
        if (!flashStarted || flashError) return {done: false, active: false};
        return {done: ci > si, active: ci === si && flash.stage !== "done"};
    }

    // ── Advanced board list ───────────────────────────────────────────────────

    const advancedBoardOptions = useMemo(() => {
        if (!vehicleType || manifest.status !== "ready") return [];
        const mav = mavTypeOf(vehicleType);
        let opts = manifest.options.filter((o) => o.mavType === mav);
        if (!showAllVersions) {
            opts = opts.filter((o) => o.versionType.toLowerCase() === "official");
        }
        const q = boardQuery.trim().toLowerCase();
        if (q) {
            opts = opts.filter(
                (o) =>
                    o.platform.toLowerCase().includes(q) ||
                    (o.brandName ?? "").toLowerCase().includes(q),
            );
        }
        return opts;
    }, [manifest, vehicleType, boardQuery, showAllVersions]);

    // ── Render ────────────────────────────────────────────────────────────────

    return (
        <div className="flex h-full flex-col">
            {/* Header */}
            <div className="flex shrink-0 items-center justify-between border-b border-border-subtle px-6 py-4">
                <div>
                    <h2 className="text-heading text-text-primary">Firmware</h2>
                    <p className="text-micro text-text-helper">
                        Install official ArduPilot firmware on a flight controller.
                    </p>
                </div>
                <label className="flex cursor-pointer items-center gap-2 text-label text-text-secondary select-none">
                    <input
                        type="checkbox"
                        checked={advanced}
                        onChange={(e) => {
                            setAdvanced(e.target.checked);
                            setAdvancedBoard(null);
                        }}
                        className="h-4 w-4"
                    />
                    Advanced
                </label>
            </div>

            {/* Current board / firmware info */}
            <div className="flex shrink-0 flex-wrap items-center gap-x-8 gap-y-1 border-b border-border-subtle bg-layer-01 px-6 py-3">
                <div>
                    <span className="text-micro text-text-helper">Connected board</span>
                    <p className="text-label text-text-primary">
                        {detectedBoard
                            ? detectedBoard.label
                            : mavlinkConnected
                            ? "Unknown board"
                            : "None detected"}
                    </p>
                </div>
                <div>
                    <span className="text-micro text-text-helper">Running firmware</span>
                    <p className="text-label text-text-primary">
                        {vehicle.firmware
                            ? `${runningFirmwareName(vehicle.vehicleKind)} ${firmwareVersionLabel(vehicle.firmware)}`
                            : mavlinkConnected
                            ? "Reading version…"
                            : "Not connected"}
                    </p>
                </div>
                {vehicle.firmware?.gitHash && (
                    <div>
                        <span className="text-micro text-text-helper">Git hash</span>
                        <p className="text-label font-mono text-text-primary">{vehicle.firmware.gitHash}</p>
                    </div>
                )}
            </div>

            {/* Checklist */}
            <div className="min-h-0 flex-1 overflow-auto p-6">
                <div>

                    {/* ── Step 1: Connect board ── */}
                    <Step
                        title="Connect board"
                        status={boardReady ? "done" : "active"}
                        doneSummary={
                            selectedPort
                                ? `${detectedBoard?.label ?? "Board"} · ${selectedPort}`
                                : mavlinkConnected
                                ? `MAVLink · ${connectedPort}`
                                : undefined
                        }
                    >
                        <p className="mb-3 text-micro text-text-helper">
                            Plug your flight controller in via USB. If it's already connected and running
                            firmware, you can proceed — the last step will reboot it into flashing mode
                            automatically so you don't have to unplug it.
                        </p>
                        {advanced ? (
                            <div className="flex flex-col gap-2">
                                <div className="flex items-center justify-between">
                                    <span className="text-micro text-text-helper">
                                        Port
                                    </span>
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
                                    onChange={(e) => setSelectedPort(e.target.value || null)}
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
                            </div>
                        ) : detectedBoard ? (
                            <div className="flex items-center justify-between">
                                <div>
                                    <span className="text-label text-text-primary">
                                        {detectedBoard.label}
                                    </span>
                                    {selectedPort && (
                                        <span className="ml-2 text-micro text-text-helper">
                                            on {selectedPort}
                                        </span>
                                    )}
                                </div>
                                <button
                                    type="button"
                                    onClick={() => void refreshPorts()}
                                    className="text-micro text-state-info underline"
                                >
                                    Refresh
                                </button>
                            </div>
                        ) : ports.length > 1 ? (
                            <div className="flex flex-col gap-2">
                                <div className="flex items-center justify-between">
                                    <span className="text-micro text-text-helper">
                                        Multiple boards found — select one
                                    </span>
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
                                    onChange={(e) => setSelectedPort(e.target.value || null)}
                                    className="h-control-sm w-full border border-border-subtle bg-background px-2 text-body text-text-primary focus-visible:outline-none"
                                >
                                    <option value="" disabled>
                                        — select a port —
                                    </option>
                                    {ports.map((port) => (
                                        <option key={port.address} value={port.portName ?? ""}>
                                            {port.label} ({port.portName})
                                        </option>
                                    ))}
                                </select>
                            </div>
                        ) : mavlinkConnected ? (
                            <div className="flex items-center justify-between">
                                <p className="text-label text-text-secondary">
                                    Vehicle connected via MAVLink on{" "}
                                    <span className="font-mono text-text-primary">{connectedPort}</span>
                                    . Use "Reboot to bootloader" in the last step — no unplug needed.
                                </p>
                                <button
                                    type="button"
                                    onClick={() => void refreshPorts()}
                                    className="ml-4 shrink-0 text-micro text-state-info underline"
                                >
                                    Refresh
                                </button>
                            </div>
                        ) : (
                            <div className="flex items-center justify-between">
                                <p className="text-label text-text-helper">
                                    Plug in your flight controller. It should appear here automatically.
                                </p>
                                <button
                                    type="button"
                                    onClick={() => void refreshPorts()}
                                    className="ml-4 shrink-0 text-micro text-state-info underline"
                                >
                                    Refresh
                                </button>
                            </div>
                        )}
                    </Step>

                    {/* ── Step 2: Select vehicle type ── */}
                    <Step
                        title="Select vehicle type"
                        status={vehicleReady ? "done" : "active"}
                        doneSummary={vehicleType ? VEHICLE_OPTS.find((o) => o.type === vehicleType)?.sub : undefined}
                    >
                        <p className="mb-3 text-micro text-text-helper">
                            Pick the type of vehicle this board will fly. ArduCopter covers both
                            multirotors and traditional helicopters — they use separate firmware
                            builds, so pick the right frame type.
                        </p>
                        <div className="flex flex-wrap gap-2">
                            {VEHICLE_OPTS.map((opt) => (
                                <button
                                    key={opt.type}
                                    type="button"
                                    aria-pressed={vehicleType === opt.type}
                                    onClick={() => setVehicleType(opt.type)}
                                    className={[
                                        "flex flex-col items-start border px-4 py-2",
                                        vehicleType === opt.type
                                            ? "border-blue-60 bg-blue-60 text-text-on-color"
                                            : "border-border-subtle text-text-secondary hover:border-border-strong hover:text-text-primary",
                                    ].join(" ")}
                                >
                                    <span className="text-label">{opt.label}</span>
                                    <span className="text-micro text-text-helper">{opt.sub}</span>
                                </button>
                            ))}
                        </div>
                    </Step>

                    {/* ── Step 3 (advanced only): Select board ── */}
                    {advanced && (
                        <Step
                            title="Select board"
                            status={
                                !vehicleReady
                                    ? "pending"
                                    : advancedBoard
                                    ? "done"
                                    : "active"
                            }
                            doneSummary={advancedBoard?.platform}
                        >
                            <p className="mb-3 text-micro text-text-helper">
                                Search the full firmware catalog and pick the exact board build you want
                                to install. Use this to override the auto-detected board or to flash a
                                board that isn't currently plugged in.
                            </p>
                            <div className="flex flex-col gap-2">
                                {detectedBoard && (
                                    <p className="text-micro text-text-helper">
                                        Detected: {detectedBoard.label} — pick a different board below to
                                        override.
                                    </p>
                                )}
                                <input
                                    type="text"
                                    value={boardQuery}
                                    onChange={(e) => setBoardQuery(e.target.value)}
                                    placeholder="Filter boards…"
                                    className="h-control-sm w-full border border-border-subtle bg-background px-2 text-body text-text-primary placeholder:text-text-helper focus-visible:outline-none"
                                />
                                <label className="flex items-center gap-2 text-micro text-text-helper select-none">
                                    <input
                                        type="checkbox"
                                        checked={showAllVersions}
                                        onChange={(e) => setShowAllVersions(e.target.checked)}
                                        className="h-3.5 w-3.5"
                                    />
                                    Show all version types (including bdshot)
                                </label>
                                <div className="max-h-48 overflow-auto border border-border-subtle">
                                    {manifest.status === "loading" && (
                                        <p className="p-3 text-label text-text-helper">
                                            Loading firmware catalog…
                                        </p>
                                    )}
                                    {manifest.status === "error" && (
                                        <p className="p-3 text-label text-state-danger">
                                            {manifest.message}{" "}
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    retryFirmwareManifest(manifestTypeOf(vehicleType))
                                                }
                                                className="text-state-info underline"
                                            >
                                                Retry
                                            </button>
                                        </p>
                                    )}
                                    {manifest.status === "ready" &&
                                        advancedBoardOptions.map((opt) => (
                                            <BoardRow
                                                key={`${opt.platform}:${opt.versionType}:${opt.url}`}
                                                option={opt}
                                                active={advancedBoard?.url === opt.url}
                                                onSelect={() => {
                                                    setAdvancedBoard(opt);
                                                    setSelectedVersion(opt.versionType.toLowerCase());
                                                }}
                                            />
                                        ))}
                                    {manifest.status === "ready" && advancedBoardOptions.length === 0 && (
                                        <p className="p-3 text-label text-text-helper">
                                            No boards match.
                                        </p>
                                    )}
                                </div>
                            </div>
                        </Step>
                    )}

                    {/* ── Step 3/4: Select version ── */}
                    <Step
                        title="Select version"
                        status={
                            !vehicleReady || !boardPickReady
                                ? "pending"
                                : versionReady
                                ? "done"
                                : availableVersions.length === 0
                                ? "active"
                                : "active"
                        }
                        doneSummary={selectedVersion ? versionLabel(selectedVersion) : undefined}
                    >
                        <p className="mb-3 text-micro text-text-helper">
                            Stable is tested and recommended for most builds. Beta may have minor bugs.
                            Dev is the latest code and changes daily — only use it if you're actively
                            testing new features.
                        </p>
                        {manifest.status === "loading" && (
                            <p className="text-label text-text-helper">
                                Loading firmware catalog…
                            </p>
                        )}
                        {manifest.status === "error" && (
                            <div className="flex items-center gap-2">
                                <p className="text-label text-state-danger">{manifest.message}</p>
                                <button
                                    type="button"
                                    onClick={() => retryFirmwareManifest(manifestTypeOf(vehicleType))}
                                    className="text-micro text-state-info underline"
                                >
                                    Retry
                                </button>
                            </div>
                        )}
                        {manifest.status === "ready" && availableVersions.length === 0 && (
                            <p className="text-label text-text-helper">
                                No firmware available for this board and vehicle type.
                            </p>
                        )}
                        {manifest.status === "ready" && availableVersions.length > 0 && (
                            <div className="flex flex-wrap gap-2">
                                {availableVersions.map((v) => (
                                    <button
                                        key={v}
                                        type="button"
                                        aria-pressed={selectedVersion === v}
                                        onClick={() => setSelectedVersion(v)}
                                        className={[
                                            "border px-4 py-1.5 text-label",
                                            selectedVersion === v
                                                ? "border-blue-60 bg-blue-60 text-text-on-color"
                                                : "border-border-subtle text-text-secondary hover:border-border-strong hover:text-text-primary",
                                        ].join(" ")}
                                    >
                                        {versionLabel(v)}
                                    </button>
                                ))}
                            </div>
                        )}
                    </Step>

                    {/* ── Step 4/5: Download firmware ── */}
                    <Step
                        title="Download firmware"
                        status={
                            !versionReady
                                ? "pending"
                                : prepareState.status === "error"
                                ? "error"
                                : downloadReady
                                ? "done"
                                : "active"
                        }
                        doneSummary={
                            downloadReady && prepareState.status === "ready"
                                ? `${(prepareState.summary.imageSize / 1024).toFixed(0)} KB`
                                : undefined
                        }
                    >
                        <p className="mb-3 text-micro text-text-helper">
                            Fetches the firmware file from ArduPilot's servers to this computer.
                            Nothing is written to the board yet — you can review the build details
                            before committing to the flash.
                        </p>
                        {targetOption && (
                            <div className="flex flex-col gap-3">
                                <div className="text-label text-text-secondary">
                                    <span className="text-text-primary">{targetOption.platform}</span>
                                    {" — "}
                                    {targetOption.version}
                                    {targetOption.brandName ? ` (${targetOption.brandName})` : ""}
                                </div>

                                {prepareState.status === "idle" && (
                                    <button
                                        type="button"
                                        onClick={() => void handleDownload()}
                                        className="h-control-sm w-fit bg-blue-60 px-4 text-label text-text-on-color hover:bg-blue-50"
                                    >
                                        Download
                                    </button>
                                )}

                                {prepareState.status === "preparing" && (
                                    <div className="flex flex-col gap-2">
                                        <div className="h-1 w-full overflow-hidden bg-layer-02">
                                            <div
                                                className="h-full animate-pulse bg-state-info"
                                                style={{width: "60%"}}
                                            />
                                        </div>
                                        <p className="text-micro text-text-helper">Downloading…</p>
                                    </div>
                                )}

                                {prepareState.status === "ready" && (
                                    <div className="flex items-center gap-3">
                                        <span className="flex items-center gap-1 text-label text-state-ok"><CheckmarkFilled size={14} /> Ready</span>
                                        <span className="text-micro text-text-helper">
                                            board_id {prepareState.summary.boardId} ·{" "}
                                            {(prepareState.summary.imageSize / 1024).toFixed(0)} KB
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() => void handleDownload()}
                                            className="text-micro text-state-info underline"
                                        >
                                            Re-download
                                        </button>
                                    </div>
                                )}

                                {prepareState.status === "error" && (
                                    <div className="flex flex-col gap-2">
                                        <p className="text-label text-state-danger">
                                            {prepareState.message}
                                        </p>
                                        <button
                                            type="button"
                                            onClick={() => void handleDownload()}
                                            className="h-control-sm w-fit border border-border-subtle px-3 text-label text-text-primary hover:bg-layer-hover-01"
                                        >
                                            Retry
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}
                    </Step>

                    {/* ── Step 5/6: Reboot & flash ── */}
                    <Step
                        title="Reboot & flash"
                        status={
                            !downloadReady
                                ? "pending"
                                : flashError
                                ? "error"
                                : flashDone
                                ? "done"
                                : "active"
                        }
                        doneSummary={flashDone ? "Firmware installed" : undefined}
                        alwaysChildren={
                            <div className="mt-4 flex flex-col gap-2">
                                {FLASH_STAGES.map(({stage, label}) => {
                                    const {done, active} = flashItemStatus(stage);
                                    return (
                                        <FlashItem key={stage} label={label} done={done} active={active}>
                                            {stage === "program" && flash.programProgress && (
                                                <div className="flex flex-col gap-1">
                                                    <div className="h-1.5 w-full bg-layer-02">
                                                        <div
                                                            className="h-full bg-state-info transition-all"
                                                            style={{
                                                                width: `${Math.round(
                                                                    (flash.programProgress.done /
                                                                        Math.max(1, flash.programProgress.total)) *
                                                                        100,
                                                                )}%`,
                                                            }}
                                                        />
                                                    </div>
                                                    <p className="text-micro text-text-helper">
                                                        {Math.round(
                                                            (flash.programProgress.done /
                                                                Math.max(1, flash.programProgress.total)) *
                                                                100,
                                                        )}%
                                                    </p>
                                                </div>
                                            )}
                                        </FlashItem>
                                    );
                                })}
                                <FlashItem
                                    label="Reconnect"
                                    done={flashDone && !reconnecting}
                                    active={(flash.stage === "reboot" || flashDone) && reconnecting}
                                >
                                    <p className="text-micro text-text-helper">
                                        Waiting for the board to come back up…
                                    </p>
                                </FlashItem>
                                {flashError && flash.error && (
                                    <p className="mt-1 text-label text-state-danger">{flash.error}</p>
                                )}
                            </div>
                        }
                    >
                        <div className="flex flex-col gap-4">
                            <p className="text-micro text-text-helper">
                                Erases the board's current firmware and writes the new build. A board
                                interrupted mid-write will need recovering via its bootloader — don't
                                unplug during this step.
                            </p>
                            {/* Reboot-to-bootloader shortcut when a MAVLink vehicle is active */}
                            {mavlinkConnected && !flashStarted && (
                                <div className="flex flex-col gap-1">
                                    <button
                                        type="button"
                                        disabled={rebooting || !downloadReady}
                                        onClick={() => void handleRebootToBootloader()}
                                        className="h-control-sm w-fit border border-border-subtle px-3 text-label text-text-primary hover:enabled:bg-layer-hover-01 disabled:text-text-disabled"
                                    >
                                        {rebooting
                                            ? "Rebooting…"
                                            : `Reboot ${detectedBoard?.label ?? connectedPort} to bootloader`}
                                    </button>
                                    <p className="text-micro text-text-helper">
                                        Sends a MAVLink reboot command — no need to unplug and replug.
                                    </p>
                                </div>
                            )}

                            {/* Force flag (advanced only) */}
                            {advanced && (
                                <label className="flex items-center gap-2 text-label text-state-warn select-none">
                                    <input
                                        type="checkbox"
                                        checked={force}
                                        onChange={(e) => setForce(e.target.checked)}
                                        className="h-4 w-4"
                                    />
                                    Force — skip board ID check
                                </label>
                            )}

                            {/* Flash button — two-step inline confirm */}
                            {!flashStarted && (
                                <div className="flex flex-col gap-2">
                                    {!confirmingFlash ? (
                                        <button
                                            type="button"
                                            disabled={!downloadReady || !selectedPort || flashing}
                                            onClick={() => setConfirmingFlash(true)}
                                            className="h-control-sm w-fit bg-blue-60 px-4 text-label text-text-on-color hover:enabled:bg-blue-50 disabled:opacity-50"
                                        >
                                            Flash
                                        </button>
                                    ) : (
                                        <div className="flex flex-col gap-2">
                                            <p className="text-label text-state-warn">
                                                This erases the board's current firmware. Are you sure?
                                            </p>
                                            <div className="flex gap-2">
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        setConfirmingFlash(false);
                                                        if (selectedPort && preparedOption) {
                                                            void flash.start(
                                                                selectedPort,
                                                                preparedOption.url,
                                                                force,
                                                            );
                                                        }
                                                    }}
                                                    className="h-control-sm bg-red-60 px-4 text-label text-text-on-color hover:opacity-90"
                                                >
                                                    Erase and write
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => setConfirmingFlash(false)}
                                                    className="h-control-sm border border-border-subtle px-3 text-label text-text-primary hover:bg-layer-hover-01"
                                                >
                                                    Cancel
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                    {!downloadReady && (
                                        <p className="text-micro text-text-helper">
                                            Complete the steps above first.
                                        </p>
                                    )}
                                    {downloadReady && !selectedPort && !mavlinkConnected && (
                                        <p className="text-micro text-text-helper">
                                            No bootloader port selected. Plug in the board or reboot to
                                            bootloader first.
                                        </p>
                                    )}
                                </div>
                            )}
                        </div>
                    </Step>

                    {/* ── Final step: board ready ── */}
                    <Step
                        title="Board ready"
                        status={
                            flashDone && !reconnecting
                                ? "done"
                                : flashDone && reconnecting
                                ? "active"
                                : "pending"
                        }
                        doneSummary="Firmware installed successfully"
                    />
                </div>
            </div>
        </div>
    );
}
