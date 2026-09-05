import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";

export function createShortcutHelp(renderer: CliRenderer) {
  const overlay = new BoxRenderable(renderer, {
    id: "shortcut-help",
    position: "absolute",
    width: "100%",
    height: "100%",
    zIndex: 10,
    visible: false,
    backgroundColor: "#141414",
    justifyContent: "center",
    alignItems: "center",
    onMouse: (event) => {
      event.preventDefault();
      event.stopPropagation();
    },
  });
  const panel = new BoxRenderable(renderer, {
    id: "shortcut-help-panel",
    width: "90%",
    maxWidth: 68,
    padding: 1,
    border: true,
    borderColor: "#777777",
  });
  panel.add(new TextRenderable(renderer, {
    id: "shortcut-help-text",
    content: [
      "cmdz shortcuts",
      "",
      "NAVIGATION",
      "j/k or Up/Down   Select command",
      "Enter           Start or focus command",
      "h               Hide/show sidebar",
      "x / r           Stop / restart command",
      "q / Ctrl-C      Quit cmdz",
      "?               Show shortcut help",
      "",
      "INPUT",
      "Ctrl-Z          Return to navigation",
      "Other keys and paste go to the child.",
      "",
      "? or Escape to close",
    ].join("\n"),
  }));
  overlay.add(panel);
  return overlay;
}
