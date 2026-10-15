const { contextBridge, ipcRenderer } = require('electron');
const methods = ['getState','saveProfile','saveProject','saveItem','deleteItem','saveCard','reviewCard','createChat','chat','cancelChat','getAiSettings','updateAiSettings','connectChatGPT','disconnectChatGPT','listModels','importDocuments','searchSources','addSource','exportProject','importProject','getSyncStatus','startHosting','stopHosting','joinGroup','leaveGroup','startInternetRoom','openSharedFile','updateSharedFile','closeSharedFile','getIntegrationInfo','doctorOneNote','listOneNotePages','importOneNotePages','openExternal','openOriginal','copyText'];
const api = Object.fromEntries(methods.map(method => [method, argument => ipcRenderer.invoke(`sammen:${method}`, argument)]));
for (const method of ['getRemoteDeviceStatus','startRemoteDevice','stopRemoteDevice','getStartupOptions','acknowledgeDeviceSetup','getUpdateStatus','checkForUpdates']) api[method] = argument => ipcRenderer.invoke(`sammen:${method}`, argument);
for (const [method, channel] of [['onState','sammen:state'], ['onChatDelta','sammen:chat-delta'], ['onFileCollaboration','sammen:file-collaboration'], ['onRemoteDeviceStatus','sammen:remote-device-status'], ['onUpdateStatus','sammen:update-status']]) {
  api[method] = callback => {
    if (typeof callback !== 'function') throw new TypeError('En callback er påkrevd.');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}
contextBridge.exposeInMainWorld('sammen', Object.freeze(api));
