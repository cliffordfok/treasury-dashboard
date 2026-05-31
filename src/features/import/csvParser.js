export const parseCsvText = (text = '') => {
  const rows = [];
  let currentRow = [];
  let currentCell = '';
  let inQuotes = false;

  const source = String(text || '').replace(/^\uFEFF/, '');

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const nextChar = source[index + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        currentCell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      currentRow.push(currentCell);
      currentCell = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') index += 1;
      currentRow.push(currentCell);
      rows.push(currentRow);
      currentRow = [];
      currentCell = '';
      continue;
    }

    currentCell += char;
  }

  currentRow.push(currentCell);
  rows.push(currentRow);

  const nonEmptyRows = rows.filter((row) => row.some((cell) => String(cell || '').trim() !== ''));
  if (nonEmptyRows.length === 0) return { headers: [], rows: [] };

  const headers = nonEmptyRows[0].map((header) => String(header || '').trim());
  const dataRows = nonEmptyRows.slice(1).map((row) =>
    headers.reduce((result, header, index) => {
      result[header] = row[index] === undefined ? '' : String(row[index]).trim();
      return result;
    }, {}),
  );

  return { headers, rows: dataRows };
};
