/* The Aetherius mark: a quad-X airframe drawn square, in Carbon's own
   geometry. Drawn in `currentColor` so it takes the surrounding text colour
   rather than carrying a fixed fill of its own. */
export default function Logo({size = 16, className}: {size?: number; className?: string}) {
    return (
        <svg
            viewBox="0 0 100 100"
            width={size}
            height={size}
            fill="currentColor"
            aria-hidden="true"
            className={className}
        >
            <path d="M11 11L89 89M89 11L11 89" stroke="currentColor" strokeWidth={10} fill="none"/>
            <rect x="2" y="2" width="18" height="18"/>
            <rect x="80" y="2" width="18" height="18"/>
            <rect x="2" y="80" width="18" height="18"/>
            <rect x="80" y="80" width="18" height="18"/>
            <rect x="32" y="32" width="36" height="36"/>
        </svg>
    );
}
