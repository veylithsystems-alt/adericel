import { columnName, type WorkbookCell, type WorkbookSheet } from './workbook.js';

/**
 * Finding the questions in somebody else's spreadsheet.
 *
 * No two questionnaires have the same shape. An insurer's has a reference
 * column, a question column and a Yes/No column. A procurement team's has
 * sections, sub-questions, a guidance column and three columns for evidence.
 * Some have the header on row 1, some on row 7 under a logo.
 *
 * THE DESIGN DECISION THAT MATTERS
 *
 * This proposes; it never decides. Every result carries the evidence it reasoned
 * from and a confidence, and the caller is expected to put it in front of a
 * person before a single answer is composed. A layout detector that quietly
 * guessed wrong would produce a questionnaire where every answer is attached to
 * the wrong question — and the answers would each be individually defensible,
 * which is what makes that failure so expensive to find.
 *
 * So the output is a proposal with its reasoning, and `confidence` is allowed to
 * be low. `UNCLEAR` is a real answer here, exactly as UNKNOWN is in the Truth
 * Engine: it means a person needs to look, not that the file is broken.
 */

/** Words that mark a column as holding the question text. */
const QUESTION_HEADERS = [
  'question',
  'questions',
  'query',
  'requirement',
  'requirements',
  'control',
  'controls',
  'criteria',
  'criterion',
  'item',
  'description',
  'details',
  'area',
  'topic',
];

/** Words that mark a column as where the answer goes. */
const ANSWER_HEADERS = [
  'answer',
  'answers',
  'response',
  'responses',
  'reply',
  'yes/no',
  'y/n',
  'compliance',
  'compliant',
  'status',
  'supplier response',
  'vendor response',
  'your response',
  'your answer',
];

/** Words that mark a column as a reference or identifier, not a question. */
const REFERENCE_HEADERS = [
  'ref',
  'reference',
  'id',
  'no',
  'no.',
  'number',
  '#',
  'q',
  'q#',
  'question no',
  'question number',
  'section',
  'clause',
];

/** Words that mark a column as supporting material rather than the answer. */
const EVIDENCE_HEADERS = [
  'evidence',
  'comment',
  'comments',
  'notes',
  'note',
  'guidance',
  'remarks',
  'attachment',
  'attachments',
  'supporting',
  'justification',
];

export const COLUMN_ROLES = ['QUESTION', 'ANSWER', 'REFERENCE', 'EVIDENCE', 'UNKNOWN'] as const;
export type ColumnRole = (typeof COLUMN_ROLES)[number];

export const DETECTION_CONFIDENCE = ['HIGH', 'MEDIUM', 'LOW', 'UNCLEAR'] as const;
export type DetectionConfidence = (typeof DETECTION_CONFIDENCE)[number];

export interface ColumnProposal {
  readonly column: number;
  readonly columnLetter: string;
  readonly header: string | null;
  readonly role: ColumnRole;
  /** Why this role, in the words a reviewer would want. */
  readonly because: string;
}

export interface LayoutProposal {
  readonly sheetName: string;
  /** 1-based row the headers were found on, or null if none was. */
  readonly headerRow: number | null;
  readonly columns: readonly ColumnProposal[];
  readonly questionColumn: number | null;
  readonly answerColumn: number | null;
  readonly referenceColumn: number | null;
  readonly firstQuestionRow: number | null;
  readonly questionCount: number;
  readonly confidence: DetectionConfidence;
  /** What a person should check before this is accepted. Never empty. */
  readonly review: readonly string[];
}

function normalise(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[:*]+$/, '');
}

function matches(header: string, vocabulary: readonly string[]): boolean {
  const normalised = normalise(header);
  if (vocabulary.includes(normalised)) return true;
  // A header like "Question / Requirement" or "Supplier Response (Yes/No)".
  return vocabulary.some(
    (word) => word.length >= 4 && normalised.includes(word) && normalised.length < word.length * 4,
  );
}

function cellsByRow(sheet: WorkbookSheet): Map<number, WorkbookCell[]> {
  const rows = new Map<number, WorkbookCell[]>();
  for (const cell of sheet.cells) {
    const existing = rows.get(cell.row);
    if (existing) existing.push(cell);
    else rows.set(cell.row, [cell]);
  }
  for (const cells of rows.values()) cells.sort((a, b) => a.column - b.column);
  return rows;
}

/** Rows considered as a possible header. Beyond this it is not a header. */
export const MAX_HEADER_SEARCH_ROWS = 20;

/**
 * Score a row on how much it looks like a header.
 *
 * Not "does it contain the word question" — a genuine question row often does
 * too. A header row is short cells, several of them, in one band, and no row
 * above it that scores better.
 */
function scoreAsHeader(cells: readonly WorkbookCell[]): number {
  if (cells.length < 2) return 0;
  let score = 0;
  for (const cell of cells) {
    if (matches(cell.value, QUESTION_HEADERS)) score += 4;
    if (matches(cell.value, ANSWER_HEADERS)) score += 4;
    if (matches(cell.value, REFERENCE_HEADERS)) score += 2;
    if (matches(cell.value, EVIDENCE_HEADERS)) score += 2;
    // Headers are short. A 200-character cell is a question, or a preamble.
    if (cell.value.length <= 40) score += 1;
    else score -= 2;
  }
  return score;
}

function roleFor(header: string): { role: ColumnRole; because: string } {
  // Reference and evidence are checked first: "Question No" matches both the
  // question and the reference vocabulary, and it is a reference.
  if (matches(header, REFERENCE_HEADERS)) {
    return {
      role: 'REFERENCE',
      because: `"${header}" reads as an identifier rather than the question itself.`,
    };
  }
  if (matches(header, EVIDENCE_HEADERS)) {
    return {
      role: 'EVIDENCE',
      because: `"${header}" reads as supporting material rather than the answer.`,
    };
  }
  if (matches(header, ANSWER_HEADERS)) {
    return { role: 'ANSWER', because: `"${header}" reads as where the answer goes.` };
  }
  if (matches(header, QUESTION_HEADERS)) {
    return { role: 'QUESTION', because: `"${header}" reads as the question text.` };
  }
  return { role: 'UNKNOWN', because: `"${header}" matches no column Adericel recognises.` };
}

/**
 * The column holding the longest text, as a fallback when headers say nothing.
 *
 * Questions are prose and everything else on the row is short. This is a real
 * signal and a weak one, so a layout that rests on it is never better than LOW
 * confidence — which is the point: it gets a person to look rather than being
 * refused outright.
 */
function longestTextColumn(
  rows: Map<number, WorkbookCell[]>,
  afterRow: number,
): { column: number; medianLength: number } | null {
  const lengths = new Map<number, number[]>();
  for (const [row, cells] of rows) {
    if (row <= afterRow) continue;
    for (const cell of cells) {
      const list = lengths.get(cell.column) ?? [];
      list.push(cell.value.length);
      lengths.set(cell.column, list);
    }
  }

  let best: { column: number; medianLength: number } | null = null;
  for (const [column, list] of lengths) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    if (!best || median > best.medianLength) best = { column, medianLength: median };
  }
  return best;
}

export function proposeLayout(sheet: WorkbookSheet): LayoutProposal {
  const rows = cellsByRow(sheet);
  const review: string[] = [];

  let headerRow: number | null = null;
  let headerScore = 0;
  for (const [row, cells] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    if (row > MAX_HEADER_SEARCH_ROWS) break;
    const score = scoreAsHeader(cells);
    if (score > headerScore) {
      headerScore = score;
      headerRow = row;
    }
  }

  const headerCells = headerRow === null ? [] : (rows.get(headerRow) ?? []);
  const columns: ColumnProposal[] = headerCells.map((cell) => {
    const { role, because } = roleFor(cell.value);
    return {
      column: cell.column,
      columnLetter: columnName(cell.column),
      header: cell.value,
      role,
      because,
    };
  });

  let questionColumn = columns.find((column) => column.role === 'QUESTION')?.column ?? null;
  const answerColumn = columns.find((column) => column.role === 'ANSWER')?.column ?? null;
  const referenceColumn = columns.find((column) => column.role === 'REFERENCE')?.column ?? null;

  let confidence: DetectionConfidence;
  if (questionColumn !== null && answerColumn !== null) {
    confidence = 'HIGH';
  } else if (questionColumn !== null) {
    confidence = 'MEDIUM';
    review.push(
      'No answer column was identified. Adericel will compose answers but has nowhere ' +
        'obvious to write them back — name the column that should receive them.',
    );
  } else {
    const fallback = longestTextColumn(rows, headerRow ?? 0);
    if (fallback && fallback.medianLength >= 25) {
      questionColumn = fallback.column;
      confidence = 'LOW';
      review.push(
        `No column header names the questions. Column ${columnName(fallback.column)} holds the ` +
          `longest text (typically ${fallback.medianLength} characters), so it is proposed as ` +
          'the question column. Confirm before proceeding.',
      );
      columns.push({
        column: fallback.column,
        columnLetter: columnName(fallback.column),
        header:
          headerRow === null
            ? null
            : (rows.get(headerRow)?.find((c) => c.column === fallback.column)?.value ?? null),
        role: 'QUESTION',
        because:
          'Proposed from cell length rather than a header: questions are prose and everything ' +
          'else on a row is short. This is a weak signal and is why the confidence is LOW.',
      });
    } else {
      confidence = 'UNCLEAR';
      review.push(
        'Adericel could not find the questions in this sheet. Point it at the question ' +
          'column, or send the sheet that holds the questions.',
      );
    }
  }

  const firstQuestionRow =
    questionColumn === null
      ? null
      : ([...rows.keys()]
          .filter((row) => row > (headerRow ?? 0))
          .filter((row) => rows.get(row)?.some((cell) => cell.column === questionColumn))
          .sort((a, b) => a - b)[0] ?? null);

  const questionCount =
    questionColumn === null
      ? 0
      : [...rows.entries()].filter(
          ([row, cells]) =>
            row > (headerRow ?? 0) && cells.some((cell) => cell.column === questionColumn),
        ).length;

  if (headerRow === null) {
    review.push('No header row was found. Adericel read the whole sheet as questions.');
  } else if (headerRow > 1) {
    review.push(
      `The header appears to be on row ${headerRow}; rows above it were treated as a title ` +
        'or preamble rather than as questions.',
    );
  }

  if (questionCount === 0 && confidence !== 'UNCLEAR') {
    review.push('The question column was identified but holds no rows beneath the header.');
  }

  if (sheet.truncatedAfterRow !== null) {
    review.push(
      `This sheet was only read to row ${sheet.truncatedAfterRow}. Any questions below that ` +
        'were not seen at all.',
    );
  }

  // Never empty. A proposal with nothing to check reads as a decision, and this
  // is not one — a person confirms the layout before any answer is composed.
  if (review.length === 0) {
    review.push(
      `Confirm that column ${columnName(questionColumn!)} holds the questions and column ` +
        `${columnName(answerColumn!)} is where answers should go, for all ${questionCount} rows.`,
    );
  }

  return {
    sheetName: sheet.name,
    headerRow,
    columns,
    questionColumn,
    answerColumn,
    referenceColumn,
    firstQuestionRow,
    questionCount,
    confidence,
    review,
  };
}

/**
 * The sheet most likely to hold the questions, and the reasoning.
 *
 * A workbook usually has a cover sheet, a guidance sheet and the questions.
 * Picking the first sheet gets the cover; picking the largest gets a data
 * extract. The one with the most identified questions is the best signal
 * available, and every sheet's proposal is returned alongside so a person can
 * disagree with a single click rather than re-uploading.
 */
export function proposeQuestionnaireLayout(sheets: readonly WorkbookSheet[]): {
  readonly chosen: LayoutProposal | null;
  readonly all: readonly LayoutProposal[];
} {
  const all = sheets.map(proposeLayout);
  const rank: Record<DetectionConfidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, UNCLEAR: 0 };
  const viable = all.filter((proposal) => proposal.confidence !== 'UNCLEAR');

  const chosen =
    [...viable].sort((a, b) => {
      const byConfidence = rank[b.confidence] - rank[a.confidence];
      return byConfidence !== 0 ? byConfidence : b.questionCount - a.questionCount;
    })[0] ?? null;

  return { chosen, all };
}
