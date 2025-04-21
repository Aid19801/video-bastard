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

async function generateSatiricalVersionOllama(prompt) {
    try {
        const _prompt = `Rewrite this in a snarky, nihilistic way but dont give me any qualifying preface in your response. Just the paraphrased, nihilistic version of this news story. Minimise repition of writing style and phrases. The more nihilistic the beter: ${prompt}`;
        const res = await fetch("http://localhost:11434/api/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "llama3.2:latest",  // or "llama3", depending on what you've pulled
                prompt: _prompt,
                stream: false       // turn on streaming later if you want to get fancy
            }),
        });
        const data = await res.json();
        return {
            success: true,
            content: data.response
        }
    } catch (error) {
        console.log("error: ", error.message)
        return error.message
    }
}

module.exports = { generateSatiricalVersion, generateSatiricalVersionOllama };
