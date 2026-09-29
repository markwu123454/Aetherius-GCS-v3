# Roadmap

Not a schedule — just what exists today, and what could plausibly be added
later. Nothing under Potential Features is scoped, prioritized, or promised.

## Features

### Pages

* **Mission** — waypoint editor (waypoint, takeoff, loiter, RTL, land) on its
  own full-screen map; upload to and download from the vehicle; save/load a
  mission plan to a local file; route distance stats in the sidebar.
* **Geofence** — polygon fence editor on its own full-screen map, with
  self-intersection detection; upload to and download from the vehicle.
* **Parameters** — full live parameter sheet grouped by relation tables,
  search, save all read parameters to a file, load a parameter file and
  review a diff against live values before applying.
* **Scripting** — Lua script editor (Monaco) with a file tree, synced to and
  from the vehicle over MAVLink FTP.
* **Calibration** — accelerometer, compass (with a 3D orientation/coverage
  viewport), gyro, and radio calibration.
* **Setup** — frame setup, servo setup, motor test, failsafe setup, trim
  setup.
* **Firmware** — bootloader handshake and firmware flashing.
* **Logs** — list and download dataflash logs off the vehicle over MAVLink
  FTP to local disk.
* **Settings** — connection, display, and panel preferences.
* **About** — version info, update check, link to the repo.

### Panels (dockable)

* **Telemetry** — live vehicle telemetry, laid out differently per dock area.
* **Manual** — joystick input/display and a PFD, laid out differently per
  dock area.
* **RC Override** — floating-only, latch-safe manual RC override.
* **Console** — STATUSTEXT log, with chunked-message reassembly.
* **Prearm** — live prearm check failure reasons.
* **Mission** — flight-status mini panel: mission state, start/pause/resume,
  current waypoint.
* **Servo Outputs** — live per-channel servo output values.
* **Checklist** — custom checklists with condition-based auto-checking,
  import/export to file.

### Core / Infrastructure

* Dockable + floating panel workspace (left/right/bottom docks, tab groups,
  drag to reorder/retarget), persisted across restarts.
* Persistent map (vehicle track, airspace class overlays) shared by normal
  operation; Mission/Geofence get their own dedicated map instance instead.
* MAVLink dispatch/telemetry decode, `COMMAND_LONG` ack/retry machinery,
  generation-based connect/disconnect/reconnect.
* Mock vehicle mode for development without live hardware.
* Auto-update check.

## Potential Features

### Camera / Video *(new panel)*
* Camera control.
* Gimbal control.
* Video streaming (FPV). Implementation note: don't route frames through
  Tauri's own IPC/event channel — spawn a proven relay as a sidecar (e.g.
  `mediamtx`) that re-serves the vehicle's downlink as WebRTC/WHEP, and have
  the frontend render it into a plain `<video>` element so the browser's own
  hardware decoder does the 1080p60 work.

### Mission
* Rally points.
* Mission item types beyond the current set — jump/repeat, spline waypoints.
* `DO_CHANGE_SPEED` interleaving in the upload path (the draft model already
  carries a per-waypoint speed override; only the upload side doesn't use it
  yet).
* ETA alongside the existing distance stat.

### Logs
* Log analysis: charting, map replay, an auto-diagnosis pass (the listing
  and download half is done; analysis is explicitly a later phase).

### Top Bar
* Takeoff button — a Guided climb-to-altitude command. The backend command
  enum already has a `Takeoff` variant; nothing in the top bar calls it yet.
  (RTL and Land were considered and dropped: both are, functionally, exactly
  the RTL/LAND mode switch already available from the mode dropdown.)

### Map / Workspace
* Click-to-fly / goto-point-on-map in Guided mode — also covers landing at a
  chosen point, which was the only thing a dedicated Land button would have
  added over the mode dropdown.

### Core / Infrastructure
* Multi-vehicle / swarm support.
* Optional hardware / node list — what's attached to the vehicle beyond the
  flight controller (e.g. CAN/DroneCAN nodes, peripherals). Not designed yet;
  needs thinking through before scoping.

## Known Issues

* **Reboot didn't fully reboot / did nothing from the Compass page.** Fixed,
  not yet tested on hardware. Causes were: the ack was never checked (a
  refused or lost reboot still showed a reboot-and-reconnect), the armed
  override was never sent, the reconnect gave up once the port opened, and
  page reboot buttons were silent no-ops because only the top bar's
  `useConnection` copy knew the endpoint. The calibration pages also now
  reset when the link reboots or drops.
* **Every `useConnection()` call was a separate copy of the connection
  state** — each ran its own scan timer, auto-connect and muted list, so a
  board disconnected from the top bar could be auto-connected again by
  another copy. Fixed, not yet tested on hardware: the backend link manager
  (link.rs) now owns scanning, auto-connect, muting, endpoint and errors and
  publishes one `link-state` snapshot; `useConnection()` just reads it.
