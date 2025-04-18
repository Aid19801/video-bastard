import React, { useEffect, useState } from 'react'
import ContentContainer from "../../components/content-container"
import LinkInput from "../../components/input"

import "./styles.css"
import { BeatLoader } from 'react-spinners'
import TextPreview from '../../components/text-preview'

const HomePage = () => {

    const [url, setUrl] = useState(null)
    const [fetchingScrape, setFetchingScrape] = useState(false)
    const [scrapedContent, setScrapedContent] = useState(null)
    const [showParaphrasing, setShowParaphrasing] = useState(false)


    const handleNewsURL = (event) => {
        console.log("event", event.target.value)
        setUrl(event.target.value)
    }

    const handleClear = () => {
        setFetchingScrape(false)
        setUrl("")
        setScrapedContent(null)
        setShowParaphrasing(false)
        window.scrollTo({
            top: 0,
            behavior: 'smooth',
        });
    }

    useEffect(() => {
        if (!url) return

        const fetchScrapedContent = async () => {
            try {
                setFetchingScrape(true)
                setScrapedContent(null)
                const result = await window.scraper.scrapeURL(url);
                if (result.success) {
                    setScrapedContent(result.content);
                    setFetchingScrape(false)

                    setShowParaphrasing(true);

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

            {fetchingScrape && <BeatLoader />}
            {scrapedContent && <TextPreview content={scrapedContent} />}
            {showParaphrasing && (
                <p className="paraphrasing-text">paraphrasing new script...</p>
            )}

        </ContentContainer>
    )
}

export default HomePage