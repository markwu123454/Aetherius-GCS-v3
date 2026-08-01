import {useEffect, useState} from "react";
import {loadParamSheet, ParamSheet, VehicleFirmware} from "./paramSheet.ts";

export type ParamSheetState =
    | {status: "idle"}
    | {status: "loading"}
    | {status: "error"; message: string}
    | {status: "ready"; sheet: ParamSheet};

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** `vehicle` is `null` when there's nothing to pick a sheet for yet — no
 * firmware fetch happens, and the state stays `idle`. */
export function useParamSheet(vehicle: VehicleFirmware | null): ParamSheetState {
    const [state, setState] = useState<ParamSheetState>(vehicle ? {status: "loading"} : {status: "idle"});

    useEffect(() => {
        if (!vehicle) {
            setState({status: "idle"});
            return;
        }

        let cancelled = false;
        setState({status: "loading"});

        loadParamSheet(vehicle)
            .then((sheet) => {
                if (!cancelled) {
                    setState({status: "ready", sheet});
                }
            })
            .catch((error: unknown) => {
                if (!cancelled) {
                    setState({status: "error", message: message(error)});
                }
            });

        return () => {
            cancelled = true;
        };
    }, [vehicle]);

    return state;
}
