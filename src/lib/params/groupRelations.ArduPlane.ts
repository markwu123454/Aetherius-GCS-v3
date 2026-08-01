import {GroupRelation} from "./groupRelations.ts";
import {SHARED_GROUP_RELATIONS} from "./groupRelations.shared.ts";

export const ARDUPLANE_GROUP_RELATIONS: GroupRelation[] = [
    ...SHARED_GROUP_RELATIONS,
    {
        type: "parentChild",
        label: "QuadPlane",
        parent: "Q_",
        children: ["Q_AUTOTUNE_", "Q_A_", "Q_LOIT_", "Q_M_", "Q_P", "Q_TAILSIT_", "Q_TILT_", "Q_WP_", "Q_WVANE_"],
    },
    {type: "parentChild", label: "Landing", parent: "LAND_", children: ["LAND_DS_"]},
];
