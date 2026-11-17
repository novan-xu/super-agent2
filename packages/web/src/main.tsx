import { text } from "@super-agent2/catalog";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles/prototype.css";
import "./styles/page.css";

document.title = text("app.name");

const light = window.matchMedia("(prefers-color-scheme: light)");
const applyTheme = () => {
  document.documentElement.dataset["theme"] = light.matches ? "light" : "dark";
};
applyTheme();
light.addEventListener("change", applyTheme);

const container = document.getElementById("app");

if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
