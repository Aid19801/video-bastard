import React from 'react'
import "./styles.css"

export function LinkInput({
    placeholder,
    onChange,
    name,
    disabled,
    value,
    clearItem
}) {
    const showClear = value && value.length > 0;

    return (
        <div className={`linkInputContainer ${showClear ? 'has-clear' : ''}`}>
            <input
                className="linkInput"
                placeholder={placeholder}
                onChange={onChange}
                name={name}
                type="text"
                disabled={disabled}
                value={value}
            />
            {showClear && (
                <button className="clearButton" onClick={clearItem}>
                    clear
                </button>
            )}
        </div>
    )
}

export default LinkInput