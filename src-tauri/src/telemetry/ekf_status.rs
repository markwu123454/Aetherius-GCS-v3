use mavlink::dialects::ardupilotmega::{EkfStatusFlags, EKF_STATUS_REPORT_DATA};

use super::VehicleSnapshot;

/// "Healthy" means the estimator trusts the three outputs actually flown on —
/// attitude, horizontal velocity, horizontal position. Vertical-position and
/// terrain bits are left out: a vehicle can be perfectly flyable with a poor
/// terrain estimate.
pub fn apply(snapshot: &mut VehicleSnapshot, data: &EKF_STATUS_REPORT_DATA) {
    let healthy = EkfStatusFlags::EKF_ATTITUDE
        | EkfStatusFlags::EKF_VELOCITY_HORIZ
        | EkfStatusFlags::EKF_POS_HORIZ_ABS;
    snapshot.ekf_ok = Some(data.flags.contains(healthy));
}