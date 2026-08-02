import {useEffect} from "react";

interface ModalProps {
    title: string;
    onClose: () => void;
    children: React.ReactNode;
}

/**
 * A centered dialog with a backdrop, for confirmations serious enough that
 * they shouldn't live in a small inline row a stray click could land on
 * (delete, overwrite). `onClose` fires on Escape or a backdrop click — the
 * caller decides what that means (cancel, in every current use).
 */
export default function Modal({title, onClose, children}: ModalProps) {
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [onClose]);

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-overlay"
            onPointerDown={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div className="w-80 border border-border-subtle bg-layer-01 p-4 shadow-overlay">
                <div className="mb-3 text-heading text-text-primary">{title}</div>
                {children}
            </div>
        </div>
    );
}
