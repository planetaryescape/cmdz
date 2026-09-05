import { expect, test } from "bun:test";
import { createWorkspace, probe } from "./testing/workspace";

test("mouse focus, Ctrl-Z, and paste share the same input boundary", async () => {
  const ui = await createWorkspace([probe]);
  try {
    await ui.waitFor("PROBE_READY");
    await ui.mockInput.pasteBracketedText("DROP");
    await ui.mockMouse.click(30, 3);
    await ui.waitFor("INPUT");
    await ui.mockInput.typeText("qxrjkh?");
    ui.mockInput.pressCtrlC();
    await ui.waitFor("RX:7178726a6b683f03");
    ui.mockInput.pressKey("z", { ctrl: true });
    await ui.waitFor("NAVIGATION");
    await ui.mockInput.pasteBracketedText("DROP");
    ui.mockInput.pressKey("j");
    ui.mockInput.pressKey("k");
    ui.mockInput.pressEnter();
    await ui.waitFor("INPUT");
    await ui.mockInput.pasteBracketedText("ok");
    await ui.waitFor("RX:7178726a6b683f036f6b");
    ui.mockInput.pressKey("z", { ctrl: true });
    ui.mockInput.pressKey("q");
    expect((await ui.running)._tag).toBe("Success");
  } finally {
    await ui.close();
  }
}, 15000);

test("clicking an inactive terminal cannot enter input mode", async () => {
  const ui = await createWorkspace([{ ...probe, autostart: false }]);
  try {
    await ui.waitFor("Probe [idle]");
    await ui.mockMouse.click(30, 3);
    await ui.waitFor("NAVIGATION");
    expect(ui.captureCharFrame()).not.toContain("|  INPUT");
    ui.mockInput.pressEnter();
    await ui.waitFor("PROBE_READY");
    await ui.waitFor("NAVIGATION");
  } finally {
    await ui.close();
  }
});
