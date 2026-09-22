import { describe, expect, it } from 'vitest';
import { buildWorkbook } from './fixture.js';
import { DEFAULT_WORKBOOK_LIMITS, readWorkbook } from './workbook.js';
import { proposeLayout, proposeQuestionnaireLayout } from './detect.js';

/**
 * Finding the questions in somebody else's spreadsheet.
 *
 * The property running through this file is that the detector **proposes**. A
 * layout guessed wrong produces a questionnaire where every answer is attached
 * to the wrong question — and each answer is individually defensible, which is
 * what makes that failure so expensive to find. So low confidence and UNCLEAR
 * are real answers, and a review note is never absent.
 */

const sheetsOf = (rows: readonly (readonly string[])[], name = 'Questions') =>
  readWorkbook(buildWorkbook([{ name, rows }])).sheets;

describe('the ordinary insurer layout', () => {
  const proposal = proposeLayout(
    sheetsOf([
      ['Ref', 'Question', 'Response', 'Evidence'],
      ['1.1', 'Do you enforce multi-factor authentication on remote access?', '', ''],
      ['1.2', 'Do you hold Cyber Essentials certification?', '', ''],
      ['1.3', 'Are laptops encrypted at rest?', '', ''],
    ])[0]!,
  );

  it('finds the header, the questions and where answers go', () => {
    expect(proposal.headerRow).toBe(1);
    expect(proposal.questionColumn).toBe(2);
    expect(proposal.answerColumn).toBe(3);
    expect(proposal.referenceColumn).toBe(1);
    expect(proposal.questionCount).toBe(3);
    expect(proposal.confidence).toBe('HIGH');
  });

  it('does not mistake the reference column for the question', () => {
    // "Ref" holds "1.1", and a detector that took column A would attach every
    // answer to a number.
    expect(proposal.columns.find((column) => column.column === 1)?.role).toBe('REFERENCE');
  });

  it('does not mistake the evidence column for the answer', () => {
    expect(proposal.columns.find((column) => column.column === 4)?.role).toBe('EVIDENCE');
  });

  it('still asks a person to confirm, even at HIGH confidence', () => {
    // A proposal with nothing to check reads as a decision, and this is not
    // one. The review list is never empty.
    expect(proposal.review.length).toBeGreaterThan(0);
    expect(proposal.review.join(' ')).toMatch(/confirm/i);
  });

  it('says why each column got its role', () => {
    for (const column of proposal.columns) {
      expect(column.because.length).toBeGreaterThan(20);
      expect(column.because).toContain(column.header!);
    }
  });
});

describe('layouts that are not the easy one', () => {
  it('finds a header below a title block', () => {
    // A logo and a title above the table is the commonest real shape, and a
    // detector that assumed row 1 would read the company name as a question.
    const proposal = proposeLayout(
      sheetsOf([
        ['ACME Insurance — Cyber Risk Questionnaire 2026'],
        [''],
        ['Please complete every row. Return by 30 April.'],
        [''],
        ['Ref', 'Question', 'Supplier Response'],
        ['1', 'Do you patch critical vulnerabilities within 14 days?', ''],
        ['2', 'Do you run anti-malware on all endpoints?', ''],
      ])[0]!,
    );
    expect(proposal.headerRow).toBe(5);
    expect(proposal.questionColumn).toBe(2);
    expect(proposal.answerColumn).toBe(3);
    expect(proposal.questionCount).toBe(2);
    expect(proposal.review.join(' ')).toMatch(/row 5/);
    expect(proposal.review.join(' ')).toMatch(/title or preamble/i);
  });

  it('handles "Requirement" and "Compliance" instead of "Question" and "Answer"', () => {
    const proposal = proposeLayout(
      sheetsOf([
        ['Clause', 'Requirement', 'Compliance'],
        ['A.5.1', 'Information security policies are defined and approved.', ''],
        ['A.5.2', 'Information security roles are allocated.', ''],
      ])[0]!,
    );
    expect(proposal.questionColumn).toBe(2);
    expect(proposal.answerColumn).toBe(3);
    expect(proposal.confidence).toBe('HIGH');
  });

  it('falls back to the longest prose column, at LOW confidence and never higher', () => {
    /**
     * Headers that say nothing useful. Questions are prose and everything else
     * on the row is short, which is a real signal and a weak one — so the
     * fallback is allowed, and is never allowed to look confident.
     */
    const proposal = proposeLayout(
      sheetsOf([
        ['A', 'B', 'C'],
        ['1', 'Do you enforce multi-factor authentication on all remote access paths?', 'Y'],
        ['2', 'Are all company laptops encrypted with full-disk encryption at rest?', 'Y'],
        ['3', 'Do you hold a current Cyber Essentials Plus certificate from IASME?', 'N'],
      ])[0]!,
    );
    expect(proposal.confidence).toBe('LOW');
    expect(proposal.questionColumn).toBe(2);
    expect(proposal.review.join(' ')).toMatch(/no column header names the questions/i);
    expect(proposal.review.join(' ')).toMatch(/confirm before proceeding/i);
  });

  it('says UNCLEAR rather than inventing a question column', () => {
    /**
     * A sheet of short codes is not a questionnaire. UNCLEAR here is exactly
     * UNKNOWN in the Truth Engine: it means a person needs to look, not that
     * the file is broken — and it is a better answer than a confident guess
     * that attaches thirty answers to thirty reference numbers.
     */
    const proposal = proposeLayout(
      sheetsOf([
        ['A', 'B', 'C'],
        ['1', 'Y', 'N'],
        ['2', 'N', 'Y'],
      ])[0]!,
    );
    expect(proposal.confidence).toBe('UNCLEAR');
    expect(proposal.questionColumn).toBeNull();
    expect(proposal.review.join(' ')).toMatch(/could not find the questions/i);
  });

  it('flags a question column with no answer column, rather than proceeding silently', () => {
    const proposal = proposeLayout(
      sheetsOf([
        ['Ref', 'Question'],
        ['1', 'Do you encrypt data at rest in transit and at rest?'],
      ])[0]!,
    );
    expect(proposal.confidence).toBe('MEDIUM');
    expect(proposal.answerColumn).toBeNull();
    expect(proposal.review.join(' ')).toMatch(/nowhere obvious to write them back/i);
  });

  it('warns when the sheet was truncated, because the missing rows are invisible', () => {
    const rows: string[][] = [['Ref', 'Question', 'Response']];
    for (let index = 1; index <= 100; index += 1) {
      rows.push([String(index), `Do you do the thing numbered ${index} correctly?`, '']);
    }
    const sheet = readWorkbook(buildWorkbook([{ name: 'Q', rows }]), {
      ...DEFAULT_WORKBOOK_LIMITS,
      maxRowsPerSheet: 20,
    }).sheets[0]!;

    const proposal = proposeLayout(sheet);
    expect(proposal.review.join(' ')).toMatch(/only read to row 20/i);
    expect(proposal.review.join(' ')).toMatch(/not seen at all/i);
  });
});

describe('choosing a sheet out of a workbook', () => {
  it('skips the cover sheet and the guidance for the questions', () => {
    /**
     * A real workbook has three sheets and only one holds questions. Taking the
     * first gets the cover; taking the largest gets whatever data extract
     * somebody attached.
     */
    const workbook = readWorkbook(
      buildWorkbook([
        { name: 'Cover', rows: [['ACME Insurance'], ['Cyber Questionnaire 2026']] },
        {
          name: 'Guidance',
          rows: [['How to complete this form'], ['Answer every row. Attach evidence.']],
        },
        {
          name: 'Questions',
          rows: [
            ['Ref', 'Question', 'Response'],
            ['1', 'Do you enforce multi-factor authentication?', ''],
            ['2', 'Do you encrypt laptops?', ''],
          ],
        },
      ]),
    );

    const { chosen, all } = proposeQuestionnaireLayout(workbook.sheets);
    expect(chosen?.sheetName).toBe('Questions');
    // Every sheet's proposal comes back, so a person can disagree with one
    // click rather than re-uploading the file.
    expect(all).toHaveLength(3);
  });

  it('returns nothing chosen when no sheet holds questions', () => {
    const workbook = readWorkbook(
      buildWorkbook([
        {
          name: 'Data',
          rows: [
            ['A', 'B'],
            ['1', '2'],
          ],
        },
      ]),
    );
    expect(proposeQuestionnaireLayout(workbook.sheets).chosen).toBeNull();
  });

  it('prefers a confident sheet over a larger unconfident one', () => {
    // Twenty rows of prose in an unlabelled column beats nothing, but it does
    // not beat three rows under a header that says "Question".
    const vague = Array.from({ length: 20 }, (_unused, index) => [
      `Some long descriptive line of text number ${index} that reads like prose`,
    ]);
    const workbook = readWorkbook(
      buildWorkbook([
        { name: 'Vague', rows: [['A'], ...vague] },
        {
          name: 'Clear',
          rows: [
            ['Question', 'Answer'],
            ['Do you encrypt laptops?', ''],
            ['Do you enforce MFA?', ''],
          ],
        },
      ]),
    );
    expect(proposeQuestionnaireLayout(workbook.sheets).chosen?.sheetName).toBe('Clear');
  });
});
