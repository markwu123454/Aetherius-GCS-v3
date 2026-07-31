import {groupLabel, ParamGroup} from "./paramSheet";

/** A relation's leaf is just a real group key; anything else is another
 * relation nesting deeper. Recursive by construction — a `sequential`
 * member can itself branch into a `parentChild`, and vice versa. */
export type GroupNode = string | GroupRelation;

export type GroupRelation =
    /** Repeated instances of the same thing — channels, sensors, ports.
     * Ordered however `members` lists them (numerically, as authored),
     * never re-sorted lexicographically. */
    | {type: "sequential"; label: string; members: GroupNode[]}
    /** `parent` is a real, selectable group that the rest are sub-tables
     * of — e.g. `INS4_` is its own group and `INS4_TCAL_` documents its
     * temperature calibration, not a sibling IMU instance. */
    | {type: "parentChild"; label: string; parent: string; children: GroupNode[]};

export interface GroupTreeNode {
    /** Stable across rebuilds (same vehicle or not) — built from real keys
     * and authored labels, not array position, so expand state survives a
     * firmware switch or a relation-file edit that only adds entries. */
    id: string;
    /** The group to select when this row is clicked, or `null` for a
     * relation node that only exists to hold children. */
    key: string | null;
    label: string;
    count: number;
    /** The portion of `count` that belongs to `key` itself, not its
     * children — 0 for a purely virtual (`key: null`) label. Lets the UI
     * tell "a container that happens to also be a real group" apart from
     * "just a label", which looking the same but behaving differently was
     * confusing. */
    ownCount: number;
    depth: number;
    children: GroupTreeNode[];
    /** True once this row is past `maxDepth` — rendered as a plain leaf
     * with no expand/collapse control, even if it has children of its own
     * (those get flattened into the same list rather than nested further). */
    flattened: boolean;
}

/** OSD's 4-deep real case (OSD → Screens → OSD5_ → its own PARAM1-9) is
 * exactly what this exists to cap — past this, everything still shows, just
 * flattened into one list instead of another collapsible level. */
export const DEFAULT_MAX_EXPANDABLE_DEPTH = 2;

function flattenToLeaves(nodes: GroupTreeNode[], depth: number): GroupTreeNode[] {
    // A virtual (key: null) node contributes nothing on its own once
    // flattening kicks in — only its descendants surface, in order. Depth
    // is rewritten to one flat level rather than kept from wherever the
    // node originally sat — otherwise something 4 levels deep in the data
    // (OSD5_'s own PARAM1-9) would render indented as if it still were,
    // instead of flush with everything else past the cap.
    return nodes.flatMap((node) =>
        node.key === null
            ? flattenToLeaves(node.children, depth)
            : [{...node, depth, children: [], flattened: true}],
    );
}

function convert(
    node: GroupNode,
    depth: number,
    parentId: string,
    counts: Map<string, number>,
    used: Set<string>,
    maxDepth: number,
): GroupTreeNode | null {
    if (typeof node === "string") {
        const count = counts.get(node);
        if (count === undefined) {
            return null; // this vehicle's sheet doesn't have this group
        }
        used.add(node);
        return {
            id: `${parentId}/${node}`,
            key: node,
            label: groupLabel(node),
            count,
            ownCount: count,
            depth,
            children: [],
            flattened: depth >= maxDepth,
        };
    }

    const id = `${parentId}/${node.label}`;
    const rawChildren =
        node.type === "sequential"
            ? node.members
            : node.children;
    const parentKey = node.type === "parentChild" ? node.parent : null;

    if (parentKey !== null && counts.get(parentKey) === undefined) {
        return null;
    }
    if (parentKey !== null) {
        used.add(parentKey);
    }

    const children = rawChildren
        .map((child) => convert(child, depth + 1, id, counts, used, maxDepth))
        .filter((child): child is GroupTreeNode => child !== null);

    if (parentKey === null && children.length === 0) {
        return null; // a sequential family with nothing left to show
    }

    const ownCount = parentKey !== null ? (counts.get(parentKey) ?? 0) : 0;
    const count = ownCount + children.reduce((sum, child) => sum + child.count, 0);
    const flattened = depth >= maxDepth;

    return {
        id,
        key: parentKey,
        label: node.label,
        count,
        ownCount,
        depth,
        children: flattened ? flattenToLeaves(children, depth + 1) : children,
        flattened,
    };
}

/**
 * Folds a hand-maintained relation registry against whatever groups a
 * loaded sheet actually has. Every group the registry doesn't mention stays
 * exactly as before — a flat, alphabetically-sortable top-level entry —
 * so adding one new relation never has to touch the other ~380.
 */
export function buildGroupTree(
    groups: ParamGroup[],
    relations: GroupRelation[],
    maxDepth: number = DEFAULT_MAX_EXPANDABLE_DEPTH,
): GroupTreeNode[] {
    const counts = new Map(groups.map((g) => [g.key, g.params.length]));
    const used = new Set<string>();

    const relationNodes = relations
        .map((relation) => convert(relation, 0, "", counts, used, maxDepth))
        .filter((node): node is GroupTreeNode => node !== null);

    const rest = groups
        .filter((g) => !used.has(g.key))
        .map(
            (g): GroupTreeNode => ({
                id: `/${g.key}`,
                key: g.key,
                label: groupLabel(g.key),
                count: g.params.length,
                ownCount: g.params.length,
                depth: 0,
                children: [],
                flattened: true,
            }),
        );

    // Sorted only at the top: a collapsed sidebar should still read
    // alphabetically. Nested `sequential`/`parentChild` children keep
    // whatever order they were authored in — numeric, not lexicographic,
    // which is the entire reason `sequential` exists.
    return [...relationNodes, ...rest].sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Ids of every ancestor that must be expanded to reveal `key` — root first,
 * `key`'s own parent last — or `null` if `key` isn't anywhere in the tree.
 * A group nested inside a family a browsing user hasn't expanded is easy to
 * lose; calling this whenever the selection changes and expanding the
 * result means finding a group (by the group filter, or any other route)
 * always reveals where it actually lives instead of leaving the sidebar
 * looking like nothing happened.
 */
export function findAncestorIds(nodes: GroupTreeNode[], key: string): string[] | null {
    for (const node of nodes) {
        if (node.key === key) {
            return [];
        }
        const nested = findAncestorIds(node.children, key);
        if (nested) {
            return [node.id, ...nested];
        }
    }
    return null;
}
