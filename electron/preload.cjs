const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  setIgnoreMouseEvents: (ignore, opts) =>
    ipcRenderer.send("set-ignore-mouse-events", ignore, opts),
});
