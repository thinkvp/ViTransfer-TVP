/**
 * Client-side spreadsheet parsing for the document viewer.
 *
 * Like the .docx path, this runs in the browser so the bytes reach the viewer straight from
 * storage instead of being relayed through the app, and so no new API surface (and no new
 * authorization) is introduced. SheetJS is imported dynamically — it is a ~900KB bundle and
 * has no business loading for anyone who never opens a spreadsheet.
 *
 * SheetJS is installed from cdn.sheetjs.com rather than npm: the npm-published `xlsx` is
 * frozen at 0.18.5 and carries two unfixed high-severity advisories (prototype pollution,
 * ReDoS) that would fail the `npm audit --audit-level=high` gate in the Dockerfile. The
 * maintained 0.20.3 build postdates both fixes. Because npm cannot resolve advisories for a
 * URL dependency, upgrades here are manual — bump the URL in package.json and re-run
 * `npm install`; `npm outdated` will not flag it.
 */

/** Spreadsheets expand a long way from their zipped size once parsed into cells. */
export const MAX_SHEET_PREVIEW_BYTES = 25 * 1024 * 1024

/**
 * Display ceilings. A production workbook can carry hundreds of thousands of rows, which
 * would lock the browser up if handed to the DOM verbatim — the viewer is for glancing at a
 * file, not for working in it, so anything past these limits is cut and flagged.
 */
export const MAX_SHEET_ROWS = 500
export const MAX_SHEET_COLUMNS = 60

export interface SheetPreviewSheet {
  name: string
  rows: string[][]
  /** True when rows or columns were cut to the limits above. */
  truncated: boolean
}

export interface SheetPreviewResult {
  sheets: SheetPreviewSheet[]
}

export async function parseSpreadsheet(bytes: ArrayBuffer): Promise<SheetPreviewResult> {
  const mod: any = await import('xlsx')
  const XLSX = mod?.default?.read ? mod.default : mod

  // cellFormula/cellHTML off: the viewer only ever shows values, and there is no reason to
  // build representations of a hostile file that we are not going to render.
  const workbook = XLSX.read(bytes, {
    type: 'array',
    cellFormula: false,
    cellHTML: false,
    cellDates: true,
  })

  const sheetNames: string[] = Array.isArray(workbook?.SheetNames) ? workbook.SheetNames : []

  const sheets: SheetPreviewSheet[] = sheetNames.map((name) => {
    const worksheet = workbook.Sheets[name]
    if (!worksheet) return { name, rows: [], truncated: false }

    // header: 1 yields an array-of-arrays; raw: false renders dates and numbers using the
    // cell's own display format, so the preview matches what Excel shows.
    const raw: unknown[][] = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      blankrows: false,
      defval: '',
      raw: false,
    })

    const rowsTruncated = raw.length > MAX_SHEET_ROWS
    let columnsTruncated = false

    const rows = raw.slice(0, MAX_SHEET_ROWS).map((row) => {
      const cells = Array.isArray(row) ? row : []
      if (cells.length > MAX_SHEET_COLUMNS) columnsTruncated = true
      return cells
        .slice(0, MAX_SHEET_COLUMNS)
        .map((cell) => (cell === null || cell === undefined ? '' : String(cell)))
    })

    return { name, rows, truncated: rowsTruncated || columnsTruncated }
  })

  return { sheets }
}
