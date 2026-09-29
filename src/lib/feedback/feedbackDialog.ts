import {useSyncExternalStore} from "react";
import {EMPTY_DRAFT, type FeedbackDraft, type FeedbackKind} from "./feedback.ts";

interface DialogState {
    /** `null` while closed. */
    kind: FeedbackKind | null;
    /** Kept across close/reopen until the report is sent, so an accidental
     * Escape or backdrop click doesn't throw away what was typed. */
    draft: FeedbackDraft;
}

let state: DialogState = {kind: null, draft: EMPTY_DRAFT};
const listeners = new Set<() => void>();

function set(next: DialogState) {
    state = next;
    for (const listener of listeners) listener();
}

/** Opens the one feedback dialog (mounted once in App) — from the Help menu
 * or the About page, which is why it's a store and not local state. */
export function openFeedback(kind: FeedbackKind) {
    set({...state, kind});
}

export function closeFeedback() {
    set({...state, kind: null});
}

export function setFeedbackKind(kind: FeedbackKind) {
    set({...state, kind});
}

export function setFeedbackDraft(draft: FeedbackDraft) {
    set({...state, draft});
}

/** After a report has gone out: close and start the next one empty. */
export function finishFeedback() {
    set({kind: null, draft: EMPTY_DRAFT});
}

export function useFeedbackDialog(): DialogState {
    return useSyncExternalStore(
        (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        () => state,
    );
}
