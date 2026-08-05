import {useEffect} from "react";
import {setSparklinesEnabled} from "@/lib/vehicle/useTelemetryHistory.ts";

export function useApplyTelemetrySettings(sparklines: boolean): void {
    useEffect(() => {
        setSparklinesEnabled(sparklines);
    }, [sparklines]);
}
