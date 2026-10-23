import React, { useEffect, useRef } from "react";
import { Link } from "react-router-dom";

const stories = [
  "Start with the landscape: the Hudson Valley brings together river towns, independent makers and places to slow down. When considering a country home, take time to explore the local markets and everyday journeys as well as the property itself.",
  "A retreat is more than a secluded address. Consider how daylight moves through the rooms, how indoor spaces connect to the outdoors, and where you would gather or find quiet. These everyday details help a home feel restorative.",
  "Natural materials gain character through use. Notice the grain of timber, the texture of stone and how each surface responds to light. When viewing a home, ask about their provenance, maintenance and the care that will help them last.",
];

export function StoryDialog({ story, onClose }) {
  const ref = useRef(null);
  useEffect(() => { ref.current.showModal(); }, []);
  return <dialog ref={ref} className="story-dialog" aria-labelledby="story-title" onClose={onClose}>
    <span className="eyebrow">Field notes / Journal</span>
    <h2 id="story-title">{story.title}</h2>
    <p>{story.intro}</p>
    <p>{stories[story.index]}</p>
    <p>Explore the collection or speak with a Havenstone advisor about finding a home that fits your way of living.</p>
    <div className="story-actions"><Link to="/properties">Explore properties →</Link><button type="button" onClick={() => ref.current.close()}>Close story</button></div>
  </dialog>;
}
