export function slugify(str) {
  return String(str)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 70);
}

/** Ensure a unique slug given an async existence checker. */
export async function uniqueSlug(base, exists) {
  let slug = slugify(base) || 'paper';
  let i = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await exists(slug)) {
    slug = `${slugify(base)}-${i++}`;
  }
  return slug;
}
