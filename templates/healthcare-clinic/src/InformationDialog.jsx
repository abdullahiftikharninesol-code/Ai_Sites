import React, { useEffect, useRef } from "react";
import { Link } from "react-router-dom";

export function InformationDialog({ title, children, onClose }) {
  const ref = useRef(null);
  useEffect(() => { ref.current.showModal(); }, []);
  return <dialog ref={ref} className="information-dialog" aria-labelledby="information-title" onClose={onClose}>
    <span className="eyebrow">Harbor Health</span>
    <h2 id="information-title">{title}</h2>
    {children}
    <div className="information-actions"><Link to="/contact">Contact our team →</Link><button type="button" onClick={() => ref.current.close()}>Close details</button></div>
  </dialog>;
}
