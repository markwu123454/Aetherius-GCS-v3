import {invoke} from "@tauri-apps/api/core";
import {requireBackend} from "@/lib/vehicle/connection.ts";

/** The manifest's own vehicle-type strings — distinct from this app's
 * `VehicleKind`, which is derived from `HEARTBEAT` and only distinguishes
 * "plane" from "multirotor" from "other". */
export type ManifestVehicleType = "Copter" | "Plane";

/** One flashable build from ArduPilot's published catalog, already narrowed
 * server-side (see `flash_fetch_manifest` in `flash.rs`) to `.apj` builds
 * for one vehicle type, each board's current recommended build or its
 * bleeding-edge one — not the full version history. */
export interface FirmwareOption {
    platform: string;
    version: string;
    versionType: string;
    /** The manifest's `mav-type` — `"Copter"`, `"HELICOPTER"`,
     * `"FIXED_WING"`. Every Copter board publishes both a multirotor and a
     * traditional-helicopter build under the same platform, version, *and*
     * `board_id`; this is the only thing that tells them apart, so it has to
     * reach the UI. See `frameLabel`. */
    mavType: string;
    /** USB vendor/product IDs the board for this build enumerates as, as
     * `["0x3162/0x0053", ...]` — see `matchesBoard`. */
    usbid: string[];
    /** The board ID `upload` checks against the bootloader's own report.
     * Shown so an operator can confirm the match themselves. */
    boardId?: number | null;
    url: string;
    manufacturer?: string | null;
    brandName?: string | null;
}

/** ArduPilot's `USBID` spelling for a vendor/product pair: lowercase hex,
 * four digits each, `0xVVVV/0xPPPP`. */
export function usbIdTag(vid: number, pid: number): string {
    const hex = (n: number) => `0x${n.toString(16).toLowerCase().padStart(4, "0")}`;
    return `${hex(vid)}/${hex(pid)}`;
}

/** Whether `option` is a build for the board enumerating as `vid`/`pid`.
 *
 * This is how QGroundControl narrows ~300 boards to the two or three that
 * are actually yours: the manifest tags every `.apj` with the USB IDs its
 * board reports, so a plugged-in board identifies its own firmware. Matching
 * on USB ID rather than the bootloader's `board_id` means it works the
 * moment the board is plugged in, without rebooting it into its bootloader
 * first. */
export function matchesBoard(option: FirmwareOption, vid: number, pid: number): boolean {
    const wanted = usbIdTag(vid, pid);
    // Case-insensitive deliberately: the manifest is inconsistent about hex
    // case. Of the 43 distinct USB IDs it publishes, 16 spell the vendor in
    // uppercase — including `0x2DAE` (CubePilot) and `0x26AC` (PX4/3DR) —
    // while Holybro's `0x3162` is lowercase. An exact compare silently
    // matches nothing for every Cube and every PX4-era board.
    return option.usbid.some((id) => id.toLowerCase() === wanted);
}

/** Human-readable frame class for a `mavType`, for labelling otherwise
 * identical-looking rows. Unknown values pass through rather than being
 * hidden — an unlabelled row is exactly the failure this exists to stop. */
export function frameLabel(mavType: string): string {
    switch (mavType) {
        case "Copter":
            return "Multirotor";
        case "HELICOPTER":
            return "Traditional heli";
        case "FIXED_WING":
            return "Fixed wing";
        default:
            return mavType;
    }
}

export function fetchFirmwareManifest(vehicletype: ManifestVehicleType): Promise<FirmwareOption[]> {
    requireBackend();
    return invoke<FirmwareOption[]>("flash_fetch_manifest", {vehicletype});
}

/** What's actually inside a downloaded `.apj`, read from the file itself —
 * not the manifest's own metadata, which only describes what ArduPilot
 * intended to publish at that URL. */
export interface ApjSummary {
    boardId: number;
    boardRevision: number;
    imageSize: number;
}

/** Downloads and parses one `.apj`, holding it server-side for `startFlash`.
 * Resolves once the file is actually on disk in memory and parsed — the
 * summary is what to show the operator before anything touches a port. */
export function prepareFirmware(url: string): Promise<ApjSummary> {
    requireBackend();
    return invoke<ApjSummary>("flash_prepare", {url});
}

/** Starts flashing the firmware `prepareFirmware` downloaded from `url`.
 * Resolves once the background flash has *started*, not once it's done —
 * progress and the terminal result arrive as `flash-progress`/`flash-result`
 * events (see `useFirmwareFlash`), the same "kick off, then report through
 * events" shape `connect_link` uses elsewhere in this app. `port` is a bare
 * serial port name (`ScannedLink.portName`), not a `serial:PORT:BAUD`
 * MAVLink address — flashing always talks the bootloader's own baud rate.
 *
 * `url` names the build the operator actually confirmed. The backend holds
 * exactly one prepared image and rejects the call if that isn't the one
 * loaded, so an out-of-order `prepareFirmware` can't cause a different
 * board's firmware to be written. Rejects, rather than queueing, if a flash
 * is already running. */
export function startFlash(port: string, url: string, force: boolean): Promise<void> {
    requireBackend();
    return invoke<void>("flash_start", {port, url, force});
}

/** Mirrors the Rust `FlashProgress` enum in `flash.rs` field for field. */
export type FlashProgress =
    | {stage: "waitingForBootloader"}
    | {stage: "identify"}
    | {stage: "erase"}
    | {stage: "program"; done: number; total: number}
    | {stage: "verify"}
    | {stage: "reboot"};

export interface FlashResult {
    ok: boolean;
    message?: string | null;
}
