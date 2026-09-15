import { describe, expect, it } from 'vitest';
import { manualClock } from '@adericel/shared';
import { createOllamaClient } from './ollama.js';
import { createNullClient } from './factory.js';
import { extractGrounded, groundField } from './extraction.js';

/**
 * Grounded extraction.
 *
 * The failure mode being defended against is the one that scales: a reviewer
 * confirming a hundred supplier certificates will not open a hundred PDFs, and
 * the one they do not open is the one the model invented. A value that cannot
 * show where it came from does not reach that reviewer at all.
 */

const clock = manualClock('2026-09-15T12:00:00.000Z');

const CERTIFICATE = [
  'CYBER ESSENTIALS CERTIFICATE',
  '',
  'Awarded to: Northgate Joinery Ltd',
  'Certificate number: IASME-CE-99321',
  'Valid until: 31 January 2027',
  'Assessed by: Grendon Assurance Ltd',
].join('\n');

const FIELDS = [
  { field: 'certificateNumber', describe: 'The certificate number.' },
  { field: 'expiresOn', describe: 'The date the certificate expires.' },
  { field: 'insurerName', describe: 'The name of the cyber insurer, if stated.' },
];

function clientReturning(value: unknown) {
  const fetchImpl = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({ model: 'llama3.1:8b', message: { content: JSON.stringify(value) } }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )) as unknown as typeof fetch;

  return createOllamaClient({
    baseUrl: 'http://ollama:11434',
    model: 'llama3.1:8b',
    requestTimeoutMs: 30_000,
    maxOutputTokens: 512,
    clock,
    fetchImpl,
  });
}

describe('a quote is checked against the document', () => {
  it('keeps a value whose quote really is in the document', () => {
    const result = groundField('expiresOn', CERTIFICATE, {
      value: '2027-01-31',
      quote: 'Valid until: 31 January 2027',
    });
    expect(result.outcome).toBe('GROUNDED');
    expect(result.value).toBe('2027-01-31');
  });

  it('drops a value whose quote is nowhere in the document', () => {
    // The fabrication that matters: a confident, plausible, entirely invented
    // expiry date. Caught by string search, with no model involved.
    const result = groundField('expiresOn', CERTIFICATE, {
      value: '2028-06-30',
      quote: 'Valid until: 30 June 2028',
    });
    expect(result.outcome).toBe('UNGROUNDED');
    expect(result.value).toBeNull();
    // The bad quote is kept so an operator can see what the model did.
    expect(result.quote).toBe('Valid until: 30 June 2028');
  });

  it('drops a value offered with no quote at all', () => {
    const result = groundField('expiresOn', CERTIFICATE, { value: '2027-01-31', quote: null });
    expect(result.outcome).toBe('UNCITED');
    expect(result.value).toBeNull();
  });

  it('drops a quote too short to ground anything', () => {
    // "20" appears in almost any document and grounds nothing.
    const result = groundField('expiresOn', CERTIFICATE, { value: '2027-01-31', quote: '20' });
    expect(result.outcome).toBe('UNCITED');
  });

  it('believes a reported absence', () => {
    const result = groundField('insurerName', CERTIFICATE, { value: null, quote: null });
    expect(result.outcome).toBe('ABSENT');
    expect(result.value).toBeNull();
  });

  it('tolerates the whitespace damage that PDF extraction causes', () => {
    // A genuine citation from a PDF differs in line breaks and runs of spaces.
    // Treating that as fabrication would drop almost every real quote and teach
    // everybody to ignore the check.
    const result = groundField('certificateNumber', CERTIFICATE, {
      value: 'IASME-CE-99321',
      quote: 'Certificate   number:\n  IASME-CE-99321',
    });
    expect(result.outcome).toBe('GROUNDED');
  });

  it('does not tolerate a changed digit', () => {
    // Whitespace is normalised. Characters and digits are not — those are what
    // a fabrication gets wrong.
    const result = groundField('certificateNumber', CERTIFICATE, {
      value: 'IASME-CE-99322',
      quote: 'Certificate number: IASME-CE-99322',
    });
    expect(result.outcome).toBe('UNGROUNDED');
  });
});

describe('extracting from a document end to end', () => {
  it('proposes grounded fields and drops ungrounded ones in the same answer', async () => {
    const client = clientReturning({
      certificateNumber: { value: 'IASME-CE-99321', quote: 'Certificate number: IASME-CE-99321' },
      // Real value, real quote.
      expiresOn: { value: '31 January 2027', quote: 'Valid until: 31 January 2027' },
      // Invented: there is no insurer on this certificate at all.
      insurerName: { value: 'Hiscox', quote: 'Cyber insurance provided by Hiscox' },
    });

    const result = await extractGrounded(client, {
      document: CERTIFICATE,
      fields: FIELDS,
      documentKind: 'Cyber Essentials certificate',
    });

    expect(result.status).toBe('PROPOSED');
    if (result.status !== 'PROPOSED') return;

    const byField = Object.fromEntries(result.fields.map((f) => [f.field, f]));
    expect(byField.certificateNumber!.outcome).toBe('GROUNDED');
    expect(byField.expiresOn!.outcome).toBe('GROUNDED');
    expect(byField.insurerName!.outcome).toBe('UNGROUNDED');
    expect(byField.insurerName!.value).toBeNull();
    expect(result.ungrounded).toBe(1);
  });

  it('carries the standing sentence, so the proposal is not read as a finding', async () => {
    const client = clientReturning({
      certificateNumber: { value: 'IASME-CE-99321', quote: 'Certificate number: IASME-CE-99321' },
      expiresOn: { value: null, quote: null },
      insurerName: { value: null, quote: null },
    });
    const result = await extractGrounded(client, {
      document: CERTIFICATE,
      fields: FIELDS,
      documentKind: 'Cyber Essentials certificate',
    });
    if (result.status !== 'PROPOSED') throw new Error('expected a proposal');
    expect(result.standing).toMatch(/candidate for a person to confirm/i);
  });

  it('passes a refusal through rather than reporting an empty document', async () => {
    const result = await extractGrounded(createNullClient(clock), {
      document: CERTIFICATE,
      fields: FIELDS,
      documentKind: 'Cyber Essentials certificate',
    });
    expect(result.status).toBe('REFUSED');
    if (result.status !== 'REFUSED') return;
    expect(result.reason).toBe('NOT_CONFIGURED');
    // Not "no certificate number found". That would be a statement about the
    // document, and Adericel never read it.
    expect(result.detail).toMatch(/proposed nothing/i);
  });

  it('returns nothing a rule could consume', async () => {
    const client = clientReturning({
      certificateNumber: { value: 'IASME-CE-99321', quote: 'Certificate number: IASME-CE-99321' },
      expiresOn: { value: null, quote: null },
      insurerName: { value: null, quote: null },
    });
    const result = await extractGrounded(client, {
      document: CERTIFICATE,
      fields: FIELDS,
      documentKind: 'Cyber Essentials certificate',
    });
    if (result.status !== 'PROPOSED') throw new Error('expected a proposal');

    // The strongest available statement: the shape has no field that could
    // carry a determination, a state, a score or a confidence.
    const serialised = JSON.stringify(result);
    expect(serialised).not.toMatch(/SATISFIED|assuranceState|confidence|score/i);
    expect(Object.keys(result.fields[0]!).sort()).toEqual(['field', 'outcome', 'quote', 'value']);
  });
});
