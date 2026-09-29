import {useEffect} from "react";

interface ModalProps {
    title: string;
    onClose: () => void;
    children: React.ReactNode;
    /** Width class for the dialog — confirmations fit the default; a form
     * (the feedback dialog) needs more. */
    widthClassName?: string;
}

/**
 * A centered dialog with a backdrop, for confirmations serious enough that
 * they shouldn't live in a small inline row a stray click could land on
 * (delete, overwrite). `onClose` fires on Escape or a backdrop click — the
 * caller decides what that means (cancel, in every current use).
 */
export default function Modal({title, onClose, children, widthClassName = "w-80"}: ModalProps) {
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
            <div className={`${widthClassName} max-h-[90vh] max-w-[calc(100vw-2rem)] overflow-auto border border-border-subtle bg-layer-01 p-4 shadow-overlay`}>
                <div className="mb-3 text-heading text-text-primary">{title}</div>
                {children}
            </div>
        </div>
    );
}
