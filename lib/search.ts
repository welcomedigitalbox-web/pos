// Finding a product by typing part of its name.
//
// Every list used to do the same thing: lowercase both sides and ask for a
// substring. That fails on the way people actually type. A name holding two
// spaces, or a hyphen, or a size written "3 x 900g", does not contain
// "3x900g". Words typed in the other order do not match at all. Burmese
// pasted from an old system carries characters that look identical and are
// not. So a shop would swear a product was missing when it was sitting there.
//
// Here the query and the text are both flattened the same way and matched
// word by word, in any order. "gold similac" finds "Similac Gold Step-2".

// Zero-width and invisible marks that come in with pasted Burmese text.
const INVISIBLE = /[​-‍﻿­]/g;

export function normalizeForSearch(s: unknown): string {
  return String(s ?? "")
    // Compose Burmese and accented Latin to one canonical shape, so two
    // spellings that look the same really are the same.
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .toLowerCase()
    // Punctuation, brackets and separators are decoration, not identity.
    .replace(/[.,/\\()\[\]{}\-_+*#'"`~!?:;|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// True when every word of the query appears somewhere in the fields.
// An empty query matches everything, which is what a blank search box means.
export function matchesSearch(query: string, ...fields: unknown[]): boolean {
  const q = normalizeForSearch(query);
  if (!q) return true;
  const hay = normalizeForSearch(fields.filter((f) => f != null).join(" "));
  // A number typed with or without its unit should still land: "900g" and
  // "900 g" flatten to the same words either side.
  return q.split(" ").every((w) => hay.includes(w) || hay.replace(/ /g, "").includes(w));
}
