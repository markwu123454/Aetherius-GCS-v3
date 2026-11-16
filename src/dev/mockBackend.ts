/**
 * Browser-only stand-in for the Tauri backend, for screenshots and UI work
 * without hardware. Loaded by `main.tsx` only in a dev build and only when
 * the URL has `?mock` — a normal `npm run dev` tab and every production
 * build never touch it.
 *
 * Installs `mockIPC` (with event mocking) before any app module evaluates,
 * since several stores call `listen` at import time. Answers the commands
 * the main pages need and emits a connected, flying ArduCopter: a vehicle
 * snapshot at 10 Hz, a parameter set built from the bundled param reference,
 * a mission, a few Lua scripts, and a firmware manifest. Anything else
 * resolves to `null`.
 */
import {mockIPC, mockWindows} from "@tauri-apps/api/mocks";
import {emit} from "@tauri-apps/api/event";

// A public model-aircraft field — nothing tied to whoever is running this.
const HOME = {lat: 34.1762, lon: -118.4802};
const ENDPOINT = "serial:COM5:115200";

const LINK = {
    status: "connected",
    endpoint: ENDPOINT,
    error: null,
    available: [
        {label: "CubeOrange", address: ENDPOINT, class: "pixhawk", vid: 0x2dae, pid: 0x1016, portName: "COM5"},
        {label: "SiK Radio", address: "serial:COM7:57600", class: "sikRadio", vid: 0x0403, pid: 0x6015, portName: "COM7"},
    ],
};

// ── Vehicle ────────────────────────────────────────────────────────────────

const startedAt = Date.now();

function snapshot() {
    const t = (Date.now() - startedAt) / 1000;
    // A slow 120 m circle around home, nose along the track.
    const angle = t / 30;
    const radius = 120;
    const lat = HOME.lat + (radius * Math.cos(angle)) / 111_320;
    const lon = HOME.lon + (radius * Math.sin(angle)) / (111_320 * Math.cos((HOME.lat * Math.PI) / 180));
    const heading = (((angle * 180) / Math.PI + 90) % 360 + 360) % 360;
    return {
        armed: true,
        customMode: 3, // AUTO
        vehicleKind: "multirotor",
        prearmPass: true,
        batteryVoltage: 15.6 - t * 0.0005,
        batteryCurrent: 11.8 + Math.sin(t) * 0.6,
        batteryPercent: 78,
        batteryConsumedMah: 642 + t * 3,
        gpsFix: 3,
        satellites: 17,
        hdop: 0.7,
        lat,
        lon,
        relativeAlt: 40 + Math.sin(t / 5) * 0.4,
        heading,
        sinceHeartbeatMs: 180,
        commDropPercent: 0.4,
        radioRssi: 212,
        ekfOk: true,
        vibe: 11.5 + Math.sin(t * 2) * 1.5,
        rollDeg: Math.sin(t / 3) * 4 + 6,
        pitchDeg: -4 + Math.cos(t / 4) * 1.5,
        yawDeg: heading,
        rollRateDps: Math.cos(t / 3) * 1.3,
        pitchRateDps: -Math.sin(t / 4) * 0.4,
        yawRateDps: 1.9,
        groundspeed: 4.1,
        airspeed: 4.3,
        climbRate: Math.cos(t / 5) * 0.08,
        throttle: 46,
        homeLat: HOME.lat,
        homeLon: HOME.lon,
        windDir: 245,
        windSpeed: 3.2,
        wpDist: 64,
        xtrackError: 0.6,
        boardVoltage: 5.1,
        servoVoltage: 0,
        currentWp: 3,
        flightSwMajor: 4,
        flightSwMinor: 6,
        flightSwPatch: 2,
        flightSwVersionType: 255,
        boardVersion: 1,
        boardVendorId: 0x2dae,
        boardProductId: 0x1016,
        flightCustomVersion: "3c1a9e7f",
    };
}

// ── Parameters ─────────────────────────────────────────────────────────────

interface SheetParam {
    name: string;
    units?: string;
    range?: [number, number];
    increment?: number;
    values?: {value: number}[];
    bitmask?: {value: number}[];
}

/** Subsystems a typical single-IMU quad leaves disabled, or extra instances
 * of ones it has one of — dropped so the list is the size a real vehicle
 * reports, not every parameter ArduPilot documents. */
const ABSENT =
    /^(ADSB|AFS|AIS|AROT|ARSPD|BCN|BTN|CAM|CAN|DDS|EAHRS|EFI|FOLL|GEN|GRIP|ICE|KDE|MNT|MSP|NET|OA|OSD|PLND|PRX|RNGFND|RPM|SID|SIM|SPRAY|TCAL|TMODE|VISO|VTX|WINCH|BATT[2-9A-G]|BARO\d_WCF|COMPASS_PMOT|EK2|Q_)/;

const OVERRIDES: Record<string, number> = {
    FRAME_CLASS: 1,
    FRAME_TYPE: 1,
    SYSID_THISMAV: 1,
    MOT_PWM_TYPE: 0,
    MOT_PWM_MIN: 1000,
    MOT_PWM_MAX: 2000,
    MOT_SPIN_ARM: 0.1,
    MOT_SPIN_MIN: 0.15,
    MOT_SPIN_MAX: 0.95,
    MOT_THST_EXPO: 0.65,
    MOT_THST_HOVER: 0.31,
    ESC_CALIBRATION: 0,
    SERVO1_FUNCTION: 33,
    SERVO2_FUNCTION: 34,
    SERVO3_FUNCTION: 35,
    SERVO4_FUNCTION: 36,
    RCMAP_ROLL: 1,
    RCMAP_PITCH: 2,
    RCMAP_THROTTLE: 3,
    RCMAP_YAW: 4,
    COMPASS_DEV_ID: 97539,
    COMPASS_USE: 1,
    COMPASS_OFS_X: 42.6,
    COMPASS_OFS_Y: -18.1,
    COMPASS_OFS_Z: 77.3,
    INS_ACCOFFS_X: 0.071,
    INS_ACCOFFS_Y: -0.034,
    INS_ACCOFFS_Z: 0.112,
    AHRS_TRIM_X: 0.006,
    AHRS_TRIM_Y: -0.011,
    BRD_SAFETY_DEFLT: 1,
    LOG_BITMASK: 180222,
    LOG_BACKEND_TYPE: 1,
    LOG_MAX_FILES: 500,
    LOG_FILE_MB_FREE: 500,
    LOG_MAV_RATEMAX: 10,
    SCHED_LOOP_RATE: 400,
    BATT_MONITOR: 4,
    BATT_CAPACITY: 5200,
    WPNAV_SPEED: 1000,
    RTL_ALT: 1500,
    FENCE_ENABLE: 1,
    FENCE_ALT_MAX: 120,
    SCR_ENABLE: 1,
    SCR_HEAP_SIZE: 204800,
    FLTMODE1: 0,
    FLTMODE2: 2,
    FLTMODE3: 5,
    FLTMODE4: 3,
    FLTMODE5: 6,
    FLTMODE6: 9,
    FLTMODE_CH: 5,
    FORMAT_VERSION: 120,
    PILOT_THR_FILT: 0,
    PILOT_SPEED_UP: 250,
    PILOT_ACCEL_Z: 250,
    RTL_CONE_SLOPE: 3,
    RTL_LOIT_TIME: 5000,
    RTL_SPEED: 0,
    GPS_HDOP_GOOD: 140,
    WP_YAW_BEHAVIOR: 2,
    FS_THR_ENABLE: 1,
    FS_THR_VALUE: 975,
    FS_GCS_ENABLE: 1,
    FS_EKF_THRESH: 0.8,
    THR_DZ: 100,
    ANGLE_MAX: 3000,
    LAND_SPEED: 50,
    LAND_ALT_LOW: 1000,
    DISARM_DELAY: 10,
    PHLD_BRAKE_RATE: 8,
    PHLD_BRAKE_ANGLE: 3000,
};

function defaultValue(param: SheetParam): number {
    if (param.name in OVERRIDES) return OVERRIDES[param.name];
    const rc = /^RC(\d+)_(MIN|MAX|TRIM)$/.exec(param.name);
    if (rc) return {MIN: 982, MAX: 2006, TRIM: 1494}[rc[2] as "MIN" | "MAX" | "TRIM"];
    const servo = /^SERVO(\d+)_(MIN|MAX|TRIM)$/.exec(param.name);
    if (servo) return {MIN: 1100, MAX: 1900, TRIM: 1500}[servo[2] as "MIN" | "MAX" | "TRIM"];
    if (param.values?.length) return param.values[0].value;
    if (param.range) {
        const [lo, hi] = param.range;
        return lo <= 0 && hi >= 0 ? 0 : lo;
    }
    return 0;
}

function paramType(param: SheetParam): string {
    if (param.bitmask) return "INT32";
    if (param.values) return "INT8";
    if ((param.increment !== undefined && param.increment < 1) || param.units) return "REAL32";
    return "INT16";
}

async function emitParams(): Promise<void> {
    const sheet = (await fetch("/params/ArduCopter.json").then((r) => r.json())) as {groups: {params: SheetParam[]}[]};
    const params = sheet.groups
        .flatMap((group) => group.params)
        .filter((param) => !ABSENT.test(param.name));
    const total = params.length;
    const entries = params.map((param, index) => ({
        name: param.name,
        value: defaultValue(param),
        paramType: paramType(param),
        index,
    }));
    for (let i = 0; i < entries.length; i += 200) {
        await emit("param-values", {total, values: entries.slice(i, i + 200)});
        await new Promise((resolve) => setTimeout(resolve, 30));
    }
}

// ── Mission, scripts, firmware ─────────────────────────────────────────────

function offset(north: number, east: number) {
    return {
        lat: HOME.lat + north / 111_320,
        lon: HOME.lon + east / (111_320 * Math.cos((HOME.lat * Math.PI) / 180)),
    };
}

const MISSION = {
    skipped: 0,
    waypoints: [
        {...offset(0, 0), altitude: 30, speed: null, action: "takeoff"},
        {...offset(230, 90), altitude: 40, speed: null, action: "waypoint"},
        {...offset(310, 370), altitude: 40, speed: 6, action: "waypoint"},
        {...offset(100, 540), altitude: 45, speed: null, action: "waypoint"},
        {...offset(-180, 420), altitude: 45, speed: null, action: "loiter"},
        {...offset(-240, 110), altitude: 35, speed: null, action: "waypoint"},
        {...offset(0, 0), altitude: 0, speed: null, action: "returnToLaunch"},
    ],
};

const LOCAL_FILES: Record<string, string> = {
    "battery_monitor.lua": `-- Warn the pilot as the pack drains, once per threshold.
local THRESHOLDS = { 30, 20, 10 }   -- percent remaining
local warned = {}

local function update()
  local remaining = battery:capacity_remaining_pct(0)
  if remaining then
    for _, level in ipairs(THRESHOLDS) do
      if remaining <= level and not warned[level] then
        gcs:send_text(4, string.format("Battery at %d%%", remaining))
        warned[level] = true
      end
    end
  end
  return update, 1000
end

return update, 1000
`,
    "geofence_beep.lua": `-- Chirp the buzzer while the vehicle is within 10 m of the fence.
local MARGIN_M = 10

local function update()
  local dist = fence:get_breach_distance and fence:get_breach_distance() or nil
  if dist and dist < MARGIN_M then
    notify:play_tune("MFT200L16<cdefgab>")
  end
  return update, 500
end

return update, 500
`,
    "mission_logger.lua": `-- Log each waypoint as it is reached, with altitude and battery.
local last_wp = -1

local function update()
  local wp = mission:get_current_nav_index()
  if wp ~= last_wp then
    local loc = ahrs:get_location()
    local volts = battery:voltage(0)
    if loc then
      gcs:send_text(6, string.format("WP %d  alt %.1f m  %.2f V", wp, loc:alt() / 100, volts))
    end
    last_wp = wp
  end
  return update, 250
end

return update, 250
`,
};

const VEHICLE_DIRS: Record<string, {name: string; isDir: boolean}[]> = {
    "": [{name: "APM", isDir: true}],
    APM: [
        {name: "scripts", isDir: true},
        {name: "LOGS", isDir: true},
    ],
    "APM/scripts": [
        {name: "battery_monitor.lua", isDir: false},
        {name: "mission_logger.lua", isDir: false},
    ],
    "APM/LOGS": [],
};

function manifest(vehicletype: string) {
    const mavType = vehicletype === "Plane" ? "FIXED_WING" : "Copter";
    const boards = [
        {platform: "CubeOrange", usbid: ["0x2DAE/0x1016"], boardId: 140, brandName: "CubePilot Cube Orange"},
        {platform: "CubeOrangePlus", usbid: ["0x2DAE/0x1058"], boardId: 1063, brandName: "CubePilot Cube Orange+"},
        {platform: "Pixhawk6X", usbid: ["0x3162/0x0035"], boardId: 53, brandName: "Holybro Pixhawk 6X"},
        {platform: "MatekH743", usbid: ["0x1209/0x5741"], boardId: 1013, brandName: "Matek H743"},
    ];
    const versions = [
        {version: "4.6.2", versionType: "OFFICIAL"},
        {version: "4.6.3-rc1", versionType: "RC"},
        {version: "4.7.0-beta2", versionType: "BETA"},
        {version: "4.7.0-dev", versionType: "DEV"},
    ];
    return boards.flatMap((board) =>
        versions.map((v) => ({
            ...board,
            ...v,
            mavType,
            manufacturer: board.brandName.split(" ")[0],
            url: `https://firmware.ardupilot.org/${vehicletype}/${board.platform}/arducopter.apj`,
        })),
    );
}

const BOOT_MESSAGES: [number, string][] = [
    [6, "ArduCopter V4.6.2 (3c1a9e7f)"],
    [6, "ChibiOS: 6a85082c"],
    [6, "CubeOrange 0037002A 3131510B 34353834"],
    [6, "Frame: QUAD/X"],
    [6, "EKF3 IMU0 is using GPS"],
    [6, "Mission: 1 Takeoff"],
];

// ── IPC ────────────────────────────────────────────────────────────────────

const storeData = new Map<string, unknown>();

function handle(cmd: string, args: Record<string, unknown> | undefined): unknown {
    switch (cmd) {
        case "link_state":
            return LINK;
        case "refresh_links":
            return LINK.available;
        case "list_known_boards":
            return [];
        case "refresh_params":
            void emitParams();
            return null;
        case "set_param":
            return args?.value;
        case "download_mission":
            return MISSION;
        case "list_local_dir":
            return args?.path === "" ? Object.keys(LOCAL_FILES).map((name) => ({name, isDir: false})) : [];
        case "read_local_file":
            return LOCAL_FILES[String(args?.path)] ?? "";
        case "list_vehicle_dir":
            return VEHICLE_DIRS[String(args?.path)] ?? [];
        case "read_vehicle_file":
            return LOCAL_FILES[String(args?.path).split("/").pop() ?? ""] ?? "";
        case "flash_fetch_manifest":
            return manifest(String(args?.vehicletype));
        case "system_info":
            return {os: "windows", arch: "x86_64"};
        case "plugin:store|load":
        case "plugin:store|get_store":
            return 1;
        case "plugin:store|get":
            return storeData.has(String(args?.key)) ? [storeData.get(String(args?.key)), true] : [null, false];
        case "plugin:store|set":
            storeData.set(String(args?.key), args?.value);
            return null;
        case "plugin:store|has":
            return storeData.has(String(args?.key));
        case "plugin:store|keys":
            return [...storeData.keys()];
        case "plugin:store|entries":
            return [...storeData.entries()];
        case "plugin:store|values":
            return [...storeData.values()];
        case "plugin:store|length":
            return storeData.size;
        default:
            return null;
    }
}

mockWindows("main");
mockIPC((cmd, args) => handle(cmd, args as Record<string, unknown> | undefined), {shouldMockEvents: true});

// Let every module subscribe before the first events go out — `listen`
// registers asynchronously, and the app mounts after this module.
setTimeout(() => {
    void emit("link-status", "connected");
    void emit("link-state", LINK);
    void emit("autopilot-version", {boardUid: null});
    for (const [severity, text] of BOOT_MESSAGES) void emit("statustext", {severity, text});
    setInterval(() => {
        void emit("vehicle", snapshot());
        const t = (Date.now() - startedAt) / 1000;
        // Sticks near centre with a little movement; throttle at hover.
        void emit("rc-channels", {
            channels: [
                1494 + Math.round(Math.sin(t / 2) * 60),
                1494 + Math.round(Math.cos(t / 3) * 40),
                1560,
                1494 + Math.round(Math.sin(t / 5) * 30),
                1100,
                1500,
                1100,
                1100,
            ],
        });
        void emit("servo-outputs", {
            port: 0,
            channels: [1512, 1498, 1525, 1489].map((pwm, i) => pwm + Math.round(Math.sin(t * 3 + i) * 12)),
        });
    }, 100);
}, 2000);
