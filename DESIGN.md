# Aetherius GCS — Design Notes

## Technology

* Frontend: React
* Desktop runtime: Tauri
* Design system: IBM Carbon Design System
* Target: ArduPilot only, no PX4 or other flight-stack abstraction

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
  cancellation.
* `telemetry` — one file per MAVLink message type, each owning exactly the
  snapshot fields that message carries. `telemetry::apply()` is the only
  thing `link` calls into for message handling.
* Future modules (`mission`, `params`, `calibration`) follow the same shape:
  their own directory, a module root holding shared state and Tauri commands,
  one file per message/action inside, registered into `lib.rs` the same way
  `link` is today.

---

# Core Layout

The application is centered around a persistent map workspace.

The map is visible during normal operations, with tools displayed around or above it.

Exceptions:

* Workflows that do not require situational awareness, such as firmware flashing, can use dedicated full-screen pages or workflows.

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

## Left and Right docks

* Vertical splitting only
* Maximum of three sections:

    * Upper
    * Middle
    * Lower

Example:

```
+-------------+
| Upper       |
+-------------+
| Middle      |
+-------------+
| Lower       |
+-------------+
```

No horizontal splitting.

---

## Bottom dock

* Horizontal splitting only
* Maximum of three sections

Example:

```
+-----------+-----------+-----------+
| Panel 1   | Panel 2   | Panel 3   |
+-----------+-----------+-----------+
```

No vertical splitting.

---

# Tabs

Each dock section contains a tab group.

Multiple panels can share the same dock section.

Example:

```
Right Dock

[Telemetry] [Mission] [Vehicle]
```

The tab group model is similar to applications such as Adobe tools.

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

Do not persist across restarts.

They are treated as temporary windows.

---

# Navigation

The application should avoid large traditional menus.

Panels are opened through a panel selection system.

A panel can have its own tab group inside a dock area.

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
