// SPDX-License-Identifier: MPL-2.0
export interface SectionQuery {
  hasSeparator: boolean;
  pageQuery: string;
  sectionQuery: string;
}

/** Split before normalization: full-width ＃ remains part of the query. */
export function parseSectionQuery(query: string): SectionQuery {
  const separator = query.indexOf('#');
  return separator < 0
    ? { hasSeparator: false, pageQuery: '', sectionQuery: query.trim() }
    : {
        hasSeparator: true,
        pageQuery: query.slice(0, separator).trim(),
        sectionQuery: query.slice(separator + 1).trim(),
      };
}
