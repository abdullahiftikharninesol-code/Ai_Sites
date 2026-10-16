import React, { useState } from "react";

export function FaqList({ items }) {
  const [openIndex, setOpenIndex] = useState(null);

  return (
    <div className="faq-list">
      {items.map((item, index) => {
        const open = openIndex === index;
        const panelId = `faq-answer-${index}`;
        return (
          <div className="faq-item" key={item.question}>
            <button
              className="faq-question"
              type="button"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setOpenIndex(open ? null : index)}
            >
              {item.question}<span aria-hidden="true">+</span>
            </button>
            <div className="faq-answer" id={panelId} hidden={!open}>
              <p>{item.answer}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
