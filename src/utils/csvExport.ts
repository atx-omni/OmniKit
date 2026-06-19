export type CsvCellValue = string | number | boolean | null | undefined;

const FORMULA_PREFIX_PATTERN = /^[\t\r\n ]*[=+\-@]/;

export function neutralizeCsvFormula(value: CsvCellValue): string {
  const text = value == null ? '' : String(value);
  if (typeof value === 'string' && FORMULA_PREFIX_PATTERN.test(text)) {
    return `'${text}`;
  }
  return text;
}

export function csvEscapeCell(value: CsvCellValue): string {
  const text = neutralizeCsvFormula(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export function csvRowsToText(rows: CsvCellValue[][]): string {
  return rows.map((row) => row.map(csvEscapeCell).join(',')).join('\n');
}
