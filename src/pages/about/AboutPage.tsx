import {useEffect, useState} from "react";
import {getVersion} from "@tauri-apps/api/app";
import {LogoGithub} from "@carbon/icons-react";
import {UpdateCheck} from "@/lib/update/useUpdateCheck.ts";

const REPO_URL = "https://github.com/markwu123454/Aetherius-GCS-v3";

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function UpdateSection({update}: {update: UpdateCheck}) {
    return (
        <section className="flex flex-col gap-2">
            <h2 className="text-heading text-text-primary">Updates</h2>

            {update.status === "idle" && (
                <button
                    type="button"
                    onClick={() => void update.checkNow()}
                    className="w-fit border border-border-strong bg-layer-02 px-3 py-1.5 text-body text-text-primary hover:bg-layer-hover-02"
                >
                    Check for Updates
                </button>
            )}

            {update.status === "checking" && (
                <p className="text-body text-text-secondary">Checking for updates…</p>
            )}

            {update.status === "up-to-date" && (
                <div className="flex flex-col gap-2">
                    <p className="text-body text-text-secondary">
                        You're on the latest version{update.currentVersion ? ` (v${update.currentVersion})` : ""}.
                    </p>
                    <button
                        type="button"
                        onClick={() => void update.checkNow()}
                        className="w-fit border border-border-strong bg-layer-02 px-3 py-1.5 text-body text-text-primary hover:bg-layer-hover-02"
                    >
                        Check Again
                    </button>
                </div>
            )}

            {update.status === "available" && (
                <div className="flex flex-col gap-2">
                    <p className="text-body text-text-secondary">
                        Update {update.latestVersion ? `v${update.latestVersion}` : ""} is available
                        {update.currentVersion ? ` (currently on v${update.currentVersion})` : ""}.
                    </p>
                    {update.releaseNotes && (
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap border border-border-subtle bg-layer-01 p-2 font-sans text-label text-text-helper">
                            {update.releaseNotes}
                        </pre>
                    )}
                    <button
                        type="button"
                        onClick={() => void update.installAndRelaunch()}
                        className="w-fit border border-border-strong bg-layer-02 px-3 py-1.5 text-body text-text-primary hover:bg-layer-hover-02"
                    >
                        Download &amp; Install
                    </button>
                </div>
            )}

            {update.status === "downloading" && (
                <p className="text-body text-text-secondary">
                    Downloading update…{" "}
                    {update.totalBytes
                        ? `${formatBytes(update.downloadedBytes)} / ${formatBytes(update.totalBytes)}`
                        : formatBytes(update.downloadedBytes)}
                </p>
            )}

            {update.status === "ready" && (
                <p className="text-body text-text-secondary">Update installed. Relaunching…</p>
            )}

            {update.status === "error" && (
                <div className="flex flex-col gap-2">
                    <p className="text-body text-state-danger">{update.error ?? "Update check failed."}</p>
                    <button
                        type="button"
                        onClick={() => void update.checkNow()}
                        className="w-fit border border-border-strong bg-layer-02 px-3 py-1.5 text-body text-text-primary hover:bg-layer-hover-02"
                    >
                        Try Again
                    </button>
                </div>
            )}
        </section>
    );
}

interface AboutPageProps {
    update: UpdateCheck;
}

export default function AboutPage({update}: AboutPageProps) {
    const [version, setVersion] = useState<string | null>(null);

    useEffect(() => {
        getVersion()
            .then(setVersion)
            .catch(() => setVersion(null));
    }, []);

    return (
        <div className="min-h-0 flex-1 overflow-auto p-6">
            <div className="flex max-w-2xl flex-col gap-8">
                <section className="flex flex-col gap-2">
                    <h2 className="text-heading text-text-primary">Aetherius GCS</h2>
                    <p className="text-body text-text-secondary">
                        {version ? `Version ${version}` : "Version unknown"}
                    </p>
                    <a
                        href={REPO_URL}
                        target="_blank"
                        rel="noreferrer"
                        className="flex w-fit items-center gap-1.5 text-body text-text-secondary underline"
                    >
                        <LogoGithub size={16}/>
                        {REPO_URL.replace("https://", "")}
                    </a>
                </section>

                <UpdateSection update={update}/>

                <section className="flex flex-col gap-3">
                    <h2 className="text-heading text-text-primary">Credits</h2>

                    <p className="text-label text-text-helper">
                        Map imagery:{" "}
                        <a
                            href="https://www.esri.com/"
                            target="_blank"
                            rel="noreferrer"
                            className="underline"
                        >
                            Esri
                        </a>{" "}
                        World Imagery — Esri, Maxar, Earthstar Geographics, and the GIS User Community.
                    </p>

                    <p className="text-label text-text-helper">
                        3D model:{" "}
                        <a
                            href="https://sketchfab.com/3d-models/low-poly-plane-76230052903540e9aeb46b7db35329e4"
                            target="_blank"
                            rel="noreferrer"
                            className="underline"
                        >
                            "Low Poly Plane"
                        </a>{" "}
                        by{" "}
                        <a href="https://sketchfab.com/scailman" target="_blank" rel="noreferrer" className="underline">
                            scailman
                        </a>
                        , licensed{" "}
                        <a
                            href="http://creativecommons.org/licenses/by/4.0/"
                            target="_blank"
                            rel="noreferrer"
                            className="underline"
                        >
                            CC BY 4.0
                        </a>
                        .
                    </p>

                    <p className="text-label text-text-helper">
                        Frame class/type diagrams:{" "}
                        <a
                            href="https://ardupilot.org/copter/docs/connect-escs-and-motors.html"
                            target="_blank"
                            rel="noreferrer"
                            className="underline"
                        >
                            ArduPilot Dev Team
                        </a>
                        , licensed{" "}
                        <a
                            href="https://creativecommons.org/licenses/by-sa/3.0/"
                            target="_blank"
                            rel="noreferrer"
                            className="underline"
                        >
                            CC BY-SA 3.0
                        </a>
                        .
                    </p>
                </section>
            </div>
        </div>
    );
}
