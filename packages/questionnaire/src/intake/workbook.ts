import { contentHash } from '@adericel/shared';
import { DEFAULT_ZIP_LIMITS, openZip, ZipRefusal, type ZipLimits } from './zip.js';
import { allTextWithin, assertSafeXml, walkXml, XmlRefusal } from './xml.js';

/**
 * Reading a questionnaire workbook.
 *
 * What comes out is a grid of strings and nothing else. No formulas, no styles,
 * no formatting, no embedded objects — a questionnaire is text in cells, and
 * everything else in the file is either decoration or a way in.
 *
 * FORMULAS ARE READ AS THEIR CACHED VALUE, NEVER EVALUATED
 *
 * A cell can hold `=A1&"..."` with a cached result. Adericel takes the cached
 * result and discards the formula. It is not an evaluator and must not become
 * one: evaluating an expression from an untrusted file is arbitrary computation,
 * and the cached value is what the sender saw when they saved it — which is the
 * thing they meant to ask.
 *
 * Where a formula has no cached value, the cell is empty rather than guessed.
 */

export interface WorkbookCell {
  /** 1-based row, as an assessor would cite it. */
  readonly row: number;
  /** 1-based column. */
  readonly column: number;
  /** The A1 reference, kept so a finding can point at a real cell. */
  readonly reference: string;
  readonly value: string;
}

export interface WorkbookSheet {
  readonly name: string;
  /** Sheet order in the workbook, 1-based. */
  readonly position: number;
  readonly cells: readonly WorkbookCell[];
  readonly rowCount: number;
  readonly columnCount: number;
  /** Rows the reader stopped short of, if the sheet exceeded the limit. */
  readonly truncatedAfterRow: number | null;
}

export interface Workbook {
  readonly sheets: readonly WorkbookSheet[];
  /** `sha256:` over the file as it arrived. The evidence identity of the intake. */
  readonly sourceHash: string;
  readonly sourceBytes: number;
  /** Things the reader declined to carry, stated rather than dropped silently. */
  readonly discarded: readonly string[];
}

export interface WorkbookLimits extends ZipLimits {
  readonly maxSheets: number;
  readonly maxRowsPerSheet: number;
  readonly maxColumnsPerSheet: number;
  readonly maxCellCharacters: number;
}

export const DEFAULT_WORKBOOK_LIMITS: WorkbookLimits = {
  ...DEFAULT_ZIP_LIMITS,
  maxSheets: 32,
  maxRowsPerSheet: 20_000,
  maxColumnsPerSheet: 256,
  // A question longer than this is not a question. The longest genuine
  // questionnaire item seen in the wild runs to a few hundred characters; this
  // leaves room for a preamble baked into the cell.
  maxCellCharacters: 8_000,
};

export class WorkbookRefusal extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'WorkbookRefusal';
  }
}

/** `3` -> `C`. Used to build an A1 reference the sender would recognise. */
export function columnName(column: number): string {
  let name = '';
  let remaining = column;
  while (remaining > 0) {
    const digit = (remaining - 1) % 26;
    name = String.fromCharCode(65 + digit) + name;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return name;
}

/** `C7` -> `{ row: 7, column: 3 }`. Returns null for anything else. */
export function parseReference(reference: string): { row: number; column: number } | null {
  const match = /^([A-Z]+)(\d+)$/.exec(reference);
  if (!match) return null;
  const letters = match[1]!;
  const row = Number.parseInt(match[2]!, 10);
  let column = 0;
  for (const letter of letters) column = column * 26 + (letter.charCodeAt(0) - 64);
  return { row, column };
}

function readSharedStrings(xml: string, limits: WorkbookLimits): readonly string[] {
  /**
   * The safety check, explicitly, because this function does not use `walkXml`.
   *
   * It reads `<si>` elements with a regex — the shared-string table is a flat
   * list and a pull parse of it would be slower for no benefit. That is fine,
   * and it left a hole: `assertSafeXml` runs inside `walkXml`, so the one part
   * of a workbook that skipped the walker was also the one that skipped the
   * guard. Shared strings are where every question's text lives, which makes
   * this the most attractive part of the file to hide a doctype in.
   *
   * Found by a test asserting the doctype refusal and watching it not fire.
   */
  assertSafeXml(xml);

  const strings: string[] = [];
  // `<si>` may contain a single `<t>` or several `<r><t>` runs. Both are read
  // whole: taking the first run truncates a question at its first bold word.
  const pattern = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si(?:\s[^>]*)?\/>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const text = match[1] === undefined ? '' : allTextWithin(match[1]);
    strings.push(text.slice(0, limits.maxCellCharacters));
  }
  return strings;
}

interface SheetRef {
  readonly name: string;
  readonly relationshipId: string;
}

function readWorkbookSheets(xml: string): readonly SheetRef[] {
  const sheets: SheetRef[] = [];
  walkXml(xml, (element) => {
    if (element.name !== 'sheet') return;
    const name = element.attributes.name ?? '';
    const relationshipId = element.attributes['r:id'] ?? element.attributes.id ?? '';
    if (name && relationshipId) sheets.push({ name, relationshipId });
  });
  return sheets;
}

function readRelationships(xml: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  walkXml(xml, (element) => {
    if (element.name !== 'Relationship') return;
    const id = element.attributes.Id;
    const target = element.attributes.Target;
    if (id && target) map.set(id, target);
  });
  return map;
}

function readSheet(
  xml: string,
  name: string,
  position: number,
  sharedStrings: readonly string[],
  limits: WorkbookLimits,
  discarded: string[],
): WorkbookSheet {
  const cells: WorkbookCell[] = [];
  let rowCount = 0;
  let columnCount = 0;
  let truncatedAfterRow: number | null = null;
  let currentRow = 0;
  let inlineDiscarded = false;

  walkXml(xml, (element, textUntilClose) => {
    if (element.name === 'row') {
      const declared = Number.parseInt(element.attributes.r ?? '0', 10);
      currentRow = Number.isFinite(declared) && declared > 0 ? declared : currentRow + 1;
      if (currentRow > limits.maxRowsPerSheet) {
        if (truncatedAfterRow === null) truncatedAfterRow = limits.maxRowsPerSheet;
        return;
      }
      rowCount = Math.max(rowCount, currentRow);
      return;
    }

    if (element.name !== 'c') return;
    if (truncatedAfterRow !== null) return;

    const reference = element.attributes.r ?? '';
    const position = parseReference(reference);
    const row = position?.row ?? currentRow;
    const column = position?.column ?? 0;

    if (row > limits.maxRowsPerSheet || column > limits.maxColumnsPerSheet || column === 0) {
      if (column > limits.maxColumnsPerSheet) {
        discarded.push(
          `${name}: columns beyond ${columnName(limits.maxColumnsPerSheet)} were not read.`,
        );
      }
      return;
    }

    const type = element.attributes.t ?? 'n';
    const fragment = element.selfClosing ? '' : textUntilClose();

    let value = '';
    if (type === 's') {
      // A shared-string cell holds an index into the shared table.
      const index = Number.parseInt(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(fragment)?.[1] ?? '', 10);
      value = Number.isFinite(index) ? (sharedStrings[index] ?? '') : '';
    } else if (type === 'inlineStr') {
      value = allTextWithin(fragment);
    } else if (type === 'str') {
      // A formula's cached string result. The formula in `<f>` is ignored.
      value = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(fragment)?.[1] ?? '';
      if (fragment.includes('<f')) inlineDiscarded = true;
    } else {
      const raw = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(fragment)?.[1] ?? '';
      value = raw;
      if (fragment.includes('<f')) inlineDiscarded = true;
    }

    const trimmed = value.trim().slice(0, limits.maxCellCharacters);
    if (trimmed === '') return;

    columnCount = Math.max(columnCount, column);
    cells.push({
      row,
      column,
      reference: reference || `${columnName(column)}${row}`,
      value: trimmed,
    });
  });

  if (inlineDiscarded) {
    discarded.push(
      `${name}: formulas were read as their last saved result and the expressions discarded. ` +
        'Adericel does not evaluate a formula from a file it did not write.',
    );
  }
  if (truncatedAfterRow !== null) {
    discarded.push(`${name}: stopped at row ${limits.maxRowsPerSheet}; later rows were not read.`);
  }

  return { name, position, cells, rowCount, columnCount, truncatedAfterRow };
}

/**
 * Read a workbook, or refuse it with a reason a person can act on.
 *
 * Every refusal names what is wrong in the sender's terms rather than the
 * format's, because the person who has to fix it is usually a compliance
 * manager forwarding a file, not somebody who knows what a central directory is.
 */
export function readWorkbook(
  archive: Buffer,
  limits: WorkbookLimits = DEFAULT_WORKBOOK_LIMITS,
): Workbook {
  const discarded: string[] = [];
  let zip;
  try {
    zip = openZip(archive, limits);
  } catch (error) {
    if (error instanceof ZipRefusal) {
      throw new WorkbookRefusal(error.message, error.reason);
    }
    throw error;
  }

  try {
    if (!zip.has('xl/workbook.xml')) {
      throw new WorkbookRefusal(
        'This ZIP archive is not a spreadsheet: it has no workbook part. A .docx or .zip ' +
          'renamed to .xlsx will look like this.',
        'NOT_A_WORKBOOK',
      );
    }

    /**
     * External links are discarded, and their presence is reported.
     *
     * A workbook can reference cells in another file, so a question's text can
     * be "whatever that other spreadsheet says". Adericel reads neither the
     * other file nor the cached value of such a reference — it reports that the
     * workbook expects something it will not fetch, because a question whose
     * text depends on a file we refused to open is a question nobody should
     * answer.
     */
    const external = zip.names.filter((name) => name.startsWith('xl/externalLinks/'));
    if (external.length > 0) {
      discarded.push(
        `This workbook links to ${external.length} external file(s). Adericel did not open ` +
          'them and did not follow the references. Any question whose text came from one will ' +
          'read as empty.',
      );
    }

    const sharedStrings = zip.has('xl/sharedStrings.xml')
      ? readSharedStrings(zip.read('xl/sharedStrings.xml').toString('utf8'), limits)
      : [];

    const sheetRefs = readWorkbookSheets(zip.read('xl/workbook.xml').toString('utf8'));
    if (sheetRefs.length === 0) {
      throw new WorkbookRefusal('This workbook declares no sheets.', 'NO_SHEETS');
    }
    if (sheetRefs.length > limits.maxSheets) {
      throw new WorkbookRefusal(
        `This workbook has ${sheetRefs.length} sheets, over the ${limits.maxSheets} limit.`,
        'TOO_MANY_SHEETS',
      );
    }

    const relationships = zip.has('xl/_rels/workbook.xml.rels')
      ? readRelationships(zip.read('xl/_rels/workbook.xml.rels').toString('utf8'))
      : new Map<string, string>();

    const sheets: WorkbookSheet[] = [];
    sheetRefs.forEach((ref, index) => {
      const target = relationships.get(ref.relationshipId);
      // Fall back to the conventional path. Some generators omit the
      // relationship, and refusing the whole workbook over a missing
      // cross-reference would reject files Excel opens without complaint.
      const path = target
        ? `xl/${target.replace(/^\/?xl\//, '').replace(/^\//, '')}`
        : `xl/worksheets/sheet${index + 1}.xml`;

      if (!zip.has(path)) {
        discarded.push(`Sheet "${ref.name}" names a part that is not in the file.`);
        return;
      }
      sheets.push(
        readSheet(
          zip.read(path).toString('utf8'),
          ref.name,
          index + 1,
          sharedStrings,
          limits,
          discarded,
        ),
      );
    });

    if (sheets.length === 0) {
      throw new WorkbookRefusal(
        'None of this workbook’s sheets could be read.',
        'NO_READABLE_SHEETS',
      );
    }

    return {
      sheets,
      sourceHash: contentHash(archive.toString('base64')),
      sourceBytes: archive.length,
      discarded,
    };
  } catch (error) {
    if (error instanceof WorkbookRefusal) throw error;
    if (error instanceof ZipRefusal || error instanceof XmlRefusal) {
      throw new WorkbookRefusal(error.message, error.reason);
    }
    throw error;
  }
}
