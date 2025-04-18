import React from 'react'
import "./styles.css"

export function LinkInput({
    placeholder,
    onChange,
    name,
    disabled,
    value,
}) {
    return (
        <input
            className="linkInput"
            placeholder={placeholder}
            onChange={onChange}
            name={name}
            type="text"
            disabled={disabled}
            value={value}
        />
    )
}

export default LinkInput