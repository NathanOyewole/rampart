import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ChangelogPage, StatusPage } from "./pages";
import { DocsPage } from "./docs";
import "./styles.css";

const path = window.location.pathname.replace(/\/$/, "") || "/";
const Page = path === "/changelog"
  ? ChangelogPage
  : path === "/status"
  ? StatusPage
  : path.startsWith("/docs")
  ? () => <DocsPage path={path} />
  : App;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Page />
  </StrictMode>
);
