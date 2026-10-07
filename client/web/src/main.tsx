import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ChangelogPage, StatusPage } from "./pages";
import "./styles.css";

const path = window.location.pathname.replace(/\/$/, "") || "/";
const Page = path === "/changelog" ? ChangelogPage : path === "/status" ? StatusPage : App;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Page />
  </StrictMode>
);
