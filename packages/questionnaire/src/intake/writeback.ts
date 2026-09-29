/**
 * Putting answers back into a spreadsheet.
 *
 * Adericel composes an answer; somebody has to send it. Writing it into the
 * sender's own workbook, in the column they asked for, is the difference between
 * a tool that drafts answers and a tool that completes a questionnaire.
 *
 * THE ONE THING THIS FILE EXISTS TO GET RIGHT
 *
 * A cell whose text begins `=`, `+`, `-` or `@` is a formula when the file is
 * opened. So is one beginning with a tab or carriage return followed by any of
 * them, because Excel trims first and interprets second. That means writing an
 * answer verbatim into a spreadsheet is a code-execution primitive aimed at the
 * recipient — the insurer, the auditor, the procurement team — and it would be
 * Adericel's file that did it.
 *
 * This is not hypothetical for a compliance product. An attacker who can get
 * text into one of our customers' questionnaire answers gets us to deliver it,
 * signed by our customer, to somebody who trusts them.
 *
 * Every value written here is neutralised. There is no option to turn it off.
 */

const FORMULA_LEADERS = ['=', '+', '-', '@'];

/**
 * Characters Excel strips before deciding whether a cell is a formula.
 *
 * Tab, carriage return and line feed. `\t=cmd` is a formula; a check that only
 * looked at the first character would pass it straight through.
 */
const TRIMMED_BEFORE_PARSING = ['\t', '\r', '\n', ' '];

export interface NeutralisedValue {
  readonly value: string;
  /** True when the value was altered. Reported, never silent. */
  readonly neutralised: boolean;
  readonly because: string | null;
}

/**
 * Make a string safe to place in a spreadsheet cell.
 *
 * Prefixes a single quote, which is the convention every spreadsheet
 * application understands as "this is text": it is not displayed, it is not
 * part of the value when the cell is read back, and it stops the parse. The
 * alternative — stripping the leading character — would silently change an
 * answer that legitimately begins with a minus sign.
 */
export function neutraliseForSpreadsheet(raw: string): NeutralisedValue {
  if (raw === '') return { value: '', neutralised: false, because: null };

  let index = 0;
  while (index < raw.length && TRIMMED_BEFORE_PARSING.includes(raw[index]!)) index += 1;
  const firstMeaningful = raw[index];

  if (firstMeaningful !== undefined && FORMULA_LEADERS.includes(firstMeaningful)) {
    return {
      value: `'${raw}`,
      neutralised: true,
      because:
        `This value begins with "${firstMeaningful}", which a spreadsheet reads as a formula. ` +
        'It has been marked as text so the recipient sees the words rather than running them. ' +
        'The value itself is unchanged.',
    };
  }

  return { value: raw, neutralised: false, because: null };
}

export interface AnswerToWrite {
  /** 1-based row in the sheet the layout identified. */
  readonly row: number;
  /** 1-based column the layout named as the answer column. */
  readonly column: number;
  readonly value: string;
}

export interface WriteBackPlan {
  readonly sheetName: string;
  readonly cells: readonly {
    readonly reference: string;
    readonly value: string;
    readonly neutralised: boolean;
  }[];
  /** Every alteration, so the operator sees them before the file is sent. */
  readonly notes: readonly string[];
  readonly answered: number;
  readonly skipped: number;
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
 * The cells to change, and what changing them will do.
 *
 * A plan rather than a mutation, for the same reason an action is proposed
 * before it is executed: this file is going to somebody who matters to our
 * customer, and the operator should see exactly what will appear in it.
 */
export function planWriteBack(sheetName: string, answers: readonly AnswerToWrite[]): WriteBackPlan {
  const cells: { reference: string; value: string; neutralised: boolean }[] = [];
  const notes: string[] = [];
  let skipped = 0;

  const seen = new Set<string>();

  for (const answer of answers) {
    const reference = `${columnLetter(answer.column)}${answer.row}`;

    if (seen.has(reference)) {
      // Two answers for one cell is a layout error upstream, and the last one
      // winning silently would put an answer against the wrong question.
      notes.push(
        `${reference} was given two different answers. Neither was written — resolve the ` +
          'duplicate before sending.',
      );
      skipped += 1;
      continue;
    }
    seen.add(reference);

    if (answer.value.trim() === '') {
      skipped += 1;
      continue;
    }

    const neutralised = neutraliseForSpreadsheet(answer.value);
    if (neutralised.neutralised && neutralised.because) {
      notes.push(`${reference}: ${neutralised.because}`);
    }
    cells.push({
      reference,
      value: neutralised.value,
      neutralised: neutralised.neutralised,
    });
  }

  return { sheetName, cells, notes, answered: cells.length, skipped };
}
