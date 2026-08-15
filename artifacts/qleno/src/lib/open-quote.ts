// Francisco, 2026-08-09: "When clicking Create New Quote, it would be very
// helpful if the quote opened in a new browser tab instead of replacing the
// current page."
//
// The office builds a quote while looking at something else — the lead board,
// a customer profile, the quote list they were working down. Navigating in
// place threw that away and made them find their spot again afterward.
//
// Two things this deliberately does NOT do:
//
//   * It stays in place on a phone. A background tab on mobile is a trap —
//     there's no visible tab strip, so the quote looks like it simply replaced
//     the page anyway and the original is stranded behind a tab switcher.
//   * It falls back to normal navigation when the popup blocker eats the
//     window. window.open returns null when blocked, and a New Quote button
//     that silently does nothing is worse than one that navigates.
//
// Wouter is mounted on a base path (App.tsx), so router paths like
// "/quotes/new" are relative to it and have to be prefixed for a real URL.

export function quoteBuilderUrl(routePath: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${base}${routePath.startsWith("/") ? "" : "/"}${routePath}`;
}

/**
 * Open the quote builder. Returns true when it went to a new tab, false when
 * it navigated in place.
 *
 * Must be called directly from a click handler: browsers only allow
 * window.open without a block when it's attributable to a user gesture.
 */
export function openQuoteBuilder(
  routePath: string,
  navigate: (to: string) => void,
): boolean {
  const isTouchPhone =
    typeof window !== "undefined" &&
    (window.innerWidth < 768 || window.matchMedia?.("(pointer: coarse)")?.matches);

  if (isTouchPhone) {
    navigate(routePath);
    return false;
  }

  // [open-quote-double-nav 2026-08-15] Francisco: "clicking Quote opens a new
  // tab AND navigates the original window." The features string used to be
  // "noopener,noreferrer" — and per the HTML spec window.open returns NULL
  // whenever noopener/noreferrer is set, success or not. So the popup-blocked
  // fallback below fired on every click: the tab opened and the page you were
  // on navigated away too, which is the exact thing this helper exists to
  // prevent. Open plainly so null actually means blocked, then sever
  // window.opener by hand for the same protection (same-origin, so assignable).
  const win = window.open(quoteBuilderUrl(routePath), "_blank");
  if (!win) {
    navigate(routePath);
    return false;
  }
  try { win.opener = null; } catch { /* not fatal — the tab is already open */ }
  return true;
}
