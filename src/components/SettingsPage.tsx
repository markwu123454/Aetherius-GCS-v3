import {useState} from "react";
import {SettingsApi} from "../settings/useSettings";
import {SETTINGS_CATEGORIES} from "../settings/categories";
import {SettingsCategoryBody} from "../settings/categoryComponents";

interface SettingsPageProps {
    settings: SettingsApi;
}

export default function SettingsPage({settings}: SettingsPageProps) {
    const [activeId, setActiveId] = useState<string | null>(SETTINGS_CATEGORIES[0]?.id ?? null);

    return (
        <div className="flex h-full w-full">
            <nav className="flex w-48 shrink-0 flex-col border-r border-border-subtle bg-layer-01">
                {SETTINGS_CATEGORIES.map((category) => {
                    const isActive = category.id === activeId;
                    return (
                        <button
                            key={category.id}
                            type="button"
                            aria-current={isActive}
                            onClick={() => setActiveId(category.id)}
                            className={[
                                "px-3 py-2 text-left text-label whitespace-nowrap",
                                isActive
                                    ? "bg-background text-text-primary"
                                    : "text-text-secondary hover:bg-layer-hover-01 hover:text-text-primary",
                            ].join(" ")}
                        >
                            {category.label}
                        </button>
                    );
                })}
            </nav>
            <div className="min-h-0 flex-1 overflow-auto p-6">
                {activeId && <SettingsCategoryBody id={activeId} settings={settings}/>}
            </div>
        </div>
    );
}
