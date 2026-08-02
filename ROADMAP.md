# Roadmap

Ideas for what to build next — not commitments, not scoped, no promised order.
Grouped by where each feature would live: a full-screen **Page** (like
Parameters/Mission/Scripting/Settings today), a dockable **Panel** (like
Telemetry/Console/Prearm), or **Other** (top bar, map, app-wide behavior).

## Page

### Vehicle Setup *(new page)*
* Sensor calibration (accelerometer, compass, radio, ESC) — flagged as a
  planned backend module in `CLAUDE.md`'s design notes.
* Firmware flashing.
* Motor test.

### Mission *(existing page)*
* Save/load a mission to a file.
* Download the mission already on the vehicle into the editor (upload-only
  today).
* Geofence editing.
* Rally points.
* Mission item types beyond a plain waypoint — loiter, RTL-as-item,
  jump/repeat.
* Mission preview stats (distance, ETA) in the editor sidebar.

### Logs *(new page)*
* Dataflash log download over MAVLink FTP — no log support exists anywhere
  in the codebase yet.
* Log analysis / graphing.

### Parameters *(existing page)*
* Save/load a parameter set to a file.

### Parameter Compare *(new page)*
* Export/import parameter sets.
* Diff live values against a saved file.
* Split out from the Parameters page rather than crammed in — that page is
  already dense.

## Panel

### Camera / Video *(new panel)*
* Camera control.
* Gimbal control.
* Video streaming (FPV). Implementation note: don't route frames through
  Tauri's own IPC/event channel — spawn a proven relay as a sidecar (e.g.
  `mediamtx`) that re-serves the vehicle's downlink as WebRTC/WHEP, and have
  the frontend render it into a plain `<video>` element so the browser's own
  hardware decoder does the 1080p60 work.

## Other

### Top Bar
* Takeoff button — a Guided climb-to-altitude command. The one vehicle
  action with no equivalent mode switch (RTL and Land were considered and
  dropped: both are, functionally, exactly the RTL/LAND mode switch already
  available from the mode dropdown).

### Map / Workspace
* Click-to-fly / goto-point-on-map in Guided mode — also covers landing at a
  chosen point, which was the only thing a dedicated Land button would have
  added over the mode dropdown.

### Core / Infrastructure
* Multi-vehicle / swarm support.
