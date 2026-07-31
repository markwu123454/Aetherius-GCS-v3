/**
 * Airspace class definitions and their default presentation.
 *
 * Deliberately free of any import that pulls in `expand.js` — `settings.ts`
 * needs these defaults, and routing that through the loader would drag the
 * geodesic library into the preferences module graph for no reason.
 */

export type AirspaceClass = "b" | "c" | "d" | "e";

export interface AirspaceClassDefinition {
    id: AirspaceClass;
    label: string;
    /** Palette token supplying the default colour. Palette values, unlike the
     * semantic `--color-layer-01` family, do not change with the display mode,
     * so they can be resolved once when a layer is created. */
    colorToken: string;
    dashed: boolean;
    /** Class E is 15MB and 4,327 features against 2.6MB for B/C/D together, so
     * it stays off until asked for. */
    visible: boolean;
}

/** Chart convention maps onto the palette about as closely as it goes: blue for
 * the B/D pair, red standing in for the magenta of C, and grey for E, which is
 * mostly a background wash over very large areas. */
export const AIRSPACE_CLASSES: AirspaceClassDefinition[] = [
    {id: "b", label: "Class B", colorToken: "--color-blue-60", dashed: false, visible: true},
    {id: "c", label: "Class C", colorToken: "--color-red-50", dashed: false, visible: true},
    {id: "d", label: "Class D", colorToken: "--color-blue-40", dashed: true, visible: true},
    {id: "e", label: "Class E", colorToken: "--color-gray-50", dashed: true, visible: false},
];

export interface AirspaceClassSettings {
    visible: boolean;
    /** `null` means "whatever `colorToken` resolves to" rather than a frozen
     * copy of it, so a palette change in `theme.css` still reaches anyone who
     * never picked a custom colour. */
    color: string | null;
    dashed: boolean;
}

export type AirspaceSettings = Record<AirspaceClass, AirspaceClassSettings>;

export const DEFAULT_AIRSPACE_SETTINGS: AirspaceSettings = Object.fromEntries(
    AIRSPACE_CLASSES.map((definition) => [
        definition.id,
        {visible: definition.visible, color: null, dashed: definition.dashed},
    ]),
) as AirspaceSettings;

export function airspaceDefinition(id: AirspaceClass): AirspaceClassDefinition {
    return AIRSPACE_CLASSES.find((definition) => definition.id === id) ?? AIRSPACE_CLASSES[0];
}
