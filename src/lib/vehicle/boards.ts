import {invoke} from "@tauri-apps/api/core";
import {requireBackend} from "./connection.ts";

/** A board this app has stored anything for — one per `$APPDATA/<uid>/`
 * directory on the backend. Present whether or not it's currently plugged
 * in; matched against a scan's `ScannedLink.candidateUid`. */
export interface KnownBoard {
    uid: string;
    displayName: string | null;
    autoConnect: boolean;
}

export function listKnownBoards(): Promise<KnownBoard[]> {
    requireBackend();
    return invoke<KnownBoard[]>("list_known_boards");
}

interface BoardProfile {
    displayName: string | null;
    autoConnect: boolean;
}

function getBoardProfile(uid: string): Promise<BoardProfile> {
    requireBackend();
    return invoke<BoardProfile>("get_board_profile", {uid});
}

function setBoardProfile(uid: string, profile: BoardProfile): Promise<void> {
    requireBackend();
    return invoke<void>("set_board_profile", {uid, profile});
}

/** Read-modify-write on a single board's profile — callers only supply the
 * field(s) they're changing (a rename, or an auto-connect toggle), not the
 * whole profile, since either one is a small isolated action in the UI and
 * neither should have to know or guess at the other's current value. */
export async function updateBoardProfile(uid: string, patch: Partial<BoardProfile>): Promise<void> {
    const current = await getBoardProfile(uid);
    await setBoardProfile(uid, {...current, ...patch});
}
