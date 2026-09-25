// First: seeds the tuned parameter defaults that shipped with this build.
import "./lib/tunedDefaultsBoot";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(<App />);
