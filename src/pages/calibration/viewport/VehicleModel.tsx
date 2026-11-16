import type {VehicleKind} from "@/lib/vehicle/vehicle.ts";
import PlaneModel, {PlaneRotationDeg} from "./PlaneModel.tsx";
import QuadModel from "./QuadModel.tsx";

/** The quad for copter firmware, the plane for everything else. */
export default function VehicleModel({kind, rotationDeg}: {kind: VehicleKind | null; rotationDeg: PlaneRotationDeg}) {
    return kind === "multirotor" ? <QuadModel rotationDeg={rotationDeg} /> : <PlaneModel rotationDeg={rotationDeg} />;
}
