# Aetherius GCS

A ground control station for ArduPilot, built with Tauri and React.

See [DESIGN.md](DESIGN.md) for architecture and design notes, and [ROADMAP.md](ROADMAP.md) for planned features.

## Features

* **Persistent map workspace** — a MapLibre-based map stays visible during normal operations, with panels docked or floating around it.
* **Dockable panel workspace** — panels can be docked (left/right/bottom), floated, tabbed, or closed, with layout persisted across restarts.
* **Vehicle connection** — connect over serial/UDP/TCP MAVLink links, with a mock vehicle mode for UI development without hardware.
* **Telemetry** — live vehicle telemetry (attitude, battery, GPS, EKF status, etc.) decoded and pushed from the backend.
* **Prearm status** — relays the vehicle's own prearm check results rather than re-deriving them in the frontend.
* **Mission planning** — upload, download, and edit ArduPilot missions using the MAVLink mission protocol.
* **Parameters** — read and write vehicle parameters.
* **Scripting** — manage and upload Lua scripts to the vehicle over MAVLink FTP.
* **Airspace overlays** — airspace data rendered on the map.
* **Console** — a live log/console view of link and vehicle activity.
* **Settings** — application and connection configuration.

## Development

```bash
npm install
npm run tauri dev
```
