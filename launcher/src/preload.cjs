const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('clearwater', {
    state: () => ipcRenderer.invoke('clearwater:state'),
    saveUsername: name => ipcRenderer.invoke('clearwater:username', name),
    play: () => ipcRenderer.invoke('clearwater:play'),
    cancel: () => ipcRenderer.invoke('clearwater:cancel'),
    profile: () => ipcRenderer.invoke('clearwater:profile'),
    gameLog: () => ipcRenderer.invoke('clearwater:game-log'),
    restart: () => ipcRenderer.invoke('clearwater:restart'),
    closeWindow: () => ipcRenderer.invoke('clearwater:close'),
    onLauncherUpdate: callback => ipcRenderer.on('clearwater:launcher-update', (_event, data) => callback(data)),
    onProgress: callback => ipcRenderer.on('clearwater:progress', (_event, data) => callback(data))
});
