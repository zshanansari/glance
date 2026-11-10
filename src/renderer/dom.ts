/** Small DOM helpers the three windows share. */
import type { Theme } from "../shared/settings";

/** The element with this id, or a loud failure: the page is out of step with its script. */
export function requireElement<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

/** Follows Settings' Theme rather than only the system's appearance. */
export function applyTheme(theme: Theme): void {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}
