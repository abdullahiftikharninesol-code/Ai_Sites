"use client";

import { useEffect, useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster } from "sonner";
import { App } from "../../src/App";
import { BootFallback } from "./BootFallback";

export function ClientShell() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) return <BootFallback />;

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/build" element={<App />} />
        <Route path="/sites/:siteId" element={<App />} />
        <Route path="*" element={<App />} />
      </Routes>
      <Toaster theme="dark" position="bottom-right" richColors closeButton />
    </BrowserRouter>
  );
}
