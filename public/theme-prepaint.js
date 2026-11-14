(() => {
  const root = document.documentElement;
  let preference = "dark";
  try {
    const stored = localStorage.getItem("funkot-player:theme-preference");
    if (stored === "light" || stored === "system") preference = stored;
  } catch {
    // Storage can be unavailable in a WebView; the existing dark default remains usable.
  }
  let dark = preference !== "light";
  if (preference === "system") {
    try {
      dark = matchMedia("(prefers-color-scheme: dark)").matches;
    } catch {
      dark = true;
    }
  }
  root.dataset.theme = dark ? "dark" : "light";
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
  try {
    const density = localStorage.getItem("funkot-player:density-preference");
    if (density === "mouse" || density === "touch") root.dataset.density = density;
  } catch {
    // Without storage the control size follows the pointer.
  }
})();
