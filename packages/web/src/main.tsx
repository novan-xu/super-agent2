import { text } from "@super-agent2/catalog";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

document.title = text("app.name");

const container = document.getElementById("app");

if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
