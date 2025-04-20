const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scraper', {
    scrapeURL: (url) => ipcRenderer.invoke('scrape-url', url),
});

contextBridge.exposeInMainWorld('electron', {
    invoke: (channel, data) => ipcRenderer.invoke(channel, data),
});
