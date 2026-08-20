/**
 * Best-effort PDF page counter from a raw buffer without external deps.
 * Returns null if it cannot determine the count (caller can fall back to
 * a user-entered value).
 */
export function countPdfPages(buffer) {
  try {
    const text = buffer.toString('latin1');
    // Prefer /Count in the page tree if present.
    const counts = [...text.matchAll(/\/Type\s*\/Pages[\s\S]{0,200}?\/Count\s+(\d+)/g)].map((m) =>
      parseInt(m[1], 10)
    );
    if (counts.length) return Math.max(...counts);
    // Fallback: count /Type /Page objects (not /Pages).
    const pageMatches = text.match(/\/Type\s*\/Page(?![s])/g);
    if (pageMatches && pageMatches.length) return pageMatches.length;
    return null;
  } catch {
    return null;
  }
}
