import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { buildWorkbook, buildZip } from './fixture.js';
import { DEFAULT_WORKBOOK_LIMITS, columnName, parseReference, readWorkbook } from './workbook.js';

/**
 * Reading a questionnaire, and refusing the things that are not one.
 *
 * A questionnaire arrives as a file somebody we have never met emailed to our
 * customer. It is the least trusted input the product accepts — less trusted
 * than a webhook, which at least carries a signature. So most of this suite is
 * about what the reader declines to do.
 */

const QUESTION = 'Do you enforce multi-factor authentication on all remote access?';

describe('reading an ordinary workbook', () => {
  it('reads questions out of the sheet a sender would have built', () => {
    const workbook = readWorkbook(
      buildWorkbook([
        {
          name: 'Security Questionnaire',
          rows: [
            ['Ref', 'Question', 'Response'],
            ['1.1', QUESTION, ''],
            ['1.2', 'Do you hold Cyber Essentials certification?', ''],
          ],
        },
      ]),
    );

    expect(workbook.sheets).toHaveLength(1);
    const sheet = workbook.sheets[0]!;
    expect(sheet.name).toBe('Security Questionnaire');
    expect(sheet.cells.find((cell) => cell.reference === 'B2')?.value).toBe(QUESTION);
    expect(sheet.rowCount).toBe(3);
  });

  it('keeps the A1 reference, so a finding can point at a real cell', () => {
    // "Question 1.2 is unanswerable" is a support ticket. "Sheet 1, cell B3 is
    // unanswerable" is something a person can open the file and look at.
    const workbook = readWorkbook(
      buildWorkbook([
        {
          name: 'S',
          rows: [
            ['a', 'b'],
            ['c', 'd'],
          ],
        },
      ]),
    );
    expect(workbook.sheets[0]!.cells.map((cell) => cell.reference)).toEqual([
      'A1',
      'B1',
      'A2',
      'B2',
    ]);
  });

  it('hashes the file as it arrived', () => {
    // The intake's evidence identity. Two uploads of the same file are the same
    // intake; a re-export from Excel is a different one, and should be.
    const archive = buildWorkbook([{ name: 'S', rows: [[QUESTION]] }]);
    expect(readWorkbook(archive).sourceHash).toBe(readWorkbook(archive).sourceHash);
    expect(readWorkbook(archive).sourceHash).toMatch(/^sha256:/);
    expect(readWorkbook(archive).sourceBytes).toBe(archive.length);
  });

  it('reads a question split across formatting runs, whole', () => {
    /**
     * A question with a bold word arrives as several `<t>` runs rather than
     * one. Reading only the first truncates the question at its first emphasis
     * — and a truncated question that still looks like a question is how a
     * confidently wrong answer gets produced.
     */
    const sharedXml =
      '<?xml version="1.0"?><sst>' +
      '<si><r><t>Do you enforce </t></r><r><t>multi-factor</t></r><r><t> authentication?</t></r></si>' +
      '</sst>';
    const sheetXml =
      '<?xml version="1.0"?><worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c></row>' +
      '</sheetData></worksheet>';

    const workbook = readWorkbook(
      buildZip([
        {
          name: 'xl/workbook.xml',
          content:
            '<workbook xmlns:r="x"><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>',
        },
        {
          name: 'xl/_rels/workbook.xml.rels',
          content:
            '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
        },
        { name: 'xl/sharedStrings.xml', content: sharedXml },
        { name: 'xl/worksheets/sheet1.xml', content: sheetXml },
      ]),
    );
    expect(workbook.sheets[0]!.cells[0]!.value).toBe('Do you enforce multi-factor authentication?');
  });

  it('takes a formula’s last saved value and discards the expression, saying so', () => {
    /**
     * Adericel is not a spreadsheet evaluator and must not become one:
     * evaluating an expression out of an untrusted file is arbitrary
     * computation. The cached value is what the sender saw when they saved,
     * which is the thing they meant to ask.
     */
    const sheetXml =
      '<?xml version="1.0"?><worksheet><sheetData><row r="1">' +
      '<c r="A1" t="str"><f>CONCATENATE(B1,C1)</f><v>Do you encrypt laptops?</v></c>' +
      '</row></sheetData></worksheet>';

    const workbook = readWorkbook(
      buildZip([
        {
          name: 'xl/workbook.xml',
          content:
            '<workbook xmlns:r="x"><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>',
        },
        {
          name: 'xl/_rels/workbook.xml.rels',
          content:
            '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
        },
        { name: 'xl/worksheets/sheet1.xml', content: sheetXml },
      ]),
    );
    expect(workbook.sheets[0]!.cells[0]!.value).toBe('Do you encrypt laptops?');
    expect(workbook.discarded.join(' ')).toMatch(/does not evaluate a formula/i);
  });

  it('converts column numbers to the letters a sender uses, past Z', () => {
    expect(columnName(1)).toBe('A');
    expect(columnName(26)).toBe('Z');
    expect(columnName(27)).toBe('AA');
    expect(columnName(52)).toBe('AZ');
    expect(columnName(703)).toBe('AAA');
    // And back, because a mismatch between the two is a cell reference that
    // points somewhere else.
    for (const column of [1, 26, 27, 52, 703, 256]) {
      expect(parseReference(`${columnName(column)}7`)).toEqual({ row: 7, column });
    }
  });
});

describe('what it refuses', () => {
  it('refuses a file that is not a ZIP at all', () => {
    // A .docx renamed, a PDF renamed, or an email body saved with the wrong
    // extension. All three happen, and the message has to say which.
    expect(() => readWorkbook(Buffer.from('%PDF-1.7 not a spreadsheet'))).toThrow(
      /not a readable spreadsheet|too small/i,
    );
  });

  it('refuses a ZIP that is not a workbook', () => {
    const notAWorkbook = buildZip([{ name: 'word/document.xml', content: '<document/>' }]);
    expect(() => readWorkbook(notAWorkbook)).toThrow(/no workbook part/i);
  });

  it('refuses a password-protected workbook, and says what to do', () => {
    const encrypted = buildZip([
      { name: 'xl/workbook.xml', content: '<workbook/>', encrypted: true },
    ]);
    expect(() => readWorkbook(encrypted)).toThrow(/password-protected/i);
  });

  it('refuses a compression bomb on its ratio', () => {
    /**
     * The classic shape: a few kilobytes that becomes gigabytes. Refused on
     * the declared ratio before a byte is inflated, so the refusal costs
     * nothing.
     */
    const bomb = buildZip([
      { name: 'xl/workbook.xml', content: '<workbook/>' },
      { name: 'xl/sharedStrings.xml', content: 'A'.repeat(5 * 1024 * 1024) },
    ]);
    expect(() =>
      readWorkbook(bomb, { ...DEFAULT_WORKBOOK_LIMITS, maxCompressionRatio: 10 }),
    ).toThrow(/compression bomb|expands/i);
  });

  it('caps inflation even when the header lies about the size', () => {
    /**
     * The declared uncompressed size is a claim by whoever built the archive.
     * Checking it and then inflating without a cap would make the check
     * theatre — a lying header would expand unbounded in memory.
     *
     * This entry claims to be tiny and is not.
     */
    const lying = buildZip([
      { name: 'xl/workbook.xml', content: '<workbook xmlns:r="x"><sheets/></workbook>' },
      { name: 'xl/sharedStrings.xml', content: 'A'.repeat(2 * 1024 * 1024), lieAboutSize: 64 },
    ]);
    /**
     * Asserted on the reason, not merely that it threw.
     *
     * A budget check after inflation also throws — and by then the memory has
     * been allocated, which is the whole thing the cap exists to prevent. The
     * reason distinguishes "refused while reading" from "refused once it was
     * too late", and only the first is a control.
     */
    let refusal: { reason?: string } | null = null;
    try {
      readWorkbook(lying, {
        ...DEFAULT_WORKBOOK_LIMITS,
        maxEntryUncompressedBytes: 4096,
        maxTotalUncompressedBytes: 8192,
      });
    } catch (error) {
      refusal = error as { reason?: string };
    }
    expect(refusal).not.toBeNull();
    expect(refusal!.reason).toBe('INFLATION_CAPPED');
  });

  it('refuses an entry name that is trying to escape', () => {
    // Nothing here writes to disk, so `../` is currently harmless. Refused
    // anyway: the next person to add caching will not re-derive this, and a
    // name like this in a questionnaire is not a mistake.
    const traversal = buildZip([
      { name: 'xl/workbook.xml', content: '<workbook/>' },
      { name: '../../etc/passwd', content: 'x' },
    ]);
    expect(() => readWorkbook(traversal)).toThrow(/not a shape a spreadsheet uses/i);
  });

  it('refuses an unsupported compression method rather than guessing', () => {
    const exotic = buildZip([
      {
        name: 'xl/workbook.xml',
        content: '<workbook xmlns:r="x"><sheets><sheet name="S" r:id="r1"/></sheets></workbook>',
      },
      { name: 'xl/_rels/workbook.xml.rels', content: '<Relationships/>' },
      { name: 'xl/worksheets/sheet1.xml', content: '<worksheet/>', method: 14 },
    ]);
    expect(() => readWorkbook(exotic)).toThrow(/compression method/i);
  });

  it('refuses an oversized archive before opening it', () => {
    const large = buildZip([{ name: 'xl/workbook.xml', content: 'x'.repeat(1024) }]);
    expect(() => readWorkbook(large, { ...DEFAULT_WORKBOOK_LIMITS, maxArchiveBytes: 64 })).toThrow(
      /over the/i,
    );
  });

  it('refuses a workbook with more sheets than a questionnaire has', () => {
    const many = buildWorkbook(
      Array.from({ length: 40 }, (_unused, index) => ({ name: `S${index}`, rows: [['q']] })),
    );
    expect(() => readWorkbook(many, { ...DEFAULT_WORKBOOK_LIMITS, maxSheets: 8 })).toThrow(
      /over the 8 limit/i,
    );
  });
});

describe('XML that is trying something', () => {
  it('refuses a document type declaration outright', () => {
    /**
     * `<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>` is how XML
     * becomes a file-read primitive. No spreadsheet written by Excel, Google
     * Sheets or LibreOffice declares a doctype, so the reader has no code for
     * one rather than code that tries to parse it safely.
     */
    const xxe =
      '<?xml version="1.0"?>' +
      '<!DOCTYPE sst [<!ENTITY secret SYSTEM "file:///etc/passwd">]>' +
      '<sst><si><t>&secret;</t></si></sst>';

    const archive = buildZip([
      {
        name: 'xl/workbook.xml',
        content: '<workbook xmlns:r="x"><sheets><sheet name="S" r:id="r1"/></sheets></workbook>',
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        content:
          '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
      },
      { name: 'xl/sharedStrings.xml', content: xxe },
      { name: 'xl/worksheets/sheet1.xml', content: '<worksheet><sheetData/></worksheet>' },
    ]);
    expect(() => readWorkbook(archive)).toThrow(/document type/i);
  });

  it('refuses the billion laughs without expanding any of it', () => {
    const laughs =
      '<?xml version="1.0"?>' +
      '<!DOCTYPE sst [' +
      '<!ENTITY a "aaaaaaaaaa">' +
      '<!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">' +
      '<!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">' +
      ']><sst><si><t>&c;</t></si></sst>';

    const archive = buildZip([
      {
        name: 'xl/workbook.xml',
        content: '<workbook xmlns:r="x"><sheets><sheet name="S" r:id="r1"/></sheets></workbook>',
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        content:
          '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
      },
      { name: 'xl/sharedStrings.xml', content: laughs },
      { name: 'xl/worksheets/sheet1.xml', content: '<worksheet><sheetData/></worksheet>' },
    ]);
    expect(() => readWorkbook(archive)).toThrow(/document type|entities/i);
  });

  it('refuses an undefined entity rather than passing the fragment through', () => {
    /**
     * Passing `&foo;` into a question's text would put a fragment of somebody's
     * attempt into a document Adericel later renders back to them. Refused at
     * the point of decoding.
     */
    const sheetXml =
      '<?xml version="1.0"?><worksheet><sheetData><row r="1">' +
      '<c r="A1" t="inlineStr"><is><t>Do you &custom; encrypt?</t></is></c>' +
      '</row></sheetData></worksheet>';
    const archive = buildZip([
      {
        name: 'xl/workbook.xml',
        content: '<workbook xmlns:r="x"><sheets><sheet name="S" r:id="r1"/></sheets></workbook>',
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        content:
          '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
      },
      { name: 'xl/worksheets/sheet1.xml', content: sheetXml },
    ]);
    expect(() => readWorkbook(archive)).toThrow(/not one of the five predefined entities/i);
  });

  it('expands the five predefined entities, because real files use them', () => {
    // A control that refused everything would pass every test above and be
    // useless. Ampersands and angle brackets appear in genuine questions.
    const workbook = readWorkbook(
      buildWorkbook([{ name: 'S', rows: [['Do you use TLS 1.2 & above (>= 1.2)?']] }]),
    );
    expect(workbook.sheets[0]!.cells[0]!.value).toBe('Do you use TLS 1.2 & above (>= 1.2)?');
  });

  it('reports an external link rather than following it', () => {
    /**
     * A workbook can reference cells in another file, so a question's text can
     * be "whatever that other spreadsheet says". Adericel opens neither, and
     * says so — a question whose text came from a file we refused to read is a
     * question nobody should answer.
     */
    const workbook = readWorkbook(
      buildZip([
        {
          name: 'xl/workbook.xml',
          content: '<workbook xmlns:r="x"><sheets><sheet name="S" r:id="r1"/></sheets></workbook>',
        },
        {
          name: 'xl/_rels/workbook.xml.rels',
          content:
            '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
        },
        { name: 'xl/externalLinks/externalLink1.xml', content: '<externalLink/>' },
        {
          name: 'xl/worksheets/sheet1.xml',
          content:
            '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>q</t></is></c></row></sheetData></worksheet>',
        },
      ]),
    );
    expect(workbook.discarded.join(' ')).toMatch(/links to 1 external file/i);
    expect(workbook.discarded.join(' ')).toMatch(/did not follow the references/i);
  });
});

describe('limits that stop a sheet rather than the file', () => {
  it('truncates a very long sheet and says where it stopped', () => {
    // A 50,000-row sheet is a data extract that somebody attached to a
    // questionnaire. Refusing the whole file would lose the questions; reading
    // it all would spend the budget. It stops, and says so.
    const rows = Array.from({ length: 200 }, (_unused, index) => [`Question ${index}`]);
    const workbook = readWorkbook(buildWorkbook([{ name: 'S', rows }]), {
      ...DEFAULT_WORKBOOK_LIMITS,
      maxRowsPerSheet: 50,
    });
    expect(workbook.sheets[0]!.truncatedAfterRow).toBe(50);
    expect(workbook.discarded.join(' ')).toMatch(/stopped at row 50/i);
    expect(workbook.sheets[0]!.cells.every((cell) => cell.row <= 50)).toBe(true);
  });

  it('caps a single cell rather than storing an essay', () => {
    const long = 'x'.repeat(20_000);
    const workbook = readWorkbook(buildWorkbook([{ name: 'S', rows: [[long]] }]), {
      ...DEFAULT_WORKBOOK_LIMITS,
      maxCellCharacters: 100,
    });
    expect(workbook.sheets[0]!.cells[0]!.value.length).toBe(100);
  });

  it('does not inflate what it was not asked for', () => {
    /**
     * Entries are read on demand. A workbook carrying a 10 MB embedded image
     * costs nothing, because the reader never asks for the image — and that is
     * what makes the per-file budget generous enough to be usable.
     */
    const withImage = buildZip([
      {
        name: 'xl/workbook.xml',
        content: '<workbook xmlns:r="x"><sheets><sheet name="S" r:id="r1"/></sheets></workbook>',
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        content:
          '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
      },
      { name: 'xl/media/image1.png', content: Buffer.alloc(3 * 1024 * 1024, 7) },
      {
        name: 'xl/worksheets/sheet1.xml',
        content:
          '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>q</t></is></c></row></sheetData></worksheet>',
      },
    ]);
    const workbook = readWorkbook(withImage, {
      ...DEFAULT_WORKBOOK_LIMITS,
      maxTotalUncompressedBytes: 256 * 1024,
    });
    expect(workbook.sheets[0]!.cells[0]!.value).toBe('q');
  });

  it('inflates a stored entry too, since not every writer deflates', () => {
    void deflateRawSync;
    const stored = buildZip([
      {
        name: 'xl/workbook.xml',
        content: '<workbook xmlns:r="x"><sheets><sheet name="S" r:id="r1"/></sheets></workbook>',
        stored: true,
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        content:
          '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
        stored: true,
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        content:
          '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>stored</t></is></c></row></sheetData></worksheet>',
        stored: true,
      },
    ]);
    expect(readWorkbook(stored).sheets[0]!.cells[0]!.value).toBe('stored');
  });
});
