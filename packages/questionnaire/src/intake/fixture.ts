import { deflateRawSync } from 'node:zlib';

/**
 * Build a ZIP archive in memory.
 *
 * Test-only, and in `src` rather than a test file on purpose: the adversarial
 * suites need to construct archives a real tool would never produce — a lying
 * uncompressed size, a compression bomb, a path-traversal entry name — and a
 * library that could build those is a library that could not check them.
 *
 * Nothing in the product imports this. `tests/unit/architecture.test.ts` would
 * be the place to assert that if it ever became worth asserting; today the
 * cheaper guard is that it exports nothing the product has a use for.
 */
export interface ZipEntryInput {
  readonly name: string;
  readonly content: Buffer | string;
  /** Store rather than deflate. */
  readonly stored?: boolean;
  /** Claim a different uncompressed size than the truth, to test the cap. */
  readonly lieAboutSize?: number;
  /** Claim an unsupported compression method. */
  readonly method?: number;
  /** Set the encryption flag. */
  readonly encrypted?: boolean;
}

export function buildZip(entries: readonly ZipEntryInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content);
    const stored = entry.stored === true;
    const payload = stored ? content : deflateRawSync(content);
    const method = entry.method ?? (stored ? 0 : 8);
    const declaredSize = entry.lieAboutSize ?? content.length;
    const name = Buffer.from(entry.name, 'utf8');
    const flags = entry.encrypted === true ? 0x1 : 0;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14); // CRC, unchecked by the reader.
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, payload);
    centrals.push(central);
    offset += local.length + payload.length;
  }

  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBytes, eocd]);
}

export interface SheetFixture {
  readonly name: string;
  /** Rows of cell text. Empty strings become absent cells. */
  readonly rows: readonly (readonly string[])[];
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function columnLetter(column: number): string {
  let name = '';
  let remaining = column;
  while (remaining > 0) {
    name = String.fromCharCode(65 + ((remaining - 1) % 26)) + name;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return name;
}

/**
 * A workbook that a real spreadsheet tool would produce: shared strings,
 * relationships, one part per sheet.
 */
export function buildWorkbook(sheets: readonly SheetFixture[]): Buffer {
  const shared: string[] = [];
  const indexOf = (value: string): number => {
    const existing = shared.indexOf(value);
    if (existing !== -1) return existing;
    shared.push(value);
    return shared.length - 1;
  };

  const sheetParts = sheets.map((sheet, sheetIndex) => {
    const rows = sheet.rows
      .map((cells, rowIndex) => {
        const row = rowIndex + 1;
        const body = cells
          .map((value, columnIndex) => {
            if (value === '') return '';
            const reference = `${columnLetter(columnIndex + 1)}${row}`;
            return `<c r="${reference}" t="s"><v>${indexOf(value)}</v></c>`;
          })
          .join('');
        return `<row r="${row}">${body}</row>`;
      })
      .join('');
    return {
      path: `xl/worksheets/sheet${sheetIndex + 1}.xml`,
      xml:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        `<sheetData>${rows}</sheetData></worksheet>`,
    };
  });

  const workbookXml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    sheets
      .map(
        (sheet, index) =>
          `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
      )
      .join('') +
    '</sheets></workbook>';

  const relsXml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets
      .map(
        (_sheet, index) =>
          `<Relationship Id="rId${index + 1}" Target="worksheets/sheet${index + 1}.xml" ` +
          'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/>',
      )
      .join('') +
    '</Relationships>';

  const sharedXml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" ` +
    `uniqueCount="${shared.length}">` +
    shared.map((value) => `<si><t>${escapeXml(value)}</t></si>`).join('') +
    '</sst>';

  return buildZip([
    { name: '[Content_Types].xml', content: '<?xml version="1.0"?><Types/>' },
    { name: 'xl/workbook.xml', content: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', content: relsXml },
    { name: 'xl/sharedStrings.xml', content: sharedXml },
    ...sheetParts.map((part) => ({ name: part.path, content: part.xml })),
  ]);
}
