import React, { useEffect, useState } from 'react';
import './styles.css';

export function TextPreview({ content, title, isEditable = false, onSave }) {
    const [showOverlay, setShowOverlay] = useState(false);
    const [showModal, setShowModal] = useState(false);
    const [editedContent, setEditedContent] = useState(content);

    const handleSave = () => {
        onSave(editedContent);
        setShowModal(false);
    };

    const handleCancel = () => {
        setEditedContent(content); // Reset if canceling
        setShowModal(false);
    };

    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.key === 'Escape') {
                setShowOverlay(false);
                setShowModal(false); // optional: close modal too if needed
            }
        };

        window.addEventListener('keydown', handleKeyDown);

        return () => {
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, []);

    return (
        <div
            className="textPreviewContainer"
            onMouseEnter={() => isEditable && setShowOverlay(true)}
            onMouseLeave={() => isEditable && setShowOverlay(false)}
        >
            <p className="textPreviewTitle">{title}</p>
            <div className="textPreview">
                {content.split('\n\n').map((para, i) => (
                    <p key={i} className="textPreview-paragraph">{para}</p>
                ))}
                <div className="textPreview-fade" />
                {showOverlay && (
                    <div className="textPreviewEditorOverlay" onClick={() => setShowModal(true)}>
                        <span>Edit?</span>
                    </div>
                )}
            </div>


            {showModal && (
                <div className="modalOverlay">
                    <div className="modalContent">
                        <h3>Edit Article</h3>
                        <textarea
                            className="wysiwygTextArea"
                            value={editedContent}
                            onChange={(e) => setEditedContent(e.target.value)}
                        />
                        <div className="modalButtons">
                            <button onClick={handleSave}>Save</button>
                            <button onClick={handleCancel}>Cancel</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default TextPreview;
