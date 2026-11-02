/**
 * Telemetry panel — every live reading, grouped into four system cards:
 * Link & health, Power, Flight, Navigation.
 *
 * Each card's header carries a status square (the worst tone among the
 * readings in it that have a health judgment at all — Flight has none, so
 * it never gets one) and a one-line summary. The summary is the card's
 * worst problem while it has one, so a collapsed card still says what's
 * wrong, and its usual headline values otherwise.
 *
 * Values are plain text unless they need attention: only warn/danger is
 * colored, so color on this panel always means "look here".
 *
 * Layout by dock position (see `area` prop):
 *
 * Side dock: cards stacked, worst first — a card with a problem rises above
 * the healthy ones so it's at the top of a scrolled column. Each card
 * collapses from its header; which ones are collapsed is remembered.
 *
 * Bottom dock: the four cards side by side in a fixed order. They're all in
 * view at once there, so reordering would only move things around under the
 * operator's eye without showing anything that wasn't already visible.
 */

import {useEffect, useState} from "react";
import {ChevronDown} from "@carbon/icons-react";
import {useConnection} from "@/lib/vehicle/useConnection.ts";
import {isLinkFailing, isLinkIdle} from "@/lib/vehicle/connection.ts";
import {useArmedSince, useVehicle} from "@/lib/vehicle/useVehicle.ts";
import {useNow} from "@/lib/vehicle/useMockVehicle.ts";
import {useTelemetryHistory, useTelemetrySparklines} from "@/lib/vehicle/useTelemetryHistory.ts";
import {distanceMeters, FixType, fixLabel} from "@/lib/vehicle/vehicle.ts";
import {useSettings} from "@/lib/settings/useSettings.ts";
import {speedUnitDef} from "@/lib/units/speed.ts";
import {verticalSpeedUnitDef} from "@/lib/units/verticalSpeed.ts";
import {altitudeUnitDef} from "@/lib/units/altitude.ts";
import {distanceUnitDef} from "@/lib/units/distance.ts";
import {Tone} from "@/components/topmenu/StatusChip.tsx";
import {PanelArea} from "@/panels/panelComponents.tsx";
import Sparkline from "@/components/Sparkline.tsx";

const DASH = "—";

function formatDuration(totalSeconds: number): string {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const hh = Math.floor(seconds / 3600);
    const mm = (Math.floor(seconds / 60) % 60).toString().padStart(2, "0");
    const ss = (seconds % 60).toString().padStart(2, "0");
    return hh > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

function batteryTone(percent: number): Tone {
    if (percent <= 20) return "danger";
    if (percent <= 30) return "warn";
    return "ok";
}

/** Same rule as the top bar's GPS chip, so the two never disagree. */
function fixTone(fix: FixType): Tone {
    if (fix === "none") return "danger";
    if (fix === "2d") return "warn";
    return "ok";
}

function vibeTone(vibe: number): Tone {
    if (vibe >= 20) return "danger";
    if (vibe >= 10) return "warn";
    return "ok";
}

function lossTone(lossPercent: number): Tone {
    return lossPercent > 2 ? "warn" : "ok";
}

function xteTone(meters: number): Tone {
    if (Math.abs(meters) >= 25) return "danger";
    if (Math.abs(meters) >= 10) return "warn";
    return "ok";
}

function boardVoltageTone(volts: number): Tone {
    if (volts < 4.5) return "danger";
    if (volts < 4.8) return "warn";
    return "ok";
}

const SEVERITY: Record<Tone, number> = {danger: 2, warn: 1, ok: 0, info: 0, neutral: 0};

function worse(a: Tone | undefined, b: Tone | undefined): Tone | undefined {
    if (a === undefined) return b;
    if (b === undefined) return a;
    return SEVERITY[b] > SEVERITY[a] ? b : a;
}

function needsAttention(tone: Tone | undefined): boolean {
    return tone === "warn" || tone === "danger";
}

const VALUE_TEXT: Partial<Record<Tone, string>> = {warn: "text-state-warn", danger: "text-state-danger"};
const DOT_BG: Partial<Record<Tone, string>> = {ok: "bg-state-ok", warn: "bg-state-warn", danger: "bg-state-danger"};
const BAR_BG: Partial<Record<Tone, string>> = {warn: "bg-state-warn", danger: "bg-state-danger"};

interface Reading {
    label: string;
    /** Number (or word) as shown, without its unit — the unit is drawn
     * smaller beside it. `DASH` while nothing has arrived. */
    value: string;
    unit?: string;
    /** Only on readings with a health judgment; what the card's status
     * square and summary are worked out from. */
    tone?: Tone;
    spark?: {values: number[]; tones: Tone[]; minRange: number};
    /** Takes a full row — for a value too long to share one. */
    wide?: boolean;
}

type CardId = "health" | "power" | "flight" | "navigation";

interface Card {
    id: CardId;
    title: string;
    readings: Reading[];
    /** The header's summary while nothing in the card needs attention. */
    summary: string;
    /** Battery charge bar under the header — Power's only. */
    bar?: {percent: number; tone: Tone};
}

function cardTone(card: Card): Tone | undefined {
    return card.readings.reduce<Tone | undefined>((tone, reading) => worse(tone, reading.tone), card.bar?.tone);
}

function cardSummary(card: Card): {text: string; tone: Tone | undefined} {
    const problem = card.readings.reduce<Reading | undefined>(
        (worst, reading) =>
            needsAttention(reading.tone) && (!worst || SEVERITY[reading.tone!] > SEVERITY[worst.tone!]) ? reading : worst,
        undefined,
    );
    return problem
        ? {text: `${problem.label} ${problem.value}${problem.unit ?? ""}`, tone: problem.tone}
        : {text: card.summary, tone: undefined};
}

/** A converted, rounded value split from its unit, or `DASH` for none. */
function measure(raw: number | null | undefined, def: {suffix: string; decimals: number}, convert: (n: number) => number) {
    return raw == null ? {value: DASH} : {value: convert(raw).toFixed(def.decimals), unit: def.suffix};
}

const COLLAPSED_KEY = "aetherius.telemetry.collapsed.v1";
const CARD_IDS: CardId[] = ["health", "power", "flight", "navigation"];

function loadCollapsed(): CardId[] {
    try {
        const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
        return Array.isArray(parsed) ? CARD_IDS.filter((id) => parsed.includes(id)) : [];
    } catch {
        return [];
    }
}

function ModeArmedRow({mode, armed, armedFor, prearmPass, unknown, stale, staleFor}: {
    mode: string;
    armed: boolean;
    armedFor: number | null;
    prearmPass: boolean;
    unknown: boolean;
    stale: boolean;
    staleFor: number | null;
}) {
    return (
        <div className={[
            "flex shrink-0 flex-wrap items-center gap-2 border-b px-2 py-1.5",
            armed ? "border-state-danger bg-state-danger/10" : "border-border-subtle",
        ].join(" ")}>
            <span className="font-mono text-label text-text-primary">{unknown ? DASH : mode}</span>
            <span className={[
                "border px-1.5 py-0.5 text-micro uppercase",
                armed ? "border-state-danger text-state-danger" : "border-border-subtle text-text-helper",
            ].join(" ")}>
                {unknown ? DASH : armed ? "Armed" : "Disarmed"}
            </span>
            {armed && armedFor !== null && (
                <span className="font-mono text-micro text-text-helper tabular-nums">{formatDuration(armedFor)}</span>
            )}
            {!unknown && !prearmPass && !armed && (
                <span className="border border-state-warn px-1.5 py-0.5 text-micro text-state-warn uppercase">
                    Prearm fail
                </span>
            )}
            {stale && <span className="ml-auto text-micro text-state-warn">no data for {staleFor}s</span>}
        </div>
    );
}

function ReadingCell({reading, sparklines}: {reading: Reading; sparklines: boolean}) {
    // History keeps sampling the zeroed placeholder state while nothing is
    // connected, so a trend is only drawn beside a value that's actually live.
    const spark = sparklines && reading.value !== DASH && reading.spark && reading.spark.values.length >= 2 ? reading.spark : null;
    return (
        <div className={`flex min-w-0 flex-col ${reading.wide ? "col-span-full" : ""}`}>
            <span className="truncate text-micro text-text-helper">{reading.label}</span>
            <div className="flex min-w-0 items-center gap-2">
                <span className={`shrink-0 font-mono text-label tabular-nums ${VALUE_TEXT[reading.tone ?? "neutral"] ?? "text-text-primary"}`}>
                    {reading.value}
                    {reading.unit && reading.value !== DASH && (
                        <span className="ml-0.5 text-micro text-text-helper">{reading.unit}</span>
                    )}
                </span>
                {spark && (
                    <Sparkline
                        autoScale
                        quiet
                        minRange={spark.minRange}
                        values={spark.values}
                        tones={spark.tones}
                        className="h-3 min-w-0 flex-1"
                    />
                )}
            </div>
        </div>
    );
}

function SystemCard({card, unknown, sparklines, collapsed, onToggle}: {
    card: Card;
    unknown: boolean;
    sparklines: boolean;
    /** `undefined` where the card can't collapse at all (the bottom dock). */
    collapsed?: boolean;
    onToggle?: () => void;
}) {
    const tone = unknown ? undefined : cardTone(card);
    // Blank rather than a dash with nothing connected: a lone "—" beside the
    // chevron read as a second header control.
    const summary = unknown ? {text: "", tone: undefined} : cardSummary(card);
    const open = collapsed !== true;

    const headerContent = (
        <>
            <span className={`size-2 shrink-0 ${(tone && DOT_BG[tone]) ?? ""}`}/>
            <span className="truncate text-label font-semibold text-text-primary">{card.title}</span>
            <span className={`ml-auto shrink-0 font-mono text-label tabular-nums ${VALUE_TEXT[summary.tone ?? "neutral"] ?? "text-text-secondary"}`}>
                {summary.text}
            </span>
        </>
    );

    return (
        // `shrink-0` keeps a stacked card at its full height so the column
        // scrolls instead; `min-h-0` lets a bottom-dock card fit its grid row
        // and scroll its own body. Each only bites in its own layout.
        <section className="flex min-h-0 min-w-0 shrink-0 flex-col bg-layer-01">
            {onToggle ? (
                <button
                    type="button"
                    onClick={onToggle}
                    aria-expanded={open}
                    className="flex h-7 shrink-0 items-center gap-2 px-3 text-left hover:bg-layer-hover-01"
                >
                    {headerContent}
                    <ChevronDown size={16} className={`shrink-0 text-text-helper transition-transform ${open ? "" : "-rotate-90"}`}/>
                </button>
            ) : (
                <div className="flex h-7 shrink-0 items-center gap-2 px-3">{headerContent}</div>
            )}
            {open && (
                // Spacing is as tight as it is so the tallest card (Link &
                // health, four rows) still fits a default-height bottom dock
                // without scrolling.
                <div className="flex min-h-0 flex-col gap-2 overflow-y-auto px-3 pb-2">
                    {card.bar && (
                        <div className="h-1 w-full shrink-0 bg-layer-02">
                            <div
                                className={`h-full ${BAR_BG[card.bar.tone] ?? "bg-text-helper"} transition-[width] duration-300 ease-productive`}
                                style={{width: `${unknown ? 0 : Math.max(0, Math.min(100, card.bar.percent))}%`}}
                            />
                        </div>
                    )}
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-x-2 gap-y-1">
                        {card.readings.map((reading) => (
                            <ReadingCell key={reading.label} reading={reading} sparklines={sparklines}/>
                        ))}
                    </div>
                </div>
            )}
        </section>
    );
}

export default function TelemetryPanel({area}: {area: PanelArea}) {
    const vehicle = useVehicle();
    const connection = useConnection();
    const now = useNow();
    const history = useTelemetryHistory();
    const sparklines = useTelemetrySparklines();
    const armedSince = useArmedSince();
    const {speedUnit, verticalSpeedUnit, altitudeUnit, distanceUnit} = useSettings();

    const [collapsed, setCollapsed] = useState<CardId[]>(loadCollapsed);
    useEffect(() => {
        try {
            localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed));
        } catch {
            // Not remembering which cards were collapsed is not worth failing over.
        }
    }, [collapsed]);
    const toggle = (id: CardId) =>
        setCollapsed((prev) => (prev.includes(id) ? prev.filter((other) => other !== id) : [...prev, id]));

    const packetAge = vehicle.updatedAt === 0 ? null : now - vehicle.updatedAt;
    const stale = isLinkFailing(connection.status);
    const unknown = isLinkIdle(connection.status) || vehicle.updatedAt === 0;
    const staleFor = stale && packetAge !== null ? Math.round(packetAge / 1000) : null;
    const armedFor = armedSince === null ? null : Math.floor((now - armedSince) / 1000);

    const speed = speedUnitDef(speedUnit);
    const vspeed = verticalSpeedUnitDef(verticalSpeedUnit);
    const altitude = altitudeUnitDef(altitudeUnit);
    const distance = distanceUnitDef(distanceUnit);
    const toSpeed = speed.fromMps;
    const toDistance = distance.fromMeters;

    const {battery, gps, link, ekf, power, nav, wind, position} = vehicle;
    const homeDistance = position && vehicle.home ? distanceMeters(position, vehicle.home) : null;

    // Fields that default to zero rather than null before any packet (battery,
    // GPS, link, EKF) read as "—" until something has actually arrived, rather
    // than as a real zero.
    const known = <T,>(value: T): T | null => (unknown ? null : value);
    const text = (value: string | null) => value ?? DASH;
    const judged = (tone: Tone): Tone | undefined => (unknown ? undefined : tone);

    const altitudeReading = measure(position?.alt, altitude, altitude.fromMeters);
    const groundspeedReading = measure(vehicle.groundspeed, speed, toSpeed);
    const homeReading = measure(homeDistance, distance, toDistance);
    const wpReading = measure(nav?.wpDist, distance, toDistance);

    const health: Card = {
        id: "health",
        title: "Link & health",
        summary: unknown ? DASH : `${fixLabel(gps.fix)} · ${gps.satellites} sats`,
        readings: [
            {label: "GPS", value: text(known(fixLabel(gps.fix))), tone: judged(fixTone(gps.fix))},
            {label: "Sats", value: text(known(String(gps.satellites)))},
            {label: "HDOP", value: text(known(gps.hdop.toFixed(1)))},
            {label: "EKF", value: text(known(ekf.ok ? "OK" : "Bad")), tone: judged(ekf.ok ? "ok" : "danger")},
            {
                label: "Vibration",
                value: text(known(Math.round(ekf.vibe).toString())),
                tone: judged(vibeTone(ekf.vibe)),
                spark: {values: history.map((p) => p.vibe), tones: history.map((p) => vibeTone(p.vibe)), minRange: 5},
            },
            {
                label: "Packet loss",
                value: text(known(link.lossPercent.toFixed(1))),
                unit: "%",
                tone: judged(lossTone(link.lossPercent)),
                spark: {values: history.map((p) => p.lossPercent), tones: history.map((p) => lossTone(p.lossPercent)), minRange: 1},
            },
            {
                label: "RSSI",
                value: text(known(Math.round(link.rssi).toString())),
                spark: {values: history.map((p) => p.rssi), tones: history.map((p) => lossTone(p.lossPercent)), minRange: 20},
            },
        ],
    };

    const powerCard: Card = {
        id: "power",
        title: "Power",
        summary: unknown ? DASH : `${Math.round(battery.percent)}% · ${battery.voltage.toFixed(1)}V`,
        bar: {percent: battery.percent, tone: batteryTone(battery.percent)},
        readings: [
            {label: "Battery", value: text(known(Math.round(battery.percent).toString())), unit: "%", tone: judged(batteryTone(battery.percent))},
            {
                label: "Voltage",
                value: text(known(battery.voltage.toFixed(1))),
                unit: "V",
                spark: {values: history.map((p) => p.voltage), tones: history.map((p) => batteryTone(p.percent)), minRange: 0.5},
            },
            {label: "Current", value: text(known(battery.current.toFixed(1))), unit: "A"},
            {label: "Used", value: text(known(Math.round(battery.consumed).toString())), unit: "mAh"},
            {label: "Board", value: power ? power.boardVoltage.toFixed(2) : DASH, unit: "V", tone: power ? boardVoltageTone(power.boardVoltage) : undefined},
            {label: "Servo rail", value: power ? power.servoVoltage.toFixed(2) : DASH, unit: "V"},
        ],
    };

    const flight: Card = {
        id: "flight",
        title: "Flight",
        summary: `${altitudeReading.value}${altitudeReading.unit ?? ""} · ${groundspeedReading.value}${groundspeedReading.unit ?? ""}`,
        readings: [
            {label: "Altitude", ...altitudeReading},
            {label: "Climb", ...measure(vehicle.climbRate, vspeed, vspeed.fromMps)},
            {label: "Ground speed", ...groundspeedReading},
            ...(vehicle.vehicleKind === "plane" ? [{label: "Airspeed", ...measure(vehicle.airspeed, speed, toSpeed)}] : []),
            {label: "Heading", value: position ? Math.round(position.heading).toString().padStart(3, "0") : DASH, unit: "°"},
            {label: "Throttle", value: vehicle.throttle === null ? DASH : vehicle.throttle.toString(), unit: "%"},
        ],
    };

    const navigation: Card = {
        id: "navigation",
        title: "Navigation",
        summary: vehicle.currentWp !== null && nav
            ? `WP ${vehicle.currentWp} · ${wpReading.value}${wpReading.unit ?? ""}`
            : `Home ${homeReading.value}${homeReading.unit ?? ""}`,
        readings: [
            {label: "Home", ...homeReading},
            {label: "Waypoint", value: vehicle.currentWp === null ? DASH : vehicle.currentWp.toString()},
            {label: "To waypoint", ...wpReading},
            {label: "Cross-track", ...measure(nav?.xtrackError, distance, toDistance), tone: nav ? xteTone(nav.xtrackError) : undefined},
            {
                label: "Wind",
                value: wind ? `${Math.round(wind.dir)}° · ${toSpeed(wind.speed).toFixed(speed.decimals)}` : DASH,
                unit: speed.suffix,
                wide: true,
            },
        ],
    };

    const cards = [health, powerCard, flight, navigation];
    const horizontal = area === "bottom";

    // Stable sort: ties keep the order above, so with nothing wrong the side
    // dock reads the same as the bottom dock.
    const ordered = horizontal || unknown
        ? cards
        : [...cards].sort((a, b) => SEVERITY[cardTone(b) ?? "neutral"] - SEVERITY[cardTone(a) ?? "neutral"]);

    return (
        <div className="flex h-full flex-col bg-background">
            <ModeArmedRow
                mode={vehicle.mode}
                armed={vehicle.armed}
                armedFor={armedFor}
                prearmPass={vehicle.prearmPass}
                unknown={unknown}
                stale={stale}
                staleFor={staleFor}
            />
            {horizontal ? (
                <div className="grid min-h-0 flex-1 auto-cols-[minmax(14rem,1fr)] grid-flow-col grid-rows-[minmax(0,1fr)] gap-2 overflow-x-auto p-2">
                    {ordered.map((card) => (
                        <SystemCard key={card.id} card={card} unknown={unknown} sparklines={sparklines}/>
                    ))}
                </div>
            ) : (
                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
                    {ordered.map((card) => (
                        <SystemCard
                            key={card.id}
                            card={card}
                            unknown={unknown}
                            sparklines={sparklines}
                            collapsed={collapsed.includes(card.id)}
                            onToggle={() => toggle(card.id)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
