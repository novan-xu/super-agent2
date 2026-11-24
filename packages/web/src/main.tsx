import { text } from "@super-agent2/catalog";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles/prototype.css";
import "./styles/page.css";
import "./styles/material.css";

document.title = text("app.name");

const container = document.getElementById("app");

if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
