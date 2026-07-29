import {useEffect, useRef} from "react";
import {listen} from "@tauri-apps/api/event";

/**
 * Subscribes to a Tauri event for the life of the component. The handler is
 * called through a ref rather than being a `useEffect` dependency, so passing
 * a new closure every render does not tear down and re-subscribe — only the
 * event name does that.
 *
 * Silently does nothing outside Tauri (a plain browser tab): there is no
 * backend to subscribe to, so the value simply never arrives.
 */
export function useTauriEvent<T>(event: string, handler: (payload: T) => void): void {
    const handlerRef = useRef(handler);
    handlerRef.current = handler;

    useEffect(() => {
        let disposed = false;
        let unlisten: (() => void) | undefined;

        listen<T>(event, (message) => handlerRef.current(message.payload))
            .then((stop) => (disposed ? stop() : (unlisten = stop)))
            .catch(() => {});

        return () => {
            disposed = true;
            unlisten?.();
        };
    }, [event]);
}
