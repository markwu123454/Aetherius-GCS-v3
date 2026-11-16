//! Flight mode names by `custom_mode`, for `status` and for MODE records in
//! logs. Same tables as the frontend's `src/lib/vehicle/modes.ts`.

pub fn copter(mode: u32) -> Option<&'static str> {
    Some(match mode {
        0 => "STABILIZE",
        1 => "ACRO",
        2 => "ALT HOLD",
        3 => "AUTO",
        4 => "GUIDED",
        5 => "LOITER",
        6 => "RTL",
        7 => "CIRCLE",
        9 => "LAND",
        11 => "DRIFT",
        13 => "SPORT",
        14 => "FLIP",
        15 => "AUTOTUNE",
        16 => "POSHOLD",
        17 => "BRAKE",
        18 => "THROW",
        19 => "AVOID ADSB",
        20 => "GUIDED NOGPS",
        21 => "SMART RTL",
        22 => "FLOWHOLD",
        23 => "FOLLOW",
        24 => "ZIGZAG",
        25 => "SYSTEMID",
        26 => "AUTOROTATE",
        27 => "AUTO RTL",
        28 => "TURTLE",
        _ => return None,
    })
}

pub fn plane(mode: u32) -> Option<&'static str> {
    Some(match mode {
        0 => "MANUAL",
        1 => "CIRCLE",
        2 => "STABILIZE",
        3 => "TRAINING",
        4 => "ACRO",
        5 => "FBWA",
        6 => "FBWB",
        7 => "CRUISE",
        8 => "AUTOTUNE",
        10 => "AUTO",
        11 => "RTL",
        12 => "LOITER",
        13 => "TAKEOFF",
        14 => "AVOID ADSB",
        15 => "GUIDED",
        17 => "QSTABILIZE",
        18 => "QHOVER",
        19 => "QLOITER",
        20 => "QLAND",
        21 => "QRTL",
        22 => "QAUTOTUNE",
        23 => "QACRO",
        24 => "THERMAL",
        25 => "LOITER ALT QLAND",
        _ => return None,
    })
}

/// The mode's name for a copter (`plane == false`) or plane, or its number.
pub fn name(plane_vehicle: bool, mode: u32) -> String {
    let found = if plane_vehicle { plane(mode) } else { copter(mode) };
    found.map(str::to_string).unwrap_or_else(|| format!("MODE {mode}"))
}

/// `AltHold`, `alt_hold` and `ALT HOLD` all compare equal.
pub fn normalize(name: &str) -> String {
    name.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_uppercase).collect()
}
