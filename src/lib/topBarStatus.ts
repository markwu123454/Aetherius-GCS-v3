import {useSyncExternalStore} from "react";
import {createStore} from "@/lib/store.ts";

export type StatusTone = "ok" | "warn" | "danger" | "info";

/** One run of text in a status message — colored by `tone`, plain without. */
export interface StatusSegment {
    text: string;
    tone?: StatusTone;
}

export interface StatusMessage {
    /** Who wrote it. Each source owns one message, replaced on every write. */
    source: string;
    segments: StatusSegment[];
}

const statusStore = createStore<StatusMessage[]>([]);

/**
 * Writes `source`'s message to the text slot in the middle of the top bar,
 * replacing whatever that source wrote before. Messages from different
 * sources sit side by side in the order they first appeared.
 */
export function setStatus(source: string, content: string | StatusSegment[]): void {
    const segments = typeof content === "string" ? [{text: content}] : content;
    statusStore.update((messages) => {
        const index = messages.findIndex((message) => message.source === source);
        if (index === -1) return [...messages, {source, segments}];
        const next = messages.slice();
        next[index] = {source, segments};
        return next;
    });
}

export function clearStatus(source: string): void {
    statusStore.update((messages) =>
        messages.some((message) => message.source === source)
            ? messages.filter((message) => message.source !== source)
            : messages,
    );
}

export function useStatusMessages(): StatusMessage[] {
    return useSyncExternalStore(statusStore.subscribe, statusStore.getSnapshot);
}
