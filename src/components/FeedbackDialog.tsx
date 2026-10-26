import {useEffect, useMemo, useState} from "react";
import {openUrl} from "@tauri-apps/plugin-opener";
import Modal from "@/components/Modal.tsx";
import {
    environmentText,
    type FeedbackDraft,
    type FeedbackKind,
    issueUrl,
    readSystemDetails,
    reportMarkdown,
    type SystemDetails,
    type VehicleDetails,
} from "@/lib/feedback/feedback.ts";
import {closeFeedback, finishFeedback, setFeedbackDraft, setFeedbackKind, useFeedbackDialog} from "@/lib/feedback/feedbackDialog.ts";
import {useVehicle} from "@/lib/vehicle/useVehicle.ts";
import {useConnection} from "@/lib/vehicle/useConnection.ts";
import {useLiveParams} from "@/lib/params/useLiveParams.ts";

const FIELD = "w-full border-b border-border-strong bg-layer-02 px-2 py-1.5 text-body text-text-primary placeholder:text-text-helper";

interface FieldSpec {
    key: keyof FeedbackDraft;
    label: string;
    placeholder: string;
    required?: boolean;
    rows?: number;
}

const FIELDS: Record<FeedbackKind, FieldSpec[]> = {
    bug: [
        {key: "title", label: "Title", placeholder: "Short summary, e.g. \"Compass calibration never finishes\"", required: true},
        {key: "main", label: "What happened?", placeholder: "What went wrong, as specifically as you can. Error messages help a lot.", required: true, rows: 4},
        {key: "secondary", label: "What did you expect to happen?", placeholder: "Optional", rows: 2},
        {key: "steps", label: "Steps to reproduce", placeholder: "1. Connect over USB\n2. Open Setup › Frame\n3. …", rows: 4},
    ],
    feature: [
        {key: "title", label: "Title", placeholder: "Short summary, e.g. \"Show battery time remaining\"", required: true},
        {key: "main", label: "What are you trying to do?", placeholder: "The task or problem — rather than a specific solution.", required: true, rows: 4},
        {key: "secondary", label: "What would help?", placeholder: "How you imagine it working, if you have an idea. Optional.", rows: 3},
    ],
};

/**
 * "Report a bug" / "Request a feature" — the one dialog both the Help menu
 * and the About page open (see `openFeedback`). The app can't file an issue
 * itself (that needs the operator's own GitHub login), so this does the part
 * people find hard: it asks the right questions, fills in the details nobody
 * thinks to include, and opens GitHub with the matching issue form already
 * filled, leaving only sign in and Submit. "Copy report" covers anyone
 * without a GitHub account.
 */
export default function FeedbackDialog() {
    const {kind, draft} = useFeedbackDialog();
    const vehicle = useVehicle();
    const connection = useConnection();
    const {values: live} = useLiveParams();

    const [system, setSystem] = useState<SystemDetails | null>(null);
    const [includeDetails, setIncludeDetails] = useState(true);
    const [notice, setNotice] = useState<{tone: "ok" | "warn" | "danger"; text: string} | null>(null);

    const open = kind !== null;
    useEffect(() => {
        if (!open) return;
        setNotice(null);
        void readSystemDetails().then(setSystem);
    }, [open]);

    const vehicleDetails = useMemo<VehicleDetails | null>(() => {
        if (!vehicle.connected) return null;
        const endpoint = connection.endpoint;
        const board = connection.available.find((link) => link.address === endpoint)?.label ?? null;
        const frameClass = live.get("FRAME_CLASS")?.value;
        const frameType = live.get("FRAME_TYPE")?.value;
        return {
            kind: vehicle.vehicleKind,
            firmware: vehicle.firmware,
            frameClass: frameClass === undefined ? null : Math.round(frameClass),
            frameType: frameType === undefined ? null : Math.round(frameType),
            board,
            linkType: endpoint ? endpoint.split(":")[0] : null,
        };
    }, [vehicle.connected, vehicle.vehicleKind, vehicle.firmware, connection.endpoint, connection.available, live]);

    if (kind === null) return null;

    const environment = system && includeDetails ? environmentText(system, vehicleDetails) : null;
    const fields = FIELDS[kind];
    const missing = fields.filter((f) => f.required && !draft[f.key].trim());
    const update = (key: keyof FeedbackDraft, value: string) => setFeedbackDraft({...draft, [key]: value});

    const copyReport = async () => {
        try {
            await navigator.clipboard.writeText(reportMarkdown(kind, draft, environment));
            setNotice({tone: "ok", text: "Report copied. Paste it wherever you'd like to send it."});
        } catch {
            setNotice({tone: "danger", text: "Couldn't copy to the clipboard."});
        }
    };

    const continueToGitHub = async () => {
        const {url, truncated} = issueUrl(kind, draft, environment);
        try {
            await openUrl(url);
        } catch {
            setNotice({tone: "danger", text: "Couldn't open your browser. Use Copy report and paste it into a new issue instead."});
            return;
        }
        if (truncated) {
            // Too long for a link: the full text goes to the clipboard to
            // paste over the cut version on GitHub. Keep the dialog open so
            // they can see that.
            await navigator.clipboard.writeText(reportMarkdown(kind, draft, environment)).catch(() => {});
            setNotice({
                tone: "warn",
                text: "Your report was too long to fill in completely, so part was cut on GitHub. The full report is copied — paste it in before submitting.",
            });
            return;
        }
        finishFeedback();
    };

    return (
        <Modal title={kind === "bug" ? "Report a bug" : "Request a feature"} onClose={closeFeedback} widthClassName="w-[34rem]">
            <div className="flex flex-col gap-4">
                <div className="flex w-fit border border-border-subtle" role="radiogroup" aria-label="Report type">
                    {(["bug", "feature"] as FeedbackKind[]).map((option) => (
                        <button
                            key={option}
                            type="button"
                            role="radio"
                            aria-checked={kind === option}
                            onClick={() => setFeedbackKind(option)}
                            className={`h-control-sm px-3 text-label ${
                                kind === option ? "bg-layer-02 text-text-primary" : "text-text-secondary hover:bg-layer-hover-01"
                            }`}
                        >
                            {option === "bug" ? "Bug" : "Feature"}
                        </button>
                    ))}
                </div>

                {fields.map((field) => (
                    <label key={field.key} className="flex flex-col gap-1">
                        <span className="text-label text-text-secondary">
                            {field.label}
                            {field.required && <span className="text-text-helper"> (required)</span>}
                        </span>
                        {field.rows ? (
                            <textarea
                                id={`feedback-${field.key}`}
                                rows={field.rows}
                                value={draft[field.key]}
                                placeholder={field.placeholder}
                                onChange={(event) => update(field.key, event.target.value)}
                                className={`${FIELD} resize-y`}
                            />
                        ) : (
                            <input
                                id={`feedback-${field.key}`}
                                value={draft[field.key]}
                                placeholder={field.placeholder}
                                onChange={(event) => update(field.key, event.target.value)}
                                className={FIELD}
                            />
                        )}
                    </label>
                ))}

                <div className="flex flex-col gap-2">
                    <label className="flex items-center gap-2 text-label text-text-secondary">
                        <input type="checkbox" checked={includeDetails} onChange={(event) => setIncludeDetails(event.target.checked)}/>
                        {kind === "bug" ? "Include app, system and vehicle details" : "Include the app version"}
                    </label>
                    {includeDetails && (
                        <pre className="max-h-32 overflow-auto bg-background px-2 py-1.5 font-mono text-micro text-text-helper">
                            {environment === null
                                ? "Reading…"
                                : kind === "bug"
                                  ? environment
                                  : environment.split("\n")[0]}
                        </pre>
                    )}
                </div>

                <p className="text-label text-text-helper">Continue opens GitHub.</p>

                {notice && (
                    <p className={`text-label ${notice.tone === "ok" ? "text-state-ok" : notice.tone === "warn" ? "text-state-warn" : "text-state-danger"}`}>
                        {notice.text}
                    </p>
                )}

                <div className="flex flex-wrap items-center justify-end gap-2">
                    <button
                        type="button"
                        onClick={() => void copyReport()}
                        className="h-control-sm border border-border-strong px-3 text-label text-text-primary hover:bg-layer-hover-01"
                    >
                        Copy report
                    </button>
                    <button
                        type="button"
                        onClick={closeFeedback}
                        className="h-control-sm px-3 text-label text-text-secondary hover:text-text-primary"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        disabled={missing.length > 0}
                        title={missing.length > 0 ? `Fill in: ${missing.map((f) => f.label).join(", ")}` : undefined}
                        onClick={() => void continueToGitHub()}
                        className="h-control-sm bg-blue-60 px-3 text-label text-text-on-color hover:enabled:bg-blue-50 disabled:opacity-50"
                    >
                        Continue to GitHub
                    </button>
                </div>
            </div>
        </Modal>
    );
}
