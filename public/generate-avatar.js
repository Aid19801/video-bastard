require('dotenv').config();
const fs = require('fs');
const DidClient = require('@d-id/node-sdk').default;


const MOCK_TEXT = `In the latest season of 'Law & Order: White Collar Assassins', Luigi Mangione, a 26-year old upstart with a penchant for firearms and silencers, is now facing the music and not the kind you can dance to. He's been indicted on federal charges over the untimely demise of Brian Thompson, the CEO of 'UnitedHealthcare'. Yes, you heard right, the head honcho of America's largest private health insurance company was gunned down in the Big Apple last year. This fresh-faced, alleged CEO assassin was officially slapped with two counts of stalking, one count of murder by firearm, and an additional firearm offence for allegedly using a silencer. I mean, seriously Luigi, a silencer? This isn't 'Hitman: The Video Game'.`
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const generateAvatar = async (text) => {
    console.log("1. generateAvatar fired...");
    try {
        console.log("2. authenticating");
        const did = new DidClient(process.env.D_ID_API_KEY);
        console.log("3. authenticated!");

        const creationRes = await did.talks.create({
            script: {
                type: "text",
                input: text
            },
            config: {
                fluent: true,
                pad_audio: 0.0,
            },
        })
        console.log("4. video created, id:", creationRes.id);

        // Now poll the status
        let status = creationRes.status;
        let talkData;
        while (status !== "done") {
            console.log("⏳ Polling for video generation...");
            await delay(2000); // wait 2 seconds between polls
            talkData = await did.talks.get(creationRes.id);
            status = talkData.status;

            if (status === "error") {
                console.error("❌ Avatar generation failed:", talkData);
                return { success: false, error: "Avatar generation failed." };
            }
        }

        console.log("✅ Video ready!", talkData);
        return {
            success: true,
            videoUrl: talkData.result_url,
        };
    } catch (error) {
        console.log("❌ D_ID [Avatar Generation] Fail: ", error.response.statusText, " | ", error.response.data.description)
        return {
            success: false,
            message: `${error.response.statusText} " | " ${error.response.data.kind} ${error.response.data.description}`,
            videoUrl: null,
        };
    }
}

module.exports = {
    generateAvatar
};
