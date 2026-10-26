import {useStatusMessages} from "@/lib/topBarStatus.ts";
import {TONE_TEXT} from "./StatusChip.tsx";

/** The middle of the top bar: whatever modules have written with `setStatus`. */
export default function TopBarStatus() {
    const messages = useStatusMessages();

    return (
        <div className="flex min-w-0 flex-1 items-center justify-center gap-4 overflow-hidden px-3 text-label whitespace-nowrap tabular-nums">
            {messages.map((message) => (
                <span key={message.source} className="truncate text-text-secondary">
                    {message.segments.map((segment, index) => (
                        <span key={index} className={segment.tone ? TONE_TEXT[segment.tone] : undefined}>
                            {segment.text}
                        </span>
                    ))}
                </span>
            ))}
        </div>
    );
}
