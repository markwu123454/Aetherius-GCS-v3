use mavlink::dialects::ardupilotmega::{MavModeFlag, MavType, HEARTBEAT_DATA};

use super::{VehicleKind, VehicleSnapshot};

pub fn apply(snapshot: &mut VehicleSnapshot, data: &HEARTBEAT_DATA) {
    snapshot.armed = Some(
        data.base_mode
            .contains(MavModeFlag::MAV_MODE_FLAG_SAFETY_ARMED),
    );
    snapshot.custom_mode = Some(data.custom_mode);
    snapshot.vehicle_kind = Some(vehicle_kind_of(data.mavtype));
}

/// Grouped down to what the UI actually draws differently, not the full
/// MAV_TYPE enum. VTOL variants count as `Plane` — ArduPilot's QuadPlanes
/// fly like fixed-wing aircraft outside of transition.
fn vehicle_kind_of(mavtype: MavType) -> VehicleKind {
    match mavtype {
        MavType::MAV_TYPE_FIXED_WING
        | MavType::MAV_TYPE_AIRSHIP
        | MavType::MAV_TYPE_FLAPPING_WING
        | MavType::MAV_TYPE_KITE
        | MavType::MAV_TYPE_VTOL_TAILSITTER_DUOROTOR
        | MavType::MAV_TYPE_VTOL_TAILSITTER_QUADROTOR
        | MavType::MAV_TYPE_VTOL_TILTROTOR
        | MavType::MAV_TYPE_VTOL_FIXEDROTOR
        | MavType::MAV_TYPE_VTOL_TAILSITTER
        | MavType::MAV_TYPE_VTOL_TILTWING
        | MavType::MAV_TYPE_VTOL_RESERVED5
        | MavType::MAV_TYPE_VTOL_GYRODYNE => VehicleKind::Plane,
        MavType::MAV_TYPE_QUADROTOR
        | MavType::MAV_TYPE_HEXAROTOR
        | MavType::MAV_TYPE_OCTOROTOR
        | MavType::MAV_TYPE_TRICOPTER
        | MavType::MAV_TYPE_COAXIAL
        | MavType::MAV_TYPE_HELICOPTER => VehicleKind::Multirotor,
        _ => VehicleKind::Other,
    }
}