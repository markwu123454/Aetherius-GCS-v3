/** One row of `useInspectorStats` — one per distinct MAVLink message type
 * seen since launch (or since the last Clear). `history` is up to the 10
 * most recent messages of this type, newest first, each whatever
 * `serde_json::to_value` produced for it on the Rust side: every field the
 * message carries, plus a `type` tag naming the variant — nothing here
 * needs updating when a new message type starts arriving. */
export interface InspectorRow {
    name: string;
    count: number;
    hz: number;
    ageMs: number;
    history: Record<string, unknown>[];
}
