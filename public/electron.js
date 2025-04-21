require('dotenv').config();

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { generateSatiricalVersion, generateSatiricalVersionOllama } = require('./paraphrase');
const { generateAvatar } = require('./generate-avatar');

function createWindow() {
    const win = new BrowserWindow({
        width: 1000,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    win.loadURL(
        app.isPackaged
            ? `file://${path.join(__dirname, '../build/index.html')}`
            : 'http://localhost:3000'
    );

    if (!app.isPackaged) {
        win.webContents.openDevTools();
    }
}

app.whenReady().then(createWindow);

// 🗞️ Scrape It
ipcMain.handle('scrape-url', async (event, url) => {
    try {
        const response = await fetch(url);
        const html = await response.text();

        const $ = cheerio.load(html);
        const text = $('p, h1, h2, h3')
            .map((i, el) => $(el).text().trim())
            .get()
            .filter(paragraph =>
                paragraph &&
                !paragraph.includes("Please use Chrome browser for a more accessible video player")
            )
            .join('\n\n');

        return { success: true, content: text || "No readable content found." };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// 📝 Re-Write It
ipcMain.handle("article-paraphraser", async (event, { content, isGPT }) => {

    console.log("content: ", content)
    console.log("isGPT: ", isGPT)

    let result
    if (isGPT) {
        console.log("isGPT true so generating now")
        result = await generateSatiricalVersion(content);
    } else {
        console.log("isGPT false so Ollama now")
        result = await generateSatiricalVersionOllama(content);
    }
    console.log("result back says ", result)
    return result;
});

// 👤 Generate The Avatar To Say it
ipcMain.handle('generate-avatar', async (event, text) => {
    const result = await generateAvatar(text)
    return result
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
