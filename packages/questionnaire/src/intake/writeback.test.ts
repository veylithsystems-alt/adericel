import { describe, expect, it } from 'vitest';
import { neutraliseForSpreadsheet, planWriteBack } from './writeback.js';

/**
 * Writing an answer into somebody else's spreadsheet.
 *
 * The file goes to an insurer, an auditor or a procurement team — people who
 * matter to our customer and who trust them. A cell beginning `=` is a formula
 * when they open it, so writing an answer verbatim is a code-execution
 * primitive aimed at the recipient, delivered by Adericel, signed by our
 * customer.
 *
 * This is the file that stops that.
 */

describe('formula injection', () => {
  it('neutralises every character a spreadsheet reads as a formula', () => {
    for (const leader of ['=', '+', '-', '@']) {
      const result = neutraliseForSpreadsheet(`${leader}cmd|' /C calc'!A1`);
      expect(result.neutralised, leader).toBe(true);
      expect(result.value.startsWith("'"), leader).toBe(true);
    }
  });

  it('neutralises a formula hidden behind whitespace', () => {
    /**
     * The check that a first-character test would miss. Excel trims tabs,
     * carriage returns and line feeds before deciding whether a cell is a
     * formula, so `\\t=HYPERLINK(...)` is a formula and a naive check passes it
     * straight through.
     */
    for (const prefix of ['\t', '\r', '\n', ' ', '\t\r\n ', '  \t']) {
      const result = neutraliseForSpreadsheet(`${prefix}=HYPERLINK("http://x","click")`);
      expect(result.neutralised, JSON.stringify(prefix)).toBe(true);
    }
  });

  it('keeps the value intact rather than stripping the character', () => {
    /**
     * A leading quote is not displayed, is not part of the value when read
     * back, and stops the parse. Stripping the character instead would silently
     * change an answer that legitimately begins with a minus sign — "-40°C
     * operating range" becomes "40°C operating range", which is a different
     * claim.
     */
    const result = neutraliseForSpreadsheet('-40 degrees is the rated minimum');
    expect(result.value).toBe("'-40 degrees is the rated minimum");
    expect(result.value.slice(1)).toBe('-40 degrees is the rated minimum');
  });

  it('leaves an ordinary answer exactly as composed', () => {
    // A control that altered everything would pass every test above and would
    // mangle every real answer.
    for (const answer of [
      'Yes. Multi-factor authentication is enforced on all remote access.',
      'Partially — enforced for staff, not yet for three contractor accounts.',
      'No.',
      'Not applicable: we operate no on-premises infrastructure.',
      '99.95% measured over the last twelve months',
      '"Yes", with the exception noted below',
    ]) {
      const result = neutraliseForSpreadsheet(answer);
      expect(result.neutralised, answer).toBe(false);
      expect(result.value).toBe(answer);
    }
  });

  it('has no way to be turned off', () => {
    // Asserted over the signature: a caller cannot pass an option, because
    // there is no option. An escape hatch here would be used once, under
    // deadline, and then be the default.
    expect(neutraliseForSpreadsheet.length).toBe(1);
  });

  it('says what it changed, in the words an operator needs', () => {
    const result = neutraliseForSpreadsheet('=1+1');
    expect(result.because).toMatch(/reads as a formula/i);
    expect(result.because).toMatch(/value itself is unchanged/i);
  });
});

describe('the write-back plan', () => {
  it('names each cell it will change, and reports what it neutralised', () => {
    const plan = planWriteBack('Questions', [
      { row: 2, column: 3, value: 'Yes. Enforced for all users.' },
      { row: 3, column: 3, value: '=cmd|calc' },
    ]);

    expect(plan.cells.map((cell) => cell.reference)).toEqual(['C2', 'C3']);
    expect(plan.answered).toBe(2);
    expect(plan.cells[1]!.neutralised).toBe(true);
    // The note surfaces before the file is sent, not in a log afterwards.
    expect(plan.notes.join(' ')).toMatch(/C3:/);
    expect(plan.notes.join(' ')).toMatch(/reads as a formula/i);
  });

  it('skips an empty answer rather than writing a blank over the question', () => {
    const plan = planWriteBack('Q', [
      { row: 2, column: 2, value: '' },
      { row: 3, column: 2, value: '   ' },
      { row: 4, column: 2, value: 'Yes' },
    ]);
    expect(plan.answered).toBe(1);
    expect(plan.skipped).toBe(2);
  });

  it('refuses both answers when two target the same cell', () => {
    /**
     * Two answers for one cell is a layout error upstream. Letting the last
     * one win silently would put an answer against the wrong question, which
     * is the failure mode the whole intake path is built to avoid.
     */
    const plan = planWriteBack('Q', [
      { row: 2, column: 3, value: 'Yes' },
      { row: 2, column: 3, value: 'No' },
    ]);
    expect(plan.answered).toBe(1);
    expect(plan.skipped).toBe(1);
    expect(plan.notes.join(' ')).toMatch(/two different answers/i);
    expect(plan.notes.join(' ')).toMatch(/resolve the duplicate/i);
  });

  it('builds references past column Z', () => {
    expect(planWriteBack('Q', [{ row: 5, column: 27, value: 'Yes' }]).cells[0]!.reference).toBe(
      'AA5',
    );
  });
});
