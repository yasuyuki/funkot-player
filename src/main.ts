import "./tokens.css";
import { initializeTheme } from "./lib/theme.svelte";
import { applyDensity, browserStorage, readDensityPreference } from "./lib/density";
import { mount } from "svelte";
import App from "./App.svelte";

initializeTheme();
applyDensity(document.documentElement, readDensityPreference(browserStorage()));

const target = document.getElementById("app");
if (!target) {
  throw new Error("#app not found");
}

const app = mount(App, { target });

export default app;
