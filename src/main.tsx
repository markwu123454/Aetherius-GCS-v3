import React from "react";
import ReactDOM from "react-dom/client";

async function start() {
    // `?mock` in a dev build swaps the Tauri backend for canned data (see
    // `dev/mockBackend.ts`). It has to be installed before `App`'s modules
    // evaluate, since several of them subscribe to backend events on import —
    // hence `App` being imported dynamically after it.
    if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("mock")) {
        await import("./dev/mockBackend.ts");
    }
    const {default: App} = await import("./App");
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
        <React.StrictMode>
            <App/>
        </React.StrictMode>,
    );
}

void start();
