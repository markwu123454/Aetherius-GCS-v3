import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {createStore} from "@/lib/store.ts";
import type {CliPermissions} from "@/lib/settings/settings.ts";

/**
 * The CLI panel's view of `aetherius-cli` requests. The backend owns every
 * record (`src-tauri/src/cli/requests.rs`) and pushes the whole record on
 * each change as `cli-activity`; this store just keeps the latest copy of
 * each, so the panel can be opened at any time and still show what
 * happened before.
 */

export type RequestState =
    | "running"
    | "waiting"
    | "held"
    | "done"
    | "failed"
    | "rejected"
    | "blocked"
    | "expired"
    | "stopped"
    | "cancelled";

export interface CliResultBody {
    ok: boolean;
    data: unknown;
    error: {code: string; message: string; reason?: string} | null;
}

export interface CliRecord {
    id: string;
    command: string;
    argv: string;
    folder: string;
    process: string[];
    category: string;
    state: RequestState;
    reason: string | null;
    startedAt: number;
    endedAt: number | null;
    approval: Record<string, unknown> | null;
    progress: Record<string, unknown> | null;
    items: Record<string, unknown>[];
    result: CliResultBody | null;
    /** Extra only the panel draws (a full spectrum behind fft's peaks). */
    view: Record<string, unknown> | null;
    utcOffsetMinutes: number;
}

export interface CliStatus {
    enabled: boolean;
    listening: boolean;
    port: number | null;
    paused: boolean;
    error: string | null;
}

export function isFinished(state: RequestState): boolean {
    return !["running", "waiting", "held"].includes(state);
}

interface CliStoreState {
    records: Map<string, CliRecord>;
    status: CliStatus;
}

const store = createStore<CliStoreState>({
    records: new Map(),
    status: {enabled: false, listening: false, port: null, paused: false, error: null},
});

export const cliStore = store;

function upsert(record: CliRecord): void {
    store.update((s) => ({...s, records: new Map(s.records).set(record.id, record)}));
}

// Module-level, like the console's: requests keep arriving whether or not
// the panel is open.
listen<CliRecord>("cli-activity", (event) => upsert(event.payload)).catch(() => {});
listen<CliStatus>("cli-status", (event) => store.update((s) => ({...s, status: event.payload}))).catch(() => {});
listen("cli-cleared", () => {
    store.update((s) => ({
        ...s,
        records: new Map([...s.records].filter(([, r]) => !isFinished(r.state))),
    }));
}).catch(() => {});

/** Loads every request so far — what happened before the panel opened. */
export async function loadCliRequests(): Promise<void> {
    try {
        const [records, status] = await Promise.all([
            invoke<CliRecord[]>("cli_requests"),
            invoke<CliStatus>("cli_status"),
        ]);
        store.update((s) => {
            const next = new Map(s.records);
            for (const r of records) next.set(r.id, r);
            return {records: next, status};
        });
    } catch {
        // No backend in a plain browser tab.
    }
}

export function applyCliSettings(enabled: boolean, permissions: CliPermissions, historyDays: number): Promise<CliStatus> {
    return invoke<CliStatus>("set_cli_settings", {settings: {enabled, permissions, historyDays}});
}

export function resolveRequest(id: string, approve: boolean): Promise<void> {
    return invoke("cli_resolve", {id, approve});
}

export function stopRequest(id: string): Promise<void> {
    return invoke("cli_stop", {id});
}

export function setCliPaused(paused: boolean): Promise<void> {
    return invoke("cli_set_paused", {paused});
}

export function clearCliRequests(): Promise<void> {
    return invoke("cli_clear");
}

export function cliHistoryDir(): Promise<string> {
    return invoke<string>("cli_history_dir");
}
