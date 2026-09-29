import {invoke} from "@tauri-apps/api/core";
import {getVersion} from "@tauri-apps/api/app";
import {firmwareVersionLabel, type FirmwareVersionInfo, type VehicleKind} from "@/lib/vehicle/vehicle.ts";

export const ISSUES_URL = "https://github.com/markwu123454/Aetherius-GCS-v3/issues";

export type FeedbackKind = "bug" | "feature";

/** What the operator typed. Which fields apply depends on the kind — see
 * `.github/ISSUE_TEMPLATE/`, whose field ids these map onto. */
export interface FeedbackDraft {
    title: string;
    /** Bug: what happened. Feature: what they're trying to do. */
    main: string;
    /** Bug: what they expected. Feature: what would help. */
    secondary: string;
    /** Bug only: steps to reproduce. */
    steps: string;
}

export const EMPTY_DRAFT: FeedbackDraft = {title: "", main: "", secondary: "", steps: ""};

/** The app and machine, read once when the dialog opens. */
export interface SystemDetails {
    appVersion: string | null;
    os: string | null;
    arch: string | null;
}

/** What's connected, if anything — read live from the app's own state. */
export interface VehicleDetails {
    kind: VehicleKind | null;
    firmware: FirmwareVersionInfo | null;
    frameClass: number | null;
    frameType: number | null;
    /** The scan's name for the board (e.g. "CubeOrange"), if it matched one. */
    board: string | null;
    /** Only the transport ("serial", "tcp", "udp") — never the address. */
    linkType: string | null;
}

export async function readSystemDetails(): Promise<SystemDetails> {
    const [appVersion, system] = await Promise.all([
        getVersion().catch(() => null),
        invoke<{os: string; arch: string}>("system_info").catch(() => null),
    ]);
    return {appVersion, os: system?.os ?? null, arch: system?.arch ?? null};
}

const KIND_LABEL: Record<VehicleKind, string> = {multirotor: "Copter", plane: "Plane", other: "Other"};

/**
 * The environment block, one "Label: value" line each. This exact text is
 * what gets sent, and the dialog shows it verbatim, so nothing leaves the
 * app that the operator didn't see. Deliberately excludes the board's UID
 * and the connection address.
 */
export function environmentText(system: SystemDetails, vehicle: VehicleDetails | null): string {
    const lines = [
        `App version: ${system.appVersion ?? "unknown"}`,
        `OS: ${system.os ?? "unknown"}${system.arch ? ` (${system.arch})` : ""}`,
    ];
    if (vehicle) {
        lines.push(
            `Vehicle: ${vehicle.kind ? KIND_LABEL[vehicle.kind] : "unknown"}`,
            `Firmware: ${vehicle.firmware ? firmwareVersionLabel(vehicle.firmware) : "not reported"}`,
        );
        if (vehicle.frameClass !== null) {
            lines.push(`Frame: FRAME_CLASS ${vehicle.frameClass}, FRAME_TYPE ${vehicle.frameType ?? "?"}`);
        }
        if (vehicle.board) lines.push(`Board: ${vehicle.board}`);
        if (vehicle.linkType) lines.push(`Link: ${vehicle.linkType}`);
    } else {
        lines.push("Vehicle: not connected");
    }
    return lines.join("\n");
}

/** The same report as Markdown, for "Copy report" — to paste into GitHub by
 * hand, an email, or a chat, for someone without a GitHub account. */
export function reportMarkdown(kind: FeedbackKind, draft: FeedbackDraft, environment: string | null): string {
    const section = (heading: string, text: string) => (text.trim() ? `### ${heading}\n\n${text.trim()}\n` : "");
    const parts =
        kind === "bug"
            ? [
                  section("What happened?", draft.main),
                  section("What did you expect to happen?", draft.secondary),
                  section("Steps to reproduce", draft.steps),
                  environment ? `### Environment\n\n\`\`\`text\n${environment}\n\`\`\`\n` : "",
              ]
            : [
                  section("What are you trying to do?", draft.main),
                  section("What would help?", draft.secondary),
                  environment ? `### App version\n\n${environment.split("\n")[0].replace("App version: ", "")}\n` : "",
              ];
    return [`## ${draft.title.trim() || (kind === "bug" ? "Bug report" : "Feature request")}`, "", ...parts.filter(Boolean)].join("\n");
}

/** GitHub rejects new-issue URLs much past 8 KB; stay clear of that. */
const MAX_URL_LENGTH = 7_500;

/**
 * GitHub's new-issue page with the matching issue form pre-filled — field
 * ids from `.github/ISSUE_TEMPLATE/`. The operator only has to sign in and
 * press Submit. If the text is too long for a URL, the longest field is cut
 * and `truncated` is set, so the dialog can say to paste the full copy.
 */
export function issueUrl(kind: FeedbackKind, draft: FeedbackDraft, environment: string | null): {url: string; truncated: boolean} {
    const fields: Record<string, string> =
        kind === "bug"
            ? {
                  "what-happened": draft.main,
                  expected: draft.secondary,
                  steps: draft.steps,
                  environment: environment ?? "",
              }
            : {
                  problem: draft.main,
                  proposal: draft.secondary,
                  "app-version": environment?.split("\n")[0].replace("App version: ", "") ?? "",
              };

    const build = () => {
        const params = new URLSearchParams({template: kind === "bug" ? "bug_report.yml" : "feature_request.yml", title: draft.title.trim()});
        for (const [id, value] of Object.entries(fields)) {
            if (value.trim()) params.set(id, value.trim());
        }
        return `${ISSUES_URL}/new?${params.toString()}`;
    };

    let url = build();
    let truncated = false;
    while (url.length > MAX_URL_LENGTH) {
        const longest = Object.keys(fields).reduce((a, b) => (fields[b].length > fields[a].length ? b : a));
        const text = fields[longest];
        if (text.length < 200) break; // nothing left worth cutting
        fields[longest] = `${text.slice(0, Math.floor(text.length * 0.8))}\n\n[…cut to fit — full text pasted below]`;
        truncated = true;
        url = build();
    }
    return {url, truncated};
}
