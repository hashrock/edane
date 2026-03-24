import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./hooks/useAuth";
import { isElectron, setupElectronClickThrough } from "./hooks/useElectron";
import App from "./App";
import "./style.css";

// Add electron-mode class to html element for transparent styling
if (isElectron()) {
  document.documentElement.classList.add("electron-mode");
  setupElectronClickThrough();
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);
