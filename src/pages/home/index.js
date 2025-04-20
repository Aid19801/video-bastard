import React, { cache, useEffect, useState } from 'react'
import ContentContainer from "../../components/content-container"
import LinkInput from "../../components/input"
import ParaphrasedArticle from "../../components/paraphrased-article"
import { BeatLoader } from 'react-spinners'
import TextPreview from '../../components/text-preview'
import "./styles.css"
import TrafficLight from '../../components/traffic-light'

const HomePage = () => {

    const [url, setUrl] = useState(null)
    const [fetchingScrape, setFetchingScrape] = useState(false)
    const [scrapedContent, setScrapedContent] = useState(null)
    const [paraphrasedArticle, setParaphrasedArticle] = useState(null)
    const [avatar, setAvatar] = useState(null)
    const handleNewsURL = (event) => {
        setUrl(event.target.value)
    }

    const handleClear = () => {
        setFetchingScrape(false)
        setUrl("")
        setScrapedContent(null)
        setParaphrasedArticle(null)
        setAvatar(null)
        window.scrollTo({
            top: 0,
            behavior: 'smooth',
        });
    }

    const fetchParaphrased = async (articleText) => {
        try {
            const cachedRaw = localStorage.getItem("cached_article");
            const cachedArticle = cachedRaw ? JSON.parse(cachedRaw) : null;

            if (!cachedArticle) {
                const result = await window.electron.invoke("loaded-original-article", articleText);
                if (result.success) {
                    console.log("✅ Paraphrased content:", result.content.slice(0, 300) + "...");
                    localStorage.setItem("cached_article", JSON.stringify(result));
                    setParaphrasedArticle(result.content)
                } else {
                    console.error("❌ Failed to paraphrase:", result.error);
                }
            } else {
                console.log("🟠 retrieved cached paraphrased content:", cachedArticle.content.slice(0, 300) + "...");
                setParaphrasedArticle(cachedArticle.content)
                setTimeout(() => {
                }, 100)
            }
        } catch (err) {
            console.error("Unexpected error during paraphrasing:", err);
        }
    };

    const createAvatar = async (text) => {
        console.log("4. calling electron window electron invoke generate-avatar...")
        const result = await window.electron.invoke("generate-avatar", text);
        if (result.success) {
            console.log("5. got avatar, stashing in State, updating cache ", result.videoUrl)
            setAvatar(result.videoUrl)
            localStorage.setItem("avatar", result.videoUrl)
        } else {
            console.log("5. DIDN'T get avatar", result);
            setAvatar(null)
            console.error("Failed to generate avatar.");
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
                    setScrapedContent(result.content); // preview it on screen
                    fetchParaphrased(result.content); // send to b/e for GPT paraphrase
                    setFetchingScrape(false)

                    setTimeout(() => {
                        window.scrollTo({
                            top: 700,
                            behavior: 'smooth',
                        });
                    }, 200);
                } else {
                    setScrapedContent(`Error: ${result.error}`);
                    setFetchingScrape(false);
                }
            } catch (err) {
                console.error("Scraping failed:", err)
                setScrapedContent("Unexpected error occurred.");
                setFetchingScrape(false)
            } finally {
                setFetchingScrape(false);
            }
        }
        fetchScrapedContent()
    }, [url])

    useEffect(() => {
        if (paraphrasedArticle) {
            console.log("1. fetching cached avatar...")
            const cachedAvatar = localStorage.getItem("avatar")
            console.log("2. cached avatar...", cachedAvatar)
            if (!cachedAvatar) {
                console.log("3. no cached avatar, so generating one...")
                createAvatar(paraphrasedArticle);
            } else {
                setAvatar(cachedAvatar)
            }
        }
    }, [paraphrasedArticle]);

    return (
        <ContentContainer
            title="Video Bastard"
            description="automagically convert a news story into new content"
        >

            <LinkInput
                placeholder="paste news URL here"
                onChange={handleNewsURL}
                name="news_url"
                disabled={fetchingScrape}
                value={url}
                clearItem={handleClear}
            />

            {url && (
                <TrafficLight
                    scrapedContent={(!fetchingScrape && scrapedContent)}
                    paraphrasedArticle={paraphrasedArticle}
                    avatarGenerated={avatar}
                />
            )}
            {fetchingScrape && <BeatLoader />}

            {scrapedContent && <TextPreview content={scrapedContent} />}

            <hr />
            <hr />
            <hr />
            <hr />
            <hr />
            {paraphrasedArticle && (
                <ParaphrasedArticle
                    content={paraphrasedArticle}
                />
            )}

            {avatar && (
                <video controls autoPlay>
                    <source src={avatar} type="video/mp4" />
                    Your browser does not support /the video tag.
                </video>
            )}


        </ContentContainer>
    )
}

export default HomePage