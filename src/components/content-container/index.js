import React from 'react'
import "./styles.css"

export function ContentContainer({
    children,
    title,
    description,
}) {
    return (
        <div className="contentContainer">
            <h1>{title}</h1>
            <p>{description}</p>
            {children}
        </div>
    )
}

export default ContentContainer