const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('clearwater', {
    state: () => ipcRenderer.invoke('clearwater:state'),
    saveUsername: name => ipcRenderer.invoke('clearwater:username', name),
    play: () => ipcRenderer.invoke('clearwater:play'),
    cancel: () => ipcRenderer.invoke('clearwater:cancel'),
    profile: () => ipcRenderer.invoke('clearwater:profile'),
    gameLog: () => ipcRenderer.invoke('clearwater:game-log'),
    closeWindow: () => ipcRenderer.invoke('clearwater:close'),
    onProgress: callback => ipcRenderer.on('clearwater:progress', (_event, data) => callback(data))
});
