require('dotenv').config();

const { app, BrowserWindow, ipcMain } = require('electron');
const OpenAI = require("openai");

const openai = new OpenAI({
    apiKey: process.env.OPENAI_KEY,
});

console.log("process.env.OPENAI_KEY =====>>>>", process.env.OPENAI_KEY)

async function generateSatiricalVersion(scrapedContent) {
    try {
        console.log("scrapedContent has landed", scrapedContent.slice(0, 300)); // for sanity

        const chatResponse = await openai.chat.completions.create({
            model: "gpt-4", // or "gpt-3.5-turbo" if you're using that
            messages: [
                {
                    role: "system",
                    content: "You are a witty satirist who rewrites news articles with a sharp, humorous twist, while still preserving the core ideas."
                },
                {
                    role: "user",
                    content: `Rewrite this news article with satire:\n\n${scrapedContent}`
                }
            ],
            temperature: 0.8,
            max_tokens: 1000,
        });

        const satiricalText = chatResponse.choices[0].message.content;
        return { success: true, content: satiricalText };
    } catch (error) {
        console.error("OpenAI error:", error);
        return { success: false, error: "Failed to generate satire." };
    }
}

module.exports = { generateSatiricalVersion };
