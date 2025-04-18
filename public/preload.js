const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scraper', {
    scrapeURL: (url) => ipcRenderer.invoke('scrape-url', url),
});
