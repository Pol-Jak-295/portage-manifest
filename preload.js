const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  searchPackages: (query) => ipcRenderer.invoke('search-packages', query),
  fetchReadme: (pkg) => ipcRenderer.invoke('fetch-readme', pkg),
  getGtkCss: () => ipcRenderer.invoke('get-gtk-css')
});
