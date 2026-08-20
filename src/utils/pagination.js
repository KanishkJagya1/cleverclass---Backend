/**
 * Industrial-standard, index-friendly pagination for list endpoints.
 *
 * Every paginated endpoint returns a consistent envelope:
 *   { data, total, page, pageSize, pages }
 * so the client can render "showing X–Y of TOTAL" and a page control without
 * guessing. Queries use skip/take + a COUNT (never load-all-then-slice), so they
 * stay fast as tables grow into the thousands.
 */

/** Parse ?page & ?pageSize into safe skip/take. */
export function parsePagination(query = {}, { defaultPageSize = 10, maxPageSize = 100 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  let pageSize = parseInt(query.pageSize, 10) || defaultPageSize;
  pageSize = Math.min(maxPageSize, Math.max(1, pageSize));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

/** Wrap a page of rows + a total count into the standard envelope. */
export function paginate(data, total, page, pageSize, extra = {}) {
  return {
    data,
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    ...extra,
  };
}

/** A case-insensitive `contains` filter (Postgres) for a text column. */
export function containsInsensitive(value) {
  return { contains: value, mode: 'insensitive' };
}
