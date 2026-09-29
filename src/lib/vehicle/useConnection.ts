import {useCallback, useEffect, useRef, useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {useTauriEvent} from "@/lib/tauriEvent.ts";
import {ConnectionStatus, loadHistory, rebootVehicle, saveHistory, scanLinks, ScannedLink, withAttempt, withoutAttempt} from "./connection.ts";
import {KnownBoard, listKnownBoards, updateBoardProfile} from "./boards.ts";

/** How often the background scan re-runs while disconnected — the same
 * cadence `ConnectControl` used to run itself only while its dropdown was
 * open; scanning now needs to keep going with the dropdown closed too, so a
 * board saved with auto-connect is noticed as soon as it's plugged in, not
 * just the next time someone opens the dropdown. */
const SCAN_INTERVAL_MS = 3_000;

export interface Connection {
    /** The address currently typed into the connect field, not yet submitted. */
    draft: string;
    setDraft: (value: string) => void;
    /** Recently attempted addresses, most recent first — deeper than what's shown. */
    history: string[];
    removeFromHistory: (endpoint: string) => void;
    /** Endpoints found by the last scan, in whatever order the backend returned them. */
    available: ScannedLink[];
    /** Re-runs the scan on demand (e.g. the dropdown opening) — the same
     * scan also runs on its own timer whenever disconnected, so this exists
     * for "make it fresh right now" rather than being the only trigger. */
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

/**
 * Reflects the link. It does not decide anything about it — except one
 * thing it does decide entirely on this side: whether to auto-connect a
 * saved board. That's a local preference about this app's own behavior, not
 * a fact about the vehicle or the link, so unlike everything else here it
 * doesn't wait on the backend to tell it what to do.
 */
export function useConnection(): Connection {
    const [history, setHistory] = useState<string[]>(loadHistory);
    const [draft, setDraftState] = useState<string>(() => history[0] ?? "");
    const [available, setAvailable] = useState<ScannedLink[]>([]);
    const [status, setStatus] = useState<ConnectionStatus>("disconnected");
    const [endpoint, setEndpoint] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [knownBoards, setKnownBoards] = useState<KnownBoard[]>([]);

    useEffect(() => {
        saveHistory(history);
    }, [history]);

    // A component can mount well after the link already changed state — this
    // hook's own default of "disconnected" is only a placeholder until the
    // *next* transition, since `link-status` is an event, not a subscribable
    // current value. This fills in whatever is already true instead of
    // assuming nothing has happened yet.
    useEffect(() => {
        invoke<ConnectionStatus | null>("link_status")
            .then((current) => {
                if (current) {
                    setStatus(current);
                }
            })
            .catch(() => {});
    }, []);

    const scan = useCallback(async () => {
        try {
            setAvailable(await scanLinks());
        } catch {
            // No backend, or the probe itself failed — either way, nothing found.
            setAvailable([]);
        }
    }, []);

    const refreshKnownBoards = useCallback(async () => {
        try {
            setKnownBoards(await listKnownBoards());
        } catch {
            setKnownBoards([]);
        }
    }, []);

    useEffect(() => {
        void refreshKnownBoards();
    }, [refreshKnownBoards]);

    // Background scan, independent of any panel being open — the only way a
    // board plugged in later (not just one already there at launch) gets
    // noticed for auto-connect without the operator opening the dropdown
    // first. Only runs while cleanly disconnected: a live/tearing-down link
    // shouldn't have a port it might be using probed out from under it, and
    // "lost"/"error" are states where something was already tried and didn't
    // work — auto-connecting again there would be fighting whatever the
    // operator is looking at, not helping it.
    useEffect(() => {
        if (status !== "disconnected") {
            return;
        }
        void scan();
        const interval = window.setInterval(() => void scan(), SCAN_INTERVAL_MS);
        return () => window.clearInterval(interval);
    }, [status, scan]);

    useTauriEvent<ConnectionStatus>("link-status", setStatus);

    const setDraft = useCallback((value: string) => {
        setDraftState(value);
    }, []);

    const removeFromHistory = useCallback((address: string) => {
        setHistory((prev) => withoutAttempt(prev, address));
    }, []);

    // Mirrors `available` for `connect`/`disconnect` below, which need
    // whatever the latest scan found without taking on `available` as a
    // dependency — same reasoning as the `xRef` mirrors in `useFence`/`useRally`.
    const availableRef = useRef<ScannedLink[]>([]);
    useEffect(() => {
        availableRef.current = available;
    }, [available]);

    // The identity (address + candidate UID, if any) of whatever's
    // currently connected or being connected to — set in `connect`, read
    // back in `disconnect` to know what to mute. `null` whenever nothing is
    // live.
    const connectedIdentityRef = useRef<{address: string; candidateUid?: string} | null>(null);

    // UIDs (or bare addresses, for entries with no derivable UID) the
    // operator has manually disconnected this session — excluded from
    // auto-connect until either they connect that exact board again by hand
    // (see `connect` below) or the app restarts. Without this, a board
    // saved with auto-connect that the operator deliberately disconnects
    // would just reconnect itself on the very next scan tick.
    const mutedRef = useRef<Set<string>>(new Set());

    // Guards against the auto-connect effect below firing a second time
    // while its own `connect()` call is still in flight — `status` doesn't
    // leave "disconnected" until the backend's first `link-status` event
    // arrives, which is a real round trip, not instant.
    const autoConnectingRef = useRef(false);

    // `connect_link` hands the blocking open to a worker thread and returns
    // before it finishes, so a transport that can't be opened is reported
    // here rather than by rejecting that invoke. It always arrives alongside
    // the `error` status, so this only supplies the text.
    useTauriEvent<string>("link-error", (text) => {
        setError(text);
        connectedIdentityRef.current = null;
    });

    const connect = useCallback(async (explicitAddress?: string) => {
        setError(null);

        const address = (explicitAddress ?? draft).trim();
        if (!address) {
            setError("Enter an address to connect to.");
            return;
        }

        const matched = availableRef.current.find((entry) => entry.address === address);
        const identityKey = matched?.candidateUid ?? address;
        // A deliberate connect — auto-triggered or by hand, both reach here
        // — is exactly the signal that un-suppresses this board.
        mutedRef.current.delete(identityKey);
        connectedIdentityRef.current = {address, candidateUid: matched?.candidateUid};

        setEndpoint(address);
        setHistory((prev) => withAttempt(prev, address));

        // Show the status the backend is about to publish, so the button reacts
        // to the click rather than to the IPC round trip. This is a cache of an
        // imminent value, not a second opinion — the next `link-status` event
        // overwrites it either way, including with `error`.
        setStatus("connecting");

        try {
            // Resolves once the attempt is handed to a worker thread, not
            // once it succeeds — so this only catches the call itself failing
            // (no backend). Failing to open the transport arrives as
            // `link-error` above.
            await invoke("connect_link", {endpoint: address});
        } catch (cause) {
            setError(message(cause));
            connectedIdentityRef.current = null;
        }
    }, [draft]);

    const disconnect = useCallback(async () => {
        // Same reasoning: covers the round trip, and is superseded on arrival.
        setStatus("disconnecting");

        const identity = connectedIdentityRef.current;
        if (identity) {
            mutedRef.current.add(identity.candidateUid ?? identity.address);
        }

        try {
            await invoke("disconnect_link");
        } catch (cause) {
            setError(message(cause));
        } finally {
            setEndpoint(null);
            connectedIdentityRef.current = null;
        }
    }, []);

    // The one piece of behavior this hook decides on its own rather than
    // just reflecting: connect to a saved auto-connect board the moment it's
    // both scanned and disconnected. Ambiguous (more than one auto-connect
    // board plugged in at once) does nothing rather than guess which one the
    // operator meant — same reasoning `identify_usb_board` on the backend
    // uses for an unrecognized VID/PID: a wrong guess that looks like a real
    // choice is worse than no choice at all.
    useEffect(() => {
        if (status !== "disconnected" || autoConnectingRef.current) {
            return;
        }
        const candidates = available.filter((entry) => {
            if (!entry.candidateUid || mutedRef.current.has(entry.candidateUid)) {
                return false;
            }
            return knownBoards.some((board) => board.uid === entry.candidateUid && board.autoConnect);
        });
        if (candidates.length !== 1) {
            return;
        }
        autoConnectingRef.current = true;
        void connect(candidates[0]!.address).finally(() => {
            autoConnectingRef.current = false;
        });
    }, [available, knownBoards, status, connect]);

    // No optimistic "rebooting" here, unlike connect: until the vehicle
    // accepts, nothing is rebooting, and the backend publishes the status the
    // moment it does.
    const reboot = useCallback(async (force = false) => {
        setError(null);
        try {
            await rebootVehicle(force);
        } catch (cause) {
            setError(message(cause));
        }
    }, []);

    const saveBoard = useCallback(async (uid: string, patch: {displayName?: string | null; autoConnect?: boolean}) => {
        // Toggling auto-connect on for a board already muted from an earlier
        // manual disconnect this session should take effect now, not stay
        // silently suppressed until the next restart.
        if (patch.autoConnect) {
            mutedRef.current.delete(uid);
        }
        await updateBoardProfile(uid, patch);
        await refreshKnownBoards();
    }, [refreshKnownBoards]);

    return {
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
    };
}
