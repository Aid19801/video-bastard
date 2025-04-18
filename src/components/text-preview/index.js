import React from 'react'
import './styles.css';

export function TextPreview({ content }) {
    const paragraphs = content.split('\n\n');

    return (
        <div className="textPreview">
            {paragraphs.map((para, i) => (
                <p key={i} className="textPreview-paragraph">{para}</p>
            ))}
            <div className="textPreview-fade" />
        </div>
    )
}

export default TextPreview