"use client";

import { useState, useEffect } from "react";

type Theme = "light" | "dark";

const STORAGE_KEY = "hospitality-theme";

/**
 * The theme is applied before paint by the inline script in layout.tsx, so
 * this component only reads back what is already on the document and provides
 * the switch. Setting it here alone would flash the light palette on every
 * dark-mode load, because a client component cannot run before hydration.
 */
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const current = document.documentElement.dataset.theme;
    setTheme(current === "dark" ? "dark" : "light");
  }, []);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;

    // Storage is unavailable in some private-browsing modes. Losing the
    // preference is acceptable; throwing on a theme switch is not.
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* preference simply will not persist */
    }
  };

  // Until the effect runs we do not know the theme, so render the control in a
  // neutral state rather than claiming the wrong one.
  const label = theme === null ? "Theme" : theme === "dark" ? "Light" : "Dark";

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-label={
        theme === null
          ? "Switch theme"
          : `Switch to ${theme === "dark" ? "light" : "dark"} mode`
      }
    >
      {label}
    </button>
  );
}