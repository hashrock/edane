const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronPrompt", {
  saveToken: (token) => ipcRenderer.send("save-token", token),
});
