import type { PersonalDataEntry } from '@adericel/domain';

/**
 * Personal data Veylith holds as a controller, rather than as a processor.
 *
 * WHY THIS IS NOT IN THE PRODUCT'S REGISTER
 *
 * It used to be. `PERSONAL_DATA_REGISTRY` in `@adericel/domain` carried the
 * company's prospects table, so every customer's copy of the register named it
 * — and once the retention schedule was served to customers at
 * `GET /v1/retention`, a customer reading what Adericel holds about people was
 * told it retains "prospect" data. That is Veylith's marketing about MSPs it
 * approached. No customer deployment holds it, the table does not exist in a
 * product install, and a register that names a table the schema does not create
 * is a register nobody has read since the migration that would have removed it.
 *
 * Found by extracting the product and checking the register against the schema
 * the product's own migrations produce.
 *
 * The product's register holds what a deployment holds. This is composed on top
 * by Veylith's own deployment, the same way its routes are.
 */
export const COMPANY_PERSONAL_DATA: readonly PersonalDataEntry[] = [
  // ---------------------------------------------------------------------------
  // Business contacts Veylith approached. Controller, legitimate interests,
  // B2B only.
  // ---------------------------------------------------------------------------
  {
    table: 'veylith.prospects',
    columns: ['contact_email', 'contact_name'],
    subject: 'PROSPECT',
    role: 'CONTROLLER',
    purpose: 'Approach an MSP about Adericel, and remember not to approach it twice.',
    lawfulBasis: 'LEGITIMATE_INTERESTS',
    retention: {
      policy: 'FIXED_PERIOD',
      days: 730,
      timestampColumn: 'updated_at',
      rationale:
        'Two years without engagement, after which continuing to hold a named ' +
        "person's details for a conversation that never happened is not a " +
        'legitimate interest any more.',
    },
    erasure: 'DELETE',
    specialCategory: false,
  },
];
