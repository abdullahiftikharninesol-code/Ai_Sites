import React from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

function App() {
  return <main><h1>Publisher fixture</h1></main>;
}

createRoot(document.getElementById("root")).render(<App />);
