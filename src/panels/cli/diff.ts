/** One line of a line diff: kept (` `), removed (`-`) or added (`+`), with
 * its line number in the old or new text. */
export interface DiffLine {
    kind: " " | "-" | "+";
    text: string;
    oldNo: number | null;
    newNo: number | null;
}

/** Above this many old×new line pairs the LCS table gets too big to build
 * in the panel; the caller shows the new file whole instead. */
const MAX_CELLS = 4_000_000;

/**
 * Line diff by longest common subsequence. `null` when the files are too
 * large to diff here.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] | null {
    const a = oldText.split(/\r?\n/);
    const b = newText.split(/\r?\n/);
    if (a.length * b.length > MAX_CELLS) return null;
    const n = a.length;
    const m = b.length;
    const lcs: Uint32Array[] = Array.from({length: n + 1}, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }
    const out: DiffLine[] = [];
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
        if (i < n && j < m && a[i] === b[j]) {
            out.push({kind: " ", text: a[i], oldNo: i + 1, newNo: j + 1});
            i++;
            j++;
        } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) {
            out.push({kind: "+", text: b[j], oldNo: null, newNo: j + 1});
            j++;
        } else {
            out.push({kind: "-", text: a[i], oldNo: i + 1, newNo: null});
            i++;
        }
    }
    return out;
}

/** Only the changed lines and `context` lines around them; `null` entries
 * mark skipped stretches. */
export function hunks(lines: DiffLine[], context = 3): (DiffLine | null)[] {
    const keep = new Array(lines.length).fill(false);
    lines.forEach((line, index) => {
        if (line.kind !== " ") {
            for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = true;
        }
    });
    const out: (DiffLine | null)[] = [];
    let skipped = false;
    lines.forEach((line, index) => {
        if (keep[index]) {
            out.push(line);
            skipped = false;
        } else if (!skipped) {
            out.push(null);
            skipped = true;
        }
    });
    return out;
}

export function countChanges(lines: DiffLine[]): {added: number; removed: number} {
    return {
        added: lines.filter((l) => l.kind === "+").length,
        removed: lines.filter((l) => l.kind === "-").length,
    };
}
