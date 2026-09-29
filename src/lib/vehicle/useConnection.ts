import {useCallback, useState, useSyncExternalStore} from "react";
import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {ConnectionStatus, loadHistory, rebootVehicle, saveHistory, ScannedLink, withAttempt, withoutAttempt} from "./connection.ts";
import {KnownBoard, listKnownBoards, updateBoardProfile} from "./boards.ts";

export interface Connection {
    /** The address currently typed into the connect field, not yet submitted. */
    draft: string;
    setDraft: (value: string) => void;
    /** Recently attempted addresses, most recent first — deeper than what's shown. */
    history: string[];
    removeFromHistory: (endpoint: string) => void;
    /** Endpoints found by the backend's last scan. */
    available: ScannedLink[];
    /** Asks the backend to rescan now (e.g. the dropdown opening). It also
     * scans on its own every few seconds while disconnected, so this is
     * "make it fresh right now", not the only trigger. */
    scan: () => Promise<void>;
    status: ConnectionStatus;
    /** The address the transport was asked to open. */
    endpoint: string | null;
    error: string | null;
    /** Connects to `address`, or to the current `draft` if omitted — the
     * override exists for callers reconnecting to a known-good endpoint
     * (e.g. after a reboot) without disturbing whatever the operator has
     * since typed into the address field. */
    connect: (address?: string) => Promise<void>;
    disconnect: () => Promise<void>;
    /** Reboots the vehicle (see `rebootVehicle`). Status only moves to
     *  "rebooting" once the vehicle accepts; a refusal or no answer lands in
     *  `error` instead and the link stays up. `force` is the armed override. */
    reboot: (force?: boolean) => Promise<void>;
    /** Boards this app has ever stored anything for, however scan_links's
     * `candidateUid` (or the vehicle's own real `board_uid` after a first
     * connect) matches them up — display name and auto-connect preference. */
    knownBoards: KnownBoard[];
    /** Renames a board and/or flips its auto-connect flag. Only the fields
     * passed are changed. */
    saveBoard: (uid: string, patch: {displayName?: string | null; autoConnect?: boolean}) => Promise<void>;
}

function message(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return typeof error === "string" ? error : "Connection failed";
}

/** The backend's `link-state` snapshot (`LinkSnapshot` in link.rs). */
interface LinkSnapshot {
    status: ConnectionStatus;
    endpoint: string | null;
    error: string | null;
    available: ScannedLink[];
}

interface Shared {
    link: LinkSnapshot;
    /** An error from this side — an empty address, or no backend — shown
     * until the next action. The backend's own `error` covers the rest. */
    localError: string | null;
    history: string[];
    knownBoards: KnownBoard[];
}

/*
 * One store for the whole app, fed by the backend. The backend's link
 * manager (link.rs) owns everything about the link — scanning, auto-connect,
 * which boards the operator disconnected, the last error — and publishes it
 * as one `link-state` snapshot. This only mirrors it and forwards intents.
 *
 * It used to be per-hook state, so each of the ~18 components calling
 * `useConnection()` ran its own scan timer and auto-connect with its own
 * idea of which boards were muted.
 */
let shared: Shared = {
    link: {status: "disconnected", endpoint: null, error: null, available: []},
    localError: null,
    history: loadHistory(),
    knownBoards: [],
};
const listeners = new Set<() => void>();
let started = false;

function update(patch: Partial<Shared>) {
    shared = {...shared, ...patch};
    for (const listener of listeners) listener();
}

async function refreshKnownBoards() {
    try {
        update({knownBoards: await listKnownBoards()});
    } catch {
        update({knownBoards: []});
    }
}

function applyLink(link: LinkSnapshot) {
    const patch: Partial<Shared> = {link};
    // Every connect lands in the recent list, whether typed, picked, or the
    // backend's own auto-connect — they all show up here as a new endpoint.
    if (link.endpoint && link.endpoint !== shared.link.endpoint) {
        patch.history = withAttempt(shared.history, link.endpoint);
        saveHistory(patch.history);
    }
    // A board connected for the first time gets a profile directory, so the
    // known list can grow on connect.
    if (link.status === "connected" && shared.link.status !== "connected") {
        void refreshKnownBoards();
    }
    update(patch);
}

function start() {
    if (started) return;
    started = true;
    listen<LinkSnapshot>("link-state", (event) => applyLink(event.payload)).catch(() => {
        // No Tauri backend (plain browser dev) — stays "disconnected".
    });
    // Fills in whatever is already true for a store created after the last
    // event, rather than assuming nothing has happened yet.
    invoke<LinkSnapshot>("link_state").then(applyLink).catch(() => {});
    void refreshKnownBoards();
}

function subscribe(listener: () => void) {
    start();
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function getSnapshot() {
    return shared;
}

async function connect(address: string) {
    const trimmed = address.trim();
    if (!trimmed) {
        update({localError: "Enter an address to connect to."});
        return;
    }
    update({localError: null});
    try {
        // Resolves once the attempt is handed to the backend's worker, not
        // once it succeeds — the outcome arrives in the next snapshot.
        await invoke("connect_link", {endpoint: trimmed});
    } catch (cause) {
        update({localError: message(cause)});
    }
}

async function disconnect() {
    update({localError: null});
    try {
        await invoke("disconnect_link");
    } catch (cause) {
        update({localError: message(cause)});
    }
}

async function reboot(force = false) {
    update({localError: null});
    try {
        await rebootVehicle(force);
    } catch {
        // The backend puts the reason in the snapshot's `error`.
    }
}

async function scan() {
    try {
        await invoke("refresh_links");
    } catch {
        // No backend, or the scan itself failed — the snapshot stays as it was.
    }
}

function removeFromHistory(address: string) {
    const history = withoutAttempt(shared.history, address);
    saveHistory(history);
    update({history});
}

async function saveBoard(uid: string, patch: {displayName?: string | null; autoConnect?: boolean}) {
    // The backend un-mutes the board when auto-connect is turned on.
    await updateBoardProfile(uid, patch);
    await refreshKnownBoards();
}

/**
 * The link as the backend reports it, plus the actions an operator can take
 * on it. Decides nothing itself: scanning, auto-connect and muting all
 * happen in the backend (link.rs). Only the address being typed is local to
 * each caller.
 */
export function useConnection(): Connection {
    const state = useSyncExternalStore(subscribe, getSnapshot);
    const [draft, setDraft] = useState<string>(() => shared.history[0] ?? "");

    const connectTo = useCallback((address?: string) => connect(address ?? draft), [draft]);

    return {
        draft,
        setDraft,
        history: state.history,
        removeFromHistory,
        available: state.link.available,
        scan,
        status: state.link.status,
        endpoint: state.link.endpoint,
        error: state.localError ?? state.link.error,
        connect: connectTo,
        disconnect,
        reboot,
        knownBoards: state.knownBoards,
        saveBoard,
    };
}
