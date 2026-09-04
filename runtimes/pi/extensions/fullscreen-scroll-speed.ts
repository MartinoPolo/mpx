import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WHEEL_SCROLL_LINES = 3;
const WIDGET_KEY = "fullscreen-scroll-speed";

type FullscreenTui = {
    mode?: string;
    wheelScrollLines?: number;
};

function applyWheelScrollSpeed(tui: unknown): void {
    const fullscreenTui = tui as FullscreenTui;
    if (fullscreenTui.mode === "fullscreen" && fullscreenTui.wheelScrollLines !== WHEEL_SCROLL_LINES) {
        fullscreenTui.wheelScrollLines = WHEEL_SCROLL_LINES;
    }
}

export default function fullscreenScrollSpeedExtension(pi: ExtensionAPI): void {
    pi.on("session_start", (_event, ctx) => {
        if (ctx.mode !== "tui") {
            return;
        }

        ctx.ui.setWidget(WIDGET_KEY, (tui) => ({
            render: () => {
                applyWheelScrollSpeed(tui);
                return [];
            },
            invalidate: () => applyWheelScrollSpeed(tui),
        }));
    });
}
