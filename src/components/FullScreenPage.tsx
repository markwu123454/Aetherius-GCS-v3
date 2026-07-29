import {ReactNode} from "react";
import {ArrowLeft} from "@carbon/icons-react";
import {useNavigation} from "../navigation/useNavigation";

interface FullScreenPageProps {
    title: string;
    children: ReactNode;
}

/**
 * The one shell every full-screen page renders through, so navigating in and
 * out of any of them looks and behaves identically — the back control lives
 * here once, rather than being rebuilt per page. The top bar above this is
 * untouched: it never needs to know a page is open.
 */
export default function FullScreenPage({title, children}: FullScreenPageProps) {
    const {closePage} = useNavigation();

    return (
        <div className="flex h-full w-full flex-col bg-background">
            <div className="flex h-control-sm shrink-0 items-center gap-2 border-b border-border-subtle px-1">
                <button
                    type="button"
                    onClick={closePage}
                    aria-label="Back"
                    className="flex h-control-sm w-8 items-center justify-center text-text-secondary hover:bg-layer-hover-01 hover:text-text-primary"
                >
                    <ArrowLeft size={16}/>
                </button>
                <span className="text-label text-text-primary">{title}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">{children}</div>
        </div>
    );
}
