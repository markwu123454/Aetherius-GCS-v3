export interface Store<T> {
    subscribe: (listener: () => void) => () => void;
    getSnapshot: () => T;
    set: (value: T) => void;
    update: (updater: (current: T) => T) => void;
}

/**
 * A module-level store for state that must keep running whether or not any
 * component is mounted to look at it — a shared alternative to hand-rolling
 * `listeners`/`notify`/`snapshot` per store (see `consoleStore.ts`, the
 * pattern this generalizes). Pair with `useSyncExternalStore(store.subscribe,
 * store.getSnapshot)` to read it from React.
 */
export function createStore<T>(initial: T): Store<T> {
    let value = initial;
    const listeners = new Set<() => void>();

    function notify(): void {
        for (const listener of listeners) listener();
    }

    return {
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        getSnapshot() {
            return value;
        },
        set(next) {
            value = next;
            notify();
        },
        update(updater) {
            value = updater(value);
            notify();
        },
    };
}
