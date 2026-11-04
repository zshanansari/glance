/**
 * Liquid Glass switches. Each `<input type="checkbox" switch>` keeps its role,
 * keyboard handling and `change` events; this adds the knob, which swells
 * into a clear lens while pressed and can be dragged across, as NSSwitch's
 * does on macOS 26. A press that does not travel is a click.
 */
const TRAVEL = 10; // knob travel, px: a 36px track less a 22px knob and 2px insets
const DRAG_SLOP = 3;

export function enhanceSwitches(root: ParentNode): void {
  for (const input of Array.from(
    root.querySelectorAll<HTMLInputElement>('input[type="checkbox"][switch]'),
  )) {
    if (input.parentElement?.classList.contains("switch")) continue;
    const wrap = document.createElement("span");
    wrap.className = "switch";
    const knob = document.createElement("span");
    knob.className = "switch-knob";
    knob.setAttribute("aria-hidden", "true");
    input.replaceWith(wrap);
    wrap.append(input, knob);
    bind(wrap, input, knob);
  }
}

function bind(wrap: HTMLElement, input: HTMLInputElement, knob: HTMLElement): void {
  let startX = 0;
  let startOffset = 0;
  let dragging = false;
  let pointer: number | null = null;

  const offset = (): number => (input.checked ? TRAVEL : 0);

  wrap.addEventListener("pointerdown", (event) => {
    if (input.disabled || event.button !== 0) return;
    pointer = event.pointerId;
    wrap.setPointerCapture(pointer);
    startX = event.clientX;
    startOffset = offset();
    dragging = false;
    wrap.classList.add("is-pressed");
    input.focus({ preventScroll: true });
  });

  wrap.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointer) return;
    const moved = event.clientX - startX;
    if (!dragging && Math.abs(moved) < DRAG_SLOP) return;
    dragging = true;
    wrap.classList.add("is-dragging");
    const x = Math.min(TRAVEL, Math.max(0, startOffset + moved));
    knob.style.setProperty("--knob-x", `${x}px`);
    // The track follows the knob: past halfway it reads as on.
    wrap.classList.toggle("is-on", x > TRAVEL / 2);
  });

  const release = (event: PointerEvent, cancelled = false): void => {
    if (event.pointerId !== pointer) return;
    pointer = null;
    wrap.classList.remove("is-pressed", "is-dragging", "is-on");
    knob.style.removeProperty("--knob-x");
    if (cancelled) return;
    const next = dragging
      ? startOffset + (event.clientX - startX) > TRAVEL / 2
      : !input.checked;
    if (next !== input.checked) {
      input.checked = next;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };
  wrap.addEventListener("pointerup", (event) => release(event));
  wrap.addEventListener("pointercancel", (event) => release(event, true));
}
