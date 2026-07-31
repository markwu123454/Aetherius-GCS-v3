import {ReactNode} from "react";

interface FullScreenPageProps {
    children: ReactNode;
}

/**
 * The content area every full-screen page renders through. The back control
 * and title used to live in a header here, but that meant every page paid
 * for a second bar under the top bar just to hold one button and a label —
 * `TopBar` renders that inline next to the hamburger now, since it already
 * owns the one strip that's always on screen.
 *
 * Positioned over the workspace rather than replacing it, so the map keeps its
 * WebGL context, camera and tile cache while a page is open — see `App`. It
 * covers rather than hides the workspace (opaque background, `inset-0`), which
 * is what keeps the map from seeing a 0×0 resize on the way in and out.
 */
export default function FullScreenPage({children}: FullScreenPageProps) {
    return <div className="absolute inset-0 z-10 overflow-auto bg-background">{children}</div>;
}
