import React from 'react'
import "./styles.css"

export function ParaphrasedArticle({
    content
}) {
    return (
        <div className={`paraphrasedArticleContainer`}>
            {content.split('\n\n').map((para, idx) => (
                <p key={idx}>{para}</p>
            ))}
        </div>
    )
}

export default ParaphrasedArticle