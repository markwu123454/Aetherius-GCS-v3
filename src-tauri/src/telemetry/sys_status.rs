use mavlink::dialects::ardupilotmega::{MavSysStatusSensor, SYS_STATUS_DATA};

use super::VehicleSnapshot;

pub fn apply(snapshot: &mut VehicleSnapshot, data: &SYS_STATUS_DATA) {
    // Voltage arrives in millivolts, current in centiamps.
    snapshot.battery_voltage = Some(data.voltage_battery as f32 / 1000.0);
    snapshot.battery_current = Some(data.current_battery as f32 / 100.0);
    snapshot.battery_percent = Some(data.battery_remaining);
    snapshot.prearm_pass = Some(
        data.onboard_control_sensors_health
            .contains(MavSysStatusSensor::MAV_SYS_STATUS_PREARM_CHECK),
    );
}