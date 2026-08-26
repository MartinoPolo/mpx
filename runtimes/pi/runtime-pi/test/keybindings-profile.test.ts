import { expect, it } from "vitest";
import { createPiRuntimeProfileV1 } from "../src/profile.js";

it("projects the reviewed Pi model and alternate-screen keybindings", () => {
  expect(createPiRuntimeProfileV1().keybindings).toEqual({
    "app.model.select": "alt+p",
    "app.model.cycleBackward": "shift+ctrl+p",
    "tui.altScreen.pageUp": [],
    "tui.altScreen.pageDown": [],
    "tui.altScreen.halfPageUp": "pageUp",
    "tui.altScreen.halfPageDown": "pageDown",
    "tui.altScreen.top": [],
    "tui.altScreen.bottom": [],
  });
});
