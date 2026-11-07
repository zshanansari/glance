/**
 * Apple's SF Symbols, rendered to icons/symbols by scripts/generate-symbols.swift
 * and drawn as a mask, so each takes its color from the text around it.
 */
export type SymbolName =
  | "gearshape.fill"
  | "circle.lefthalf.filled"
  | "calendar"
  | "calendar.badge.clock"
  | "info.circle.fill"
  | "speaker.wave.2.fill"
  | "checkmark"
  | "chevron.left"
  | "chevron.right"
  | "mappin.and.ellipse"
  | "eye.slash"
  | "video.fill"
  | "arrow.up.right"
  | "clock"
  | "magnifyingglass"
  | "map";

/** Without a size, the stylesheet sizes the glyph. */
export function sfSymbol(name: SymbolName, size?: number): HTMLElement {
  const glyph = document.createElement("span");
  glyph.className = "sf-symbol";
  glyph.setAttribute("aria-hidden", "true");
  glyph.style.setProperty("--symbol", `url("symbols/${name}.png")`);
  if (size !== undefined) {
    glyph.style.width = `${size}px`;
    glyph.style.height = `${size}px`;
  }
  return glyph;
}
