import React, { useEffect, useState } from 'react'
import ContentContainer from "../../components/content-container"
import LinkInput from "../../components/input"
import ParaphrasedArticle from "../../components/paraphrased-article"
import { BeatLoader } from 'react-spinners'
import TextPreview from '../../components/text-preview'
import "./styles.css"
import TrafficLights from '../../components/traffic-light'


// FLOW:
// 1. fetchParaphrasedFromGPT()
// 2. set that in state, triggers effect/dependency
// 3. if it exists (paraphrasedArticleFromGPT) get avatar from cache
// 4. if that doesnt exist, fetchAvatarFromDID()
// 5. if [state] avatar exists, render the video

const HomePage = () => {

    const [url, setUrl] = useState(null)
    const [fetchingScrape, setFetchingScrape] = useState(false)
    const [scrapedContent, setScrapedContent] = useState(null)
    const [paraphrasedArticleFromGPT, setParaphrasedArticleFromGPT] = useState(null)
    const [avatarFromDID, setAvatarFromDID] = useState(null)
    const [localError, setError] = useState(null)
    const [isGPT, setIsGPT] = useState(false)

    const handleNewsURL = (event) => {
        setUrl(event.target.value)
    }

    const handleClear = () => {
        setFetchingScrape(false)
        setUrl("")
        setScrapedContent(null)
        setParaphrasedArticleFromGPT(null)
        setAvatarFromDID(null)
        setError(null)
        window.scrollTo({
            top: 0,
            behavior: 'smooth',
        });
    }

    const fetchParaphrasedFromGPT = async (articleText) => {
        try {
            const cachedRaw = localStorage.getItem("cached_article");
            const cachedArticle = cachedRaw ? JSON.parse(cachedRaw) : null;

            if (!cachedArticle) {

                const result = await window.electron.invoke("article-paraphraser", {
                    content: articleText,
                    isGPT,
                });
                if (result && result.success) {
                    console.log("✅ Paraphrased content:", result.content.slice(0, 300) + "...");
                    localStorage.setItem("cached_article", JSON.stringify(result));
                    setParaphrasedArticleFromGPT(result.content)
                } else {
                    console.log("❌ GPT: Failed to paraphrase:", result.response);
                    setError(`❌ GPT: ${result.response}`)
                }
            } else {
                console.log("✅ GPT: retrieved cached paraphrased content:", cachedArticle.content.slice(0, 300) + "...");
                setParaphrasedArticleFromGPT(cachedArticle.content)
            }
        } catch (err) {
            setError(`❌ GPT: ${err.toString()}`)
            console.error("Unexpected error during paraphrasing:", err);
        }
    };

    const fetchAvatarFromDID = async (text) => {
        console.log("passing to node for generate-avatar...")
        const result = await window.electron.invoke("generate-avatar", text);
        if (result && result.success) {
            console.log("✅ D_ID: got avatar, stashing in State, updating cache ", result.videoUrl)
            setAvatarFromDID(result.videoUrl)
            localStorage.setItem("avatar", result.videoUrl)
            console.log("✅ D_ID: avatar MP4 is in cache")
        } else {
            setAvatarFromDID(null)
            console.log("❌ D_ID: Failed To Get Avatar", result.message);
            setError(`❌ D_ID: ${result.message}`)
        }
    };

    useEffect(() => {
        if (!url) return

        const fetchScrapedContent = async () => {
            try {
                setFetchingScrape(true)
                setScrapedContent(null)
                const result = await window.scraper.scrapeURL(url);
                if (result.success) {
                    console.log("✅ SCRAPED: scraped content successfully")
                    setScrapedContent(result.content); // preview it on screen
                    fetchParaphrasedFromGPT(result.content); // send to b/e for GPT paraphrase
                    setFetchingScrape(false)
                } else {
                    console.log(`❌ SCRAPE: ${result.error}`);
                    setError(`❌ SCRAPE: ${result.error}`)
                    setScrapedContent(null);
                    setFetchingScrape(false);
                }
            } catch (err) {
                console.log("❌ SCRAPE: Scraping failed:", err)
                setScrapedContent(null);
                setFetchingScrape(false)
            } finally {
                setFetchingScrape(false);
            }
        }
        fetchScrapedContent()
    }, [url])

    useEffect(() => {
        if (url && paraphrasedArticleFromGPT) {
            console.log("fetching cached avatar...")
            const cachedAvatar = localStorage.getItem("avatar")
            console.log("cached avatar: ", cachedAvatar)
            if (!cachedAvatar) {
                console.log("🟠 CACHE: no cached avatar, so generating one...")
                fetchAvatarFromDID(paraphrasedArticleFromGPT);
            } else {
                console.log("✅ CACHE: cached avatar")
                setAvatarFromDID(cachedAvatar)
            }
        }
    }, [url, paraphrasedArticleFromGPT]);

    return (
        <ContentContainer
            title="Video Bastard"
            description="automagically convert a news story into new content"
        >

            <select
                onChange={(e) => setIsGPT(e.target.value === "GPT")}
                value={isGPT === true ? "GPT" : "OLLAMA"}
                style={{
                    marginBottom: 32,
                    width: 169,
                    borderRadius: 12,
                    padding: `5px 20px`,
                    fontFamily: `monospace`,
                    background: `grey`,
                    color: `lightgrey`,
                }}
            >
                <option value="GPT">GPT (OpenAI)</option>
                <option value="OLLAMA">LLaMA (Local)</option>
            </select>

            <LinkInput
                placeholder="paste news URL here"
                onChange={handleNewsURL}
                name="news_url"
                disabled={fetchingScrape}
                value={url}
                clearItem={handleClear}
            />

            <p className="errorHandler">{localError || ""}</p>

            {url && (
                <>
                    <span style={{ borderBottom: "1px solid rgba(255, 255, 255, 0.4)", width: "400px", marginTop: 0, marginBottom: 30 }} />
                    <TrafficLights
                        scrapedContent={(!fetchingScrape && scrapedContent)}
                        paraphrasedArticle={paraphrasedArticleFromGPT}
                        avatarGenerated={avatarFromDID}
                    />
                    <span style={{ borderBottom: "1px solid rgba(255, 255, 255, 0.4)", width: "400px", marginTop: 20, marginBottom: 30 }} />
                </>
            )}

            {
                <div style={{ display: "flex", flexDirection: paraphrasedArticleFromGPT ? "row" : "column" }}>
                    {scrapedContent && (
                        <TextPreview title="Original: " content={scrapedContent} />
                    )}

                    {paraphrasedArticleFromGPT && (
                        <TextPreview
                            title="AI / New: "
                            content={paraphrasedArticleFromGPT}
                            isEditable
                            onSave={(newText) => {
                                setParaphrasedArticleFromGPT(newText);
                            }}
                        />
                    )}
                </div>
            }

            {paraphrasedArticleFromGPT && (
                <button className="btn" style={{ marginTop: 30, marginBottom: 20 }} onClick={() => console.log("Generating video...")}>
                    Generate Video
                </button>
            )}
            {avatarFromDID && (
                <video controls autoPlay>
                    <source src={avatarFromDID} type="video/mp4" />
                    Your browser does not support /the video tag.
                </video>
            )}
            {/* {!avatarFromDID && (
                <video controls style={{ maxWidth: 500, maxHeight: 300, border: "5px solid orange", borderRadius: 12, marginTop: 30 }}>
                    <source src="https://resource2.heygen.ai/video/transcode/e15dd0a3dccb42d5993a8b0499ecfe4d/1280x720.mp4?response-content-disposition=attachment%3B+filename%2A%3DUTF-8%27%27SeanCombs%2520bit.mp4" type="video/mp4" />
                    Your browser does not support /the video tag.
                </video>
            )} */}


        </ContentContainer>
    )
}

export default HomePage