import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG_PATH = path.join(app.getPath("userData"), "config.json");
const API_BASE = "https://edane.hashrock.workers.dev";

// --- Config (persists API token) ---

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// --- State ---

let tray = null;
let win = null;

// --- Notes fetching ---

async function fetchNotes(token) {
  try {
    const res = await fetch(`${API_BASE}/api/notes/my`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

// --- Window ---

function createWindow(noteId) {
  if (win) {
    win.close();
    win = null;
  }

  win = new BrowserWindow({
    width: 1280,
    height: 800,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setIgnoreMouseEvents(true, { forward: true });
  win.setVisibleOnAllWorkspaces(true);

  const url = `${API_BASE}/notes/${noteId}/edit?electron=1`;
  win.loadURL(url);

  win.on("closed", () => {
    win = null;
  });
}

// --- Tray ---

async function buildTrayMenu() {
  const cfg = loadConfig();
  const token = cfg.token;

  if (!token) {
    return Menu.buildFromTemplate([
      {
        label: "API トークンを設定...",
        click: () => promptForToken(),
      },
      { type: "separator" },
      { label: "終了", click: () => app.quit() },
    ]);
  }

  const notes = await fetchNotes(token);

  const noteItems = notes.map((n) => ({
    label: n.title || "Untitled",
    click: () => createWindow(n.id),
  }));

  if (noteItems.length === 0) {
    noteItems.push({ label: "(ノートがありません)", enabled: false });
  }

  return Menu.buildFromTemplate([
    ...noteItems,
    { type: "separator" },
    {
      label: "ノート一覧を更新",
      click: async () => {
        tray.setContextMenu(await buildTrayMenu());
      },
    },
    {
      label: "ウィンドウを閉じる",
      click: () => {
        if (win) {
          win.close();
          win = null;
        }
      },
      enabled: !!win,
    },
    { type: "separator" },
    {
      label: "API トークンを変更...",
      click: () => promptForToken(),
    },
    { label: "終了", click: () => app.quit() },
  ]);
}

function promptForToken() {
  const prompt = new BrowserWindow({
    width: 480,
    height: 200,
    frame: true,
    transparent: false,
    alwaysOnTop: true,
    resizable: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, "preload-prompt.cjs") },
  });

  prompt.loadFile(path.join(__dirname, "token-prompt.html"));

  ipcMain.once("save-token", async (_event, token) => {
    const cfg = loadConfig();
    cfg.token = token.trim();
    saveConfig(cfg);
    prompt.close();
    tray.setContextMenu(await buildTrayMenu());
  });

  prompt.on("closed", () => {
    ipcMain.removeAllListeners("save-token");
  });
}

// --- IPC for click-through ---

ipcMain.on("set-ignore-mouse-events", (_event, ignore, opts) => {
  if (win) {
    win.setIgnoreMouseEvents(ignore, opts || {});
  }
});

// --- App lifecycle ---

app.dock?.hide(); // Hide dock icon on macOS (tray-only app)

app.whenReady().then(async () => {
  // Create tray icon from SVG
  const svgIcon = `<svg width="16" height="16" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M80.5 57.6967C60.5 51.6967 55.8982 49.9489 20 83.1967" stroke="black" stroke-width="16" stroke-linecap="round"/>
    <path d="M73.5 18.1967C73.5 18.1967 73.5 31 68 52.6967" stroke="black" stroke-width="16" stroke-linecap="round"/>
  </svg>`;
  const image = nativeImage.createFromBuffer(Buffer.from(svgIcon));
  image.setTemplateImage(true);

  tray = new Tray(image);
  tray.setToolTip("Edane");
  tray.setContextMenu(await buildTrayMenu());
});

app.on("window-all-closed", (e) => {
  // Don't quit — stay in tray
  e?.preventDefault?.();
});
