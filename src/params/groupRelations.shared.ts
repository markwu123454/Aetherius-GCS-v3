import {GroupRelation} from "./groupRelations";

/**
 * Families that look the same on both ArduCopter and ArduPlane — numbered
 * channel/sensor/port instances, and the handful of real parent/sub-table
 * pairs common to both. A group this doesn't mention just stays flat; a
 * relation naming a group a given firmware doesn't have is silently skipped
 * by `buildGroupTree`, so this list doesn't need to be split per vehicle
 * just because a few of these happen to be Copter- or Plane-only in
 * practice.
 *
 * Ordering choices here (which variant is "the parent", how sub-instances
 * are ordered) are a first pass, not verified against ArduPilot's source —
 * edit freely as better judgment calls turn up.
 */
export const SHARED_GROUP_RELATIONS: GroupRelation[] = [
    {
        type: "parentChild",
        label: "Servo Output",
        parent: "SERVO",
        children: [
            {
                type: "sequential",
                label: "Channels",
                members: Array.from({length: 32}, (_, i) => `SERVO${i + 1}_`),
            },
            "SERVO_BLH_",
            "SERVO_FTW_",
            "SERVO_ROB_",
            "SERVO_SBUS_",
            "SERVO_VOLZ_",
        ],
    },
    {
        type: "parentChild",
        label: "RC Input",
        parent: "RC",
        children: [
            {type: "sequential", label: "Channels", members: Array.from({length: 16}, (_, i) => `RC${i + 1}_`)},
            "RCMAP_",
        ],
    },
    {
        type: "sequential",
        label: "Relay",
        members: Array.from({length: 16}, (_, i) => `RELAY${i + 1}_`),
    },
    {
        type: "parentChild",
        label: "Temperature Sensors",
        parent: "TEMP",
        children: [{type: "sequential", label: "Sensors", members: Array.from({length: 15}, (_, i) => `TEMP${i + 1}_`)}],
    },
    {
        type: "parentChild",
        label: "MAVLink Channels",
        parent: "MAV",
        children: [{type: "sequential", label: "Channels", members: Array.from({length: 32}, (_, i) => `MAV${i + 1}`)}],
    },
    {
        type: "parentChild",
        label: "Battery Monitors",
        parent: "BATT_",
        children: [
            {
                type: "sequential",
                label: "Additional Monitors",
                members: [
                    ...Array.from({length: 8}, (_, i) => `BATT${i + 2}_`), // BATT2_..BATT9_
                    ...["A", "B", "C", "D", "E", "F", "G"].map((letter) => `BATT${letter}_`),
                ],
            },
        ],
    },
    {
        type: "parentChild",
        label: "Camera",
        parent: "CAM",
        children: [
            {type: "parentChild", label: "Camera 1", parent: "CAM1", children: ["CAM1_RC_"]},
            {type: "parentChild", label: "Camera 2", parent: "CAM2", children: ["CAM2_RC_"]},
        ],
    },
    {
        type: "sequential",
        // Some instances are documented as e.g. both bare `PRX1` and `PRX1_`
        // — likely two related but distinct parameter tables per sensor
        // rather than a mistake, and not disambiguated further here.
        label: "Proximity Sensors",
        members: ["PRX", "PRX1", "PRX1_", "PRX2", "PRX2_", "PRX3", "PRX3_", "PRX4", "PRX4_", "PRX5", "PRX5_"],
    },
    {
        type: "parentChild",
        label: "GPS",
        parent: "GPS",
        children: [
            {type: "parentChild", label: "GPS 1", parent: "GPS1_", children: ["GPS1_MB_"]},
            {type: "parentChild", label: "GPS 2", parent: "GPS2_", children: ["GPS2_MB_"]},
            "GPS_MB1_",
            "GPS_MB2_",
        ],
    },
    {
        type: "parentChild",
        label: "CAN Bus",
        parent: "CAN_",
        children: [
            {type: "parentChild", label: "Driver 1", parent: "CAN_D1_", children: ["CAN_D1_PC_", "CAN_D1_UC_"]},
            {type: "parentChild", label: "Driver 2", parent: "CAN_D2_", children: ["CAN_D2_PC_", "CAN_D2_UC_"]},
            {type: "parentChild", label: "Driver 3", parent: "CAN_D3_", children: ["CAN_D3_PC_", "CAN_D3_UC_"]},
            {type: "sequential", label: "Ports", members: ["CAN_P1_", "CAN_P2_", "CAN_P3_"]},
            "CAN_SLCAN_",
        ],
    },
    {
        type: "sequential",
        label: "Rangefinders",
        members: [
            ...Array.from({length: 9}, (_, i) => ({
                type: "parentChild" as const,
                label: `Rangefinder ${i + 1}`,
                parent: `RNGFND${i + 1}_`,
                children: [`RNGFND${i + 1}_GRF_`],
            })),
            {type: "parentChild", label: "Rangefinder 10", parent: "RNGFNDA_", children: ["RNGFNDA_GRF_"]},
        ],
    },
    {
        type: "parentChild",
        label: "OSD",
        parent: "OSD",
        children: [
            {
                type: "sequential",
                label: "Screens",
                members: [
                    "OSD1_",
                    "OSD2_",
                    "OSD3_",
                    "OSD4_",
                    {
                        type: "parentChild",
                        label: "Screen 5",
                        parent: "OSD5_",
                        children: [
                            {
                                type: "sequential",
                                label: "User Params",
                                members: Array.from({length: 9}, (_, i) => `OSD5_PARAM${i + 1}`),
                            },
                        ],
                    },
                    {
                        type: "parentChild",
                        label: "Screen 6",
                        parent: "OSD6_",
                        children: [
                            {
                                type: "sequential",
                                label: "User Params",
                                members: Array.from({length: 9}, (_, i) => `OSD6_PARAM${i + 1}`),
                            },
                        ],
                    },
                ],
            },
        ],
    },
    {
        type: "sequential",
        label: "Custom Rotations",
        members: ["CUST_ROT", "CUST_ROT1_", "CUST_ROT2_"],
    },
    {
        type: "sequential",
        label: "Notch Filters",
        members: Array.from({length: 8}, (_, i) => `FILT${i + 1}_`),
    },
    {
        type: "sequential",
        label: "Airspeed Sensors",
        members: ["ARSPD", "ARSPD_", "ARSPD2_", "ARSPD3_", "ARSPD4_", "ARSPD5_", "ARSPD6_"],
    },
    {
        type: "parentChild",
        label: "Barometer",
        parent: "BARO",
        children: [
            {
                type: "sequential",
                label: "Water/Wind Correction",
                members: ["BARO1_WCF_", "BARO2_WCF_", "BARO3_WCF_"],
            },
        ],
    },
    {
        type: "parentChild",
        label: "Inertial Sensors",
        parent: "INS",
        children: [
            {type: "parentChild", label: "IMU 4", parent: "INS4_", children: ["INS4_TCAL_"]},
            {type: "parentChild", label: "IMU 5", parent: "INS5_", children: ["INS5_TCAL_"]},
            {
                type: "sequential",
                label: "Harmonic Notch Filters",
                members: ["INS_HNTCH_", "INS_HNTC2_", "INS_HNTC3_", "INS_HNTC4_"],
            },
            {
                type: "sequential",
                label: "Temperature Calibration (IMU 1-3)",
                members: ["INS_TCAL1_", "INS_TCAL2_", "INS_TCAL3_"],
            },
            "INS_LOG_",
        ],
    },
    {
        type: "parentChild",
        label: "Networking",
        parent: "NET_",
        children: [
            {
                type: "sequential",
                label: "Ports",
                members: [1, 2, 3, 4].map((n) => ({
                    type: "parentChild" as const,
                    label: `Port ${n}`,
                    parent: `NET_P${n}_`,
                    children: [`NET_P${n}_IP`],
                })),
            },
            "NET_GWADDR",
            "NET_IPADDR",
            "NET_MACADDR",
            "NET_REMPPP_IP",
            "NET_TEST_IP",
        ],
    },
    {type: "parentChild", label: "Board", parent: "BRD_", children: ["BRD_RADIO", "BRD_RTC"]},
    {type: "parentChild", label: "Compass", parent: "COMPASS_", children: ["COMPASS_PMOT"]},
    {
        type: "sequential",
        label: "EKF",
        members: ["EK2_", {type: "parentChild", label: "EKF3", parent: "EK3_", children: ["EK3_SRC"]}],
    },
    {type: "sequential", label: "Camera Mounts", members: ["MNT1", "MNT2"]},
    {type: "parentChild", label: "Object Avoidance", parent: "OA_", children: ["OA_BR_", "OA_DB_"]},
    {type: "parentChild", label: "Generator", parent: "GEN_", children: ["GEN_L_"]},
    {type: "parentChild", label: "DDS (ROS 2)", parent: "DDS", children: ["DDS_IP"]},
    {type: "parentChild", label: "EFI", parent: "EFI", children: ["EFI_THRLIN"]},
    {
        type: "parentChild",
        label: "Simulation (SITL)",
        parent: "SIM_",
        children: [
            "SIM_AIS_",
            "SIM_ARSPD_",
            "SIM_ARSPD2_",
            "SIM_BAR2_",
            "SIM_BAR3_",
            "SIM_BARO_",
            "SIM_BZ_",
            "SIM_FTOWESC_",
            "SIM_GLD_",
            {type: "sequential", label: "GPS", members: ["SIM_GPS1_", "SIM_GPS2_", "SIM_GPS3_", "SIM_GPS4_"]},
            "SIM_GRPE_",
            "SIM_GRPS_",
            "SIM_IE24_",
            "SIM_PARA_",
            "SIM_PLD_",
            "SIM_RFL_",
            "SIM_RICH_",
            "SIM_SB_",
            "SIM_SERVO_",
            "SIM_SHIP_",
            "SIM_SLUP_",
            "SIM_SPR_",
            "SIM_TA_",
            "SIM_TETH_",
            "SIM_VICON_",
            "SIM_VOLZ_",
        ],
    },
];
