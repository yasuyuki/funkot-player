import "./tokens.css";
import { initializeTheme } from "./lib/theme.svelte";
import { applyDensity, browserStorage, readDensityPreference } from "./lib/density";
import { mount } from "svelte";
import App from "./App.svelte";

initializeTheme();
applyDensity(document.documentElement, readDensityPreference(browserStorage()));

// The WebView's own menu (reload, print, inspect) is not part of the app.
// Rows with a menu of their own have already claimed the event by now; a
// text field keeps the native menu, which is where paste lives, and so does
// the log view, whose text is there to be copied into a report.
const TEXT_INPUT_TYPES = new Set(["text", "search", "number", "url", "email", "password", "tel"]);
document.addEventListener("contextmenu", (event) => {
  const field = event.target instanceof Element ? event.target.closest("input, textarea, [contenteditable], .log-view") : null;
  if (field && (!(field instanceof HTMLInputElement) || TEXT_INPUT_TYPES.has(field.type))) return;
  event.preventDefault();
});

const target = document.getElementById("app");
if (!target) {
  throw new Error("#app not found");
}

const app = mount(App, { target });

export default app;
