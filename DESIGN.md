# Aetherius GCS — Design Notes

## Technology

* Frontend: React
* Desktop runtime: Tauri
* Design system: IBM Carbon Design System
* Scope: ArduPlane and ArduCopter only, windows only, no PX4 or other flight-stack abstraction

---

# Architecture

## Backend / Frontend Split

Authority follows proximity to the wire, not language. The backend decodes
MAVLink and is the sole authority on anything the vehicle can answer; the
frontend renders whatever the backend hands it and holds only local UI state.

### The backend owns

* Wire decoding and unit conversion (volts and degrees, not millivolts and
  degE7).
* Any judgment the vehicle already computes and reports — prearm pass/fail,
  battery charge state, EKF health, mode names resolved against vehicle type.
  These are relayed, never re-derived from thresholds invented in the app.
* Protocol correctness: acks, retries, timeouts, and the generation-counter
  cancellation already used for connect/disconnect. The same mechanism
  extends to every other stateful exchange (parameters, mission, calibration)
  rather than inventing a new one per feature.
* Judgments about the GCS's own transport, since the vehicle has no way to
  know its packets aren't reaching this particular GCS (link liveness:
  connecting / losing / lost).
* Caches for anything vehicle-owned — parameters, mission, logs — fetched
  eagerly the moment a link connects, not lazily when a panel happens to open.
* Pushing state to the frontend as it changes, so the frontend never polls.

### The frontend owns

* Turning an already-resolved value into a label, color, or layout.
* Combining independently-arriving, already-decided severities into one
  displayed judgment (e.g. the worse of vehicle health and link health).
* Local, ephemeral UI state that isn't a claim about the vehicle or the link
  — is a dropdown open, is a drag in progress.
* Optimistic UI, limited strictly to masking the IPC latency of its own
  in-flight request (showing "connecting" the instant Connect is clicked).
  Never a guess at how the vehicle will respond to a command — that always
  waits for the real event.

### Requests vs. commands

* A **request** reads state the backend already owns. No vehicle round-trip
  happens at call time — it's a cache read.
* A **command** asks the backend to write to the vehicle (`COMMAND_LONG`,
  `PARAM_SET`, a mission item) and wait for its ack. The backend updates its
  own cache only after the vehicle confirms, then pushes the update — never
  optimistically.
* Unsolicited changes (another GCS, a failsafe, a script) are treated
  identically to ones the frontend asked for: the backend's cache is
  authoritative regardless of source.

## Backend Module Layout

* `link` — connection lifecycle only: opening/closing the transport, scanning
  for endpoints, the connect/disconnect state machine and its generation-based
  cancellation. Reads off the wire and hands each message to `dispatch`.
* `dispatch` — the single fan-out point `link` calls into for message
  handling. Routes each incoming `MavMessage` to whichever module owns it
  (`telemetry`, `fence`, `mission`, `params`, `logs`, `scripting`) and holds
  the one piece of cross-cutting reassembly logic that doesn't belong to any
  of them (STATUSTEXT chunk coalescing).
* `commands` — the generic `COMMAND_LONG` → `COMMAND_ACK` machinery (send,
  await, timeout, retry). Owns the ack-matching mechanism itself, not the
  meaning of any particular command.
* `vehicle_command` — the enum of actual vehicle actions the frontend can
  ask for (arm, set mode, takeoff, mission start/pause/resume, reboot, motor
  test, calibration start, ...) and their translation to a `COMMAND_LONG`'s
  flat `param1..param7` layout. Built on `commands`.
* `telemetry` — one file per MAVLink message type, each owning exactly the
  snapshot fields that message carries.
* `mission`, `params`, `fence`, `logs` — one module each, holding that
  domain's cache and Tauri commands. Each is currently a single file: a
  module only grows its own directory (as `telemetry`, `firmware`, and
  `scripting` have) once it needs one file per message/action to stay
  readable, not on the assumption it eventually will.
* `firmware` — bootloader handshake and flashing, split across
  `firmware/bootloader.rs` and `firmware/flash.rs`.
* `scripting` — Lua script sync with the vehicle over MAVLink FTP, split
  across `scripting/ftp_protocol.rs`, `scripting/local_fs.rs`, and
  `scripting/vehicle_cache.rs`.

New modules register into `lib.rs` and `dispatch` the same way the ones above
do.

---

# Core Layout

The application is centered around a persistent map workspace.

The map is visible during normal operations, with tools displayed around or above it.

Exceptions:

* Workflows that do not require situational awareness, such as firmware
  flashing, parameter/mission-plan file management, calibration, and vehicle
  setup, use dedicated full-screen pages.
* Workflows that edit a spatial *draft* — the Mission and Geofence editors —
  are also full-screen pages, but they render their own dedicated map
  instance rather than the persistent docked one. Editing a plan that isn't
  uploaded yet shouldn't fight with the live vehicle position on the same
  map, and the full-screen page gives the draft the room a docked panel
  couldn't.

---

# Workspace Model

The application uses dockable panels.

Panels can be:

* Docked
* Floating
* Closed

Dragging a floating panel toward a dock area allows it to snap into place.

---

# Dock Layout Rules

Supported dock areas:

* Left
* Right
* Bottom

The top area is reserved for application-level controls.

Each dock area is exactly one tab group — no sub-splitting into sections.
Multiple panels share that one tab group and are switched by tab, not laid
out side by side within the dock:

```
Right Dock

[Telemetry] [Mission] [Vehicle]
```

The tab group model is similar to applications such as Adobe tools.

Some panels (`Telemetry`, `Manual`) render a different internal layout
depending on which dock area they're in — a stacked column on left/right, a
side-by-side row on bottom — since their own layout is what actually
benefits from the dock's shape, not the docking system itself splitting the
area for them.

Panels reorder by dragging within a dock's tab strip, and move between dock
areas or out to floating by dragging toward the target.

---

# Persistence

The application remembers the previous dock layout automatically.

No named workspace system.

## Docked panels

Persist:

* Position
* Dock location
* Size
* Selected tab

They reopen in the same location after restarting.

## Floating panels

Do not persist across restarts — reopening a panel that was floating when
the app last closed opens it floating fresh near the panel launcher, with no
memory of where it was.

They are treated as temporary windows. Their last size is still remembered
per-panel independent of whether the window itself is currently open, so a
reopened float doesn't reset to a default size even though its position
does.

---

# Navigation

The application should avoid large traditional menus. The app menu is a
compact hamburger dropdown, not a persistent menu bar.

Panels are opened through a panel selection system (the app menu's Panels
list), which also shows which panels are currently open.

Full-screen pages (Settings, Parameters, Mission, Geofence, Scripting,
Calibration, Setup, Firmware, Logs, About) are opened the same way and
replace the workspace entirely until closed, rather than docking.

---

# IBM Carbon Usage

Carbon is used as the visual foundation.

Used for:

* Components
* Styling
* Typography
* Tabs
* Forms
* Tables
* Dialogs
* Notifications

The docking/workspace system is custom and not provided by Carbon.

---

# Carbon Adaptation

Carbon should be adapted for GCS usage:

* Compact layouts
* Higher information density
* Smaller controls where appropriate

Custom aviation widgets should follow Carbon styling but are not standard Carbon components.

Examples:

* HUD
* Attitude indicator
* Compass
* Map overlays 

---

# Design Goals

* Keep the vehicle/map context available during operation.
* Provide access to ArduPilot's advanced functionality.
* Avoid excessive layout complexity.
* Provide flexibility through docking and tabs without unlimited customization.
