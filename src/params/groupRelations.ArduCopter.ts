import {GroupRelation} from "./groupRelations";
import {SHARED_GROUP_RELATIONS} from "./groupRelations.shared";

export const ARDUCOPTER_GROUP_RELATIONS: GroupRelation[] = [
    ...SHARED_GROUP_RELATIONS,
    {
        type: "parentChild",
        label: "Traditional Heli",
        parent: "H_",
        children: [{type: "parentChild", label: "Rotor Speed Controller", parent: "H_RSC_", children: ["H_RSC_AROT_"]}],
    },
];
