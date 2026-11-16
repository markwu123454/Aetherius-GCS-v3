import {useSyncExternalStore} from "react";
import {listen} from "@tauri-apps/api/event";
import {createStore} from "@/lib/store.ts";
import {refreshLiveParams} from "@/lib/params/useLiveParams.ts";
import type {ConnectionStatus} from "@/lib/vehicle/connection.ts";

/**
 * ArduCopter ESC calibration (`ESC_CALIBRATION = 3`, see ArduCopter's
 * `esc_calibration.cpp`) runs at the next boot from battery power, not over
 * MAVLink: ArduPilot clears the parameter, waits for the safety switch,
 * drives every motor at full throttle for 5 s, then holds zero until the
 * board is power-cycled.
 *
 * Those loops wait with `delay(3)`, below the 5 ms threshold at which
 * ArduPilot runs its MAVLink delay callback — so from battery power-up until
 * the next power cycle the vehicle sends nothing, telemetry radio or not.
 * Only the link going silent (power off) and coming back steadily (normal
 * boot) can be observed; every step between is the operator's to tick.
 *
 * Kept in a module store rather than component state: the link is down for
 * most of the procedure, which unmounts the Calibration page's normal view,
 * and the operator may wander off to another page mid-way.
 */
export type EscPhase =
    | "idle"
    | "powerOff"
    | "battery"
    | "safety"
    | "tones"
    | "powerCycle"
    /** Back after the final power cycle — checking board and parameters. */
    | "finished"
    | "normalBoot";

export interface EscMessage {
    at: number;
    severity: number;
    text: string;
}

/** `pending` until a fresh AUTOPILOT_VERSION arrives after the reconnect;
 * `unknown` when either side has no UID to compare (or none arrived). */
export type BoardCheck = "pending" | "same" | "different" | "unknown";

export interface EscCalibrationState {
    phase: EscPhase;
    /** Whether the board starts with its safety switch engaged
     * (`BRD_SAFETY_DEFLT` ≠ 0), read when calibration was turned on. */
    safetyStep: boolean;
    /** STATUSTEXT received since calibration was turned on. */
    messages: EscMessage[];
    boardBefore: string | null;
    boardCheck: BoardCheck;
    /** The live parameter store has been cleared and is re-downloading since
     * the final power-up, so once it's complete its values are post-boot. */
    paramsFresh: boolean;
}

const IDLE: EscCalibrationState = {
    phase: "idle",
    safetyStep: false,
    messages: [],
    boardBefore: null,
    boardCheck: "pending",
    paramsFresh: false,
};

/** How long heartbeats must keep arriving during the battery/safety/tones
 * steps before it counts as a normal boot. ArduPilot does emit a few
 * heartbeats early in boot before it reaches the calibration check, so a
 * brief return of the link is not enough on its own. */
const NORMAL_BOOT_AFTER_MS = 8_000;

/** The backend re-requests AUTOPILOT_VERSION as soon as heartbeats resume;
 * past this, no answer is coming and the board can't be confirmed. */
const BOARD_CHECK_TIMEOUT_MS = 10_000;

/** How long after reconnecting to wait for the shared reboot-triggered
 * parameter reload before asking for one directly — the backend only sees a
 * reboot once a message carrying the boot clock arrives, and a vehicle that
 * was itself only a few seconds into its uptime before calibration may never
 * show its clock going backwards at all. */
const PARAMS_RELOAD_FALLBACK_MS = 6_000;

const MESSAGE_LIMIT = 100;

const store = createStore<EscCalibrationState>(IDLE);

let normalBootTimer: ReturnType<typeof setTimeout> | null = null;
let boardCheckTimer: ReturnType<typeof setTimeout> | null = null;
let paramsFallbackTimer: ReturnType<typeof setTimeout> | null = null;

/** The live parameter store was emptied by the link closing outright (USB
 * unplugged rather than a radio going quiet) since calibration began, so the
 * reconnect re-downloads everything on its own. */
let paramsClearedSinceBegin = false;

/** The connected board's UID as last reported. Read off the backend's
 * `vehicle` snapshot rather than the frontend vehicle state, which
 * deliberately doesn't carry it. */
let currentBoardUid: string | null = null;

/** An AUTOPILOT_VERSION that beat the `connected` link status in during the
 * final power-up — the reply to the backend's request can land first. */
let earlyBoardUid: string | null | undefined;

function clearTimers(): void {
    if (normalBootTimer !== null) clearTimeout(normalBootTimer);
    if (boardCheckTimer !== null) clearTimeout(boardCheckTimer);
    if (paramsFallbackTimer !== null) clearTimeout(paramsFallbackTimer);
    normalBootTimer = null;
    boardCheckTimer = null;
    paramsFallbackTimer = null;
}

function setPhase(phase: EscPhase): void {
    store.update((state) => ({...state, phase}));
}

/** Calibration has been turned on (`ESC_CALIBRATION` confirmed at 3). */
export function beginEscCalibration(safetyStep: boolean): void {
    clearTimers();
    earlyBoardUid = undefined;
    paramsClearedSinceBegin = false;
    store.set({...IDLE, phase: "powerOff", safetyStep, boardBefore: currentBoardUid});
}

/** The operator ticked the current manual step. */
export function confirmEscStep(): void {
    const {phase, safetyStep} = store.getSnapshot();
    if (phase === "battery") setPhase(safetyStep ? "safety" : "tones");
    else if (phase === "safety") setPhase("tones");
    else if (phase === "tones") {
        clearTimers();
        setPhase("powerCycle");
    }
}

function markParamsFresh(): void {
    if (paramsFallbackTimer !== null) clearTimeout(paramsFallbackTimer);
    paramsFallbackTimer = null;
    store.update((state) => (state.paramsFresh ? state : {...state, paramsFresh: true}));
}

export function resetEscCalibration(): void {
    clearTimers();
    store.set(IDLE);
}

function onLinkStatus(status: ConnectionStatus): void {
    const {phase} = store.getSnapshot();
    const connected = status === "connected";

    // Same set of statuses `useLiveParams` clears its values on.
    if (phase !== "idle" && status !== "connected" && status !== "connecting" && status !== "losing") {
        paramsClearedSinceBegin = true;
    }

    if (phase === "powerOff" && !connected) {
        setPhase("battery");
        return;
    }

    if (phase === "battery" || phase === "safety" || phase === "tones") {
        if (!connected) {
            if (normalBootTimer !== null) clearTimeout(normalBootTimer);
            normalBootTimer = null;
        } else if (normalBootTimer === null) {
            normalBootTimer = setTimeout(() => {
                normalBootTimer = null;
                const current = store.getSnapshot().phase;
                if (current === "battery" || current === "safety" || current === "tones") {
                    setPhase("normalBoot");
                }
            }, NORMAL_BOOT_AFTER_MS);
        }
        return;
    }

    if (phase === "powerCycle" && connected) {
        store.update((state) => ({...state, phase: "finished", boardCheck: "pending"}));
        if (paramsClearedSinceBegin) {
            markParamsFresh();
        } else {
            paramsFallbackTimer = setTimeout(() => {
                paramsFallbackTimer = null;
                if (store.getSnapshot().phase !== "finished" || store.getSnapshot().paramsFresh) return;
                refreshLiveParams();
                markParamsFresh();
            }, PARAMS_RELOAD_FALLBACK_MS);
        }
        if (earlyBoardUid !== undefined) {
            onAutopilotVersion(earlyBoardUid);
            return;
        }
        boardCheckTimer = setTimeout(() => {
            boardCheckTimer = null;
            store.update((state) => (state.boardCheck === "pending" ? {...state, boardCheck: "unknown"} : state));
        }, BOARD_CHECK_TIMEOUT_MS);
    }
}

function onAutopilotVersion(boardUid: string | null): void {
    currentBoardUid = boardUid;
    const state = store.getSnapshot();
    if (state.phase === "powerCycle") earlyBoardUid = boardUid;
    if (state.phase !== "finished" || state.boardCheck !== "pending") return;
    if (boardCheckTimer !== null) clearTimeout(boardCheckTimer);
    boardCheckTimer = null;
    const boardCheck: BoardCheck =
        boardUid === null || state.boardBefore === null ? "unknown" : boardUid === state.boardBefore ? "same" : "different";
    store.update((current) => ({...current, boardCheck}));
}

listen<ConnectionStatus>("link-status", (event) => onLinkStatus(event.payload)).catch(() => {});

listen("vehicle-rebooted", () => {
    const {phase} = store.getSnapshot();
    if (phase !== "powerCycle" && phase !== "finished") return;
    // Deferred a tick so `useLiveParams`'s own listener for this event has
    // cleared the old values first — marking fresh before that would let
    // the panel read the pre-boot ESC_CALIBRATION for a render.
    setTimeout(markParamsFresh, 0);
}).catch(() => {});

// Only a fresh AUTOPILOT_VERSION says which board is there now — the
// snapshot below keeps the previous board's UID until one arrives.
listen<{boardUid: string | null}>("autopilot-version", (event) => onAutopilotVersion(event.payload.boardUid)).catch(
    () => {},
);

listen<{boardUid?: string | null}>("vehicle", (event) => {
    // Seeds the UID for a board that was connected before this module loaded;
    // never used to judge the post-reconnect board (see above).
    if (event.payload.boardUid != null && store.getSnapshot().phase !== "finished") {
        currentBoardUid = event.payload.boardUid;
    }
}).catch(() => {});

listen<{severity: number; text: string}>("statustext", (event) => {
    if (store.getSnapshot().phase === "idle") return;
    const message: EscMessage = {at: Date.now(), severity: event.payload.severity, text: event.payload.text};
    store.update((state) => ({...state, messages: [...state.messages, message].slice(-MESSAGE_LIMIT)}));
}).catch(() => {});

export function useEscCalibration(): EscCalibrationState {
    return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/** True while the procedure is under way — the Calibration page keeps the
 * guide on screen through the link drops this involves. */
export function escCalibrationInProgress(state: EscCalibrationState): boolean {
    return state.phase !== "idle";
}
