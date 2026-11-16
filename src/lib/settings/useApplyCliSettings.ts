import {useEffect} from "react";
import {applyCliSettings, cliStore} from "@/lib/cli/cli.ts";
import type {CliPermissions} from "./settings.ts";

/**
 * Pushes the CLI preferences to the backend, which starts or stops its
 * control server and checks every request against the permissions. The
 * backend starts with CLI access off and waits for this, so nothing can
 * connect before the operator's own settings are known.
 */
export function useApplyCliSettings(enabled: boolean, permissions: CliPermissions, historyDays: number): void {
    const key = JSON.stringify(permissions);
    useEffect(() => {
        applyCliSettings(enabled, permissions, historyDays)
            .then((status) => cliStore.update((s) => ({...s, status})))
            .catch(() => {});
        // `key` stands in for `permissions`, whose identity changes on every
        // settings write even when nothing in it did.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, key, historyDays]);
}
