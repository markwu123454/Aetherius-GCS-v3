# ArduPilot GCS UI Design Notes

## Technology

* Frontend: React
* Desktop runtime: Tauri
* Design system: IBM Carbon Design System
* Target: ArduPilot only
* No PX4 or other flight-stack abstraction required

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
