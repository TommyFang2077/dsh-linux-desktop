const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('workbenchUpdates', {
  invoke: (action, channel) => ipcRenderer.invoke('dsh-workbench:updates', action, channel),
})
