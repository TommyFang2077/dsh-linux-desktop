const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('migrationProgress', {
  invoke: action => ipcRenderer.invoke('dsh-workbench:migration', action),
})
