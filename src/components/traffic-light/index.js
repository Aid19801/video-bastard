import React from 'react'
import "./styles.css"

export function TrafficLight({
    scrapedContent,
    avatarGenerated,
    paraphrasedArticle
}) {
    return (
        <div className="trafficLightsContainer">
            <div className="flex-row">
                <p className="status">scraped content: </p>
                <span className="trafficLight" style={{ background: scrapedContent ? "green" : "grey" }} />
            </div>
            <div className="flex-row">
                <p className="status">paraphrasing the article: </p>
                <span className="trafficLight" style={{ background: paraphrasedArticle ? "green" : "grey" }} />
            </div>
            <div className="flex-row">
                <p className="status">audio generated: </p>
                <span className="trafficLight" style={{ background: avatarGenerated ? "green" : "grey" }} />
            </div>
        </div>
    )
}

export default TrafficLight