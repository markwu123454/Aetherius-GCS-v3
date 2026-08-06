# Aetherius GCS

A **Windows** ground control station for **ArduPlane** and **ArduCopter**, built with [Tauri](https://tauri.app) (Rust) and React.

> **Screenshot placeholder** — see the [screenshot instructions](#screenshot) below if you want to drop one in here.

---

## Features

### Connection & Link Management
- **Serial, UDP, and TCP** MAVLink connections
- Auto-scans USB ports and recognises known ArduPilot boards (Pixhawk, SiK radios, RTK GPS receivers) by VID/PID
- SITL auto-detection for development without hardware
- Watchdog-backed link with graceful reconnect on drop; vehicle reboot with automatic reconnection

### Telemetry
Live vehicle state decoded from MAVLink and pushed to the UI at a configurable rate (1–20 Hz):
- Arm state, flight mode, GPS fix, battery, attitude, EKF status, vibration
- RSSI and packet-loss percentage, groundspeed, airspeed, climb rate
- Wind, nav cross-track error, waypoint distance

### Persistent Map Workspace
- **MapLibre GL** map stays visible throughout — panels dock or float around it, never replace it
- Animated vehicle marker (smooth 60 fps interpolation) that changes shape by vehicle type
- Vehicle track lines: grey for taxi (disarmed), blue for flight (armed)
- "Follow vehicle" mode with automatic centre-on-first-fix
- **US airspace overlays** — Class B/C/D/E polygons rendered from FAA shapefiles, per-class colour customisation

### Dockable Panel Workspace
Panels can be docked (left / right / bottom), floated, tabbed, resized, or closed. Layout is persisted across restarts.

| Panel | Description |
|---|---|
| **Telemetry** | Stat rows with optional sparklines; adapts for side vs bottom dock |
| **Console** | Live log/event feed with line coalescing (`×N` repeats) |
| **Prearm** | Vehicle prearm check results from ArduPilot, auto-refreshed |
| **Manual** | SVG primary flight display (attitude, heading) + RC channel bars |
| **RC Override** | RC channel override; floats only (never backgrounded while active) |
| **Mission** | Mission route overlay on the map |

### Full-Screen Pages

| Page | Description |
|---|---|
| **Mission** | Upload and edit ArduPilot missions; numbered waypoints on the map |
| **Parameters** | Read and write vehicle parameters |
| **Scripting** | Dual-pane file manager (local ↔ vehicle FTP) with Monaco editor for Lua scripts |
| **Firmware** | Fetch the ArduPilot manifest, match to the connected board, flash via bootloader |
| **Logs** | Dataflash log download over MAVLink FTP |
| **Settings** | Display mode, telemetry rate, airspace, sparklines, confirmation dialogs |
| **About** | Version info and manual update check |

### Auto-Update
Checks GitHub Releases on launch via `tauri-plugin-updater` and prompts once per session.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop runtime | [Tauri v2](https://tauri.app) (Rust + WebView2) |
| MAVLink | [`mavlink` crate](https://docs.rs/mavlink) — ArduPilot Mega dialect |
| Serial I/O | [`serialport`](https://docs.rs/serialport) |
| Async runtime | [Tokio](https://tokio.rs) |
| Frontend framework | [React 19](https://react.dev) (TypeScript) |
| Build tool | [Vite 8](https://vitejs.dev) |
| Styling | [Tailwind CSS v4](https://tailwindcss.com), IBM Carbon design tokens |
| Icons | [`@carbon/icons-react`](https://carbondesignsystem.com/elements/icons/library/) |
| Map | [MapLibre GL 6](https://maplibre.org) |
| Code editor | [Monaco Editor](https://microsoft.github.io/monaco-editor/) |
| Persistent settings | [`tauri-plugin-store`](https://github.com/tauri-apps/tauri-plugin-store) |

---

## Prerequisites

- **Node.js** 20+ and **npm**
- **Rust** toolchain (stable) — install via [rustup](https://rustup.rs)
- **Tauri prerequisites** — see the [Tauri v2 Windows setup guide](https://v2.tauri.app/start/prerequisites/); requires Visual Studio C++ build tools and WebView2 (pre-installed on Windows 11)

---

## Development

```bash
npm install
npm run tauri dev
```

This starts the Vite dev server on `localhost:1420` and the Tauri Rust backend together with hot-reload for the frontend.

**Frontend only** (no Tauri backend, useful for UI work in a browser):
```bash
npm run dev
```

---

## Building for Release

```bash
npm run tauri build
```

Produces a platform installer under `src-tauri/target/release/bundle/`. The Rust release profile uses LTO, `opt-level = 3`, and binary stripping.

**Keep package.json and Cargo.toml versions in sync:**
```bash
npm run sync-version
```

---

## Airspace Data

US airspace overlays are pre-built from FAA shapefiles and committed to `public/`. To rebuild from source shapefiles (not normally needed):

```bash
npm run build:airspace
```

---

## Project Structure

```
src/                  React frontend
  components/         Top bar, connect control, arm/mode controls
  panels/             Dockable panels (telemetry, console, prearm, manual, mission)
  pages/              Full-screen pages (mission, params, scripting, firmware, logs…)
  lib/                State, hooks, business logic (vehicle, workspace, map, settings…)
src-tauri/src/        Rust backend
  link.rs             Connection lifecycle, USB scan, MAVLink read loop, watchdog
  dispatch.rs         MAVLink message routing
  telemetry/          VehicleSnapshot and per-message telemetry handlers
  mission.rs          Mission upload (MAVLink mission protocol)
  params.rs           Parameter read/write
  scripting/          MAVLink FTP for Lua scripts
  firmware/           Manifest fetch + bootloader flashing
  logs.rs             Dataflash log download
scripts/              Build utilities (airspace, version sync)
public/               Static assets and pre-built airspace GeoJSON
```

---

```md
![Aetherius GCS](docs/screenshot.png)
```

---

## Related Docs

- [DESIGN.md](DESIGN.md) — architecture notes and design decisions
