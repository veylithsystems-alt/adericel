/**
 * The proof-of-value machine, run against a portfolio, printing real figures.
 *
 * Everything this prints is produced by the real engine against a real
 * database: five customer organisations under one MSP, collected from,
 * assessed, and then asked what the work was worth. Nothing is mocked and no
 * figure is written into this file.
 *
 * The durations are supplied here as an illustration of what an MSP would
 * enter. They are labelled MSP_MEASURED because that is what the flow expects
 * a real MSP to provide — in this script they are made up, and the output says
 * so. Adericel supplies none of them, which is the entire point.
 *
 *   pnpm proof-of-value
 */
import { bearer, createHarness, seedTenant, signIn } from '../tests/helpers/harness.js';

function estate(prefix: string, identities: number, bad: number) {
  const records = [];
  for (let i = 0; i < identities; i += 1) {
    records.push({
      kind: 'IDENTITY_STATE',
      subjectExternalId: `${prefix}-user-${i}`,
      payload: {
        externalId: `${prefix}-user-${i}`,
        displayName: `${prefix} person ${i}`,
        enabled: true,
        accountType: 'USER',
        mfaEnforced: i >= bad,
        lastSignInAt: '2026-09-01T09:00:00.000Z',
      },
    });
  }
  return records;
}

const harness = await createHarness();
await harness.truncate();

const shapes = [
  { slug: 'demo-alpha', identities: 12, bad: 3 },
  { slug: 'demo-bravo', identities: 8, bad: 1 },
  { slug: 'demo-charlie', identities: 20, bad: 5 },
  { slug: 'demo-delta', identities: 6, bad: 2 },
  { slug: 'demo-echo', identities: 15, bad: 4 },
];

const orgs = [];
for (const shape of shapes) {
  orgs.push(
    await seedTenant(harness, {
      slug: shape.slug,
      mspSlug: 'demo-portfolio',
      records: estate(shape.slug, shape.identities, shape.bad),
      autonomyLevel: 4,
    }),
  );
}
const mspId = orgs[0]!.mspId;
const token = await signIn(harness, 'owner-demo-alpha@test.invalid');

for (const org of orgs) {
  await harness.server.inject({
    method: 'POST',
    url: `/v1/organisations/${org.organisationId}/integrations/${org.integrationId}/collect`,
    headers: bearer(token),
  });
  await harness.server.inject({
    method: 'POST',
    url: `/v1/organisations/${org.organisationId}/assessments/run-all`,
    headers: bearer(token),
    payload: {},
  });
}

const timings: [string, number, string][] = [
  ['evidence.collect', 4, 'Timed across 20 samples'],
  ['evidence.file', 2, 'Timed across 20 samples'],
  ['control.determine', 6, 'Timed by two engineers'],
  ['control.explain', 5, 'Timed by two engineers'],
  ['change.detect', 8, 'From the monthly review'],
  ['change.impact', 12, 'From the monthly review'],
  ['finding.triage', 7, 'From the ticket queue'],
  ['remediation.perform', 15, 'From the ticket queue'],
  ['remediation.verify', 9, 'From the ticket queue'],
  ['report.produce', 90, 'The monthly pack, timed'],
  ['enquiry.answer', 35, 'From three insurer requests'],
];
for (const [taskKey, minutes, basis] of timings) {
  await harness.server.inject({
    method: 'PUT',
    url: `/v1/msps/${mspId}/value/effort-model/${taskKey}`,
    headers: bearer(token),
    payload: { minutes, source: 'MSP_MEASURED', basis },
  });
}

const response = await harness.server.inject({
  method: 'GET',
  url: `/v1/msps/${mspId}/value/report?windowDays=30&target=100&ftePerMonthHours=130`,
  headers: bearer(token),
});
// The demo prints whatever the API returns; typing it fully here would
// duplicate the report shape for no benefit in a script.
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
const { report, projection } = response.json() as any;

console.log('\n=== WHAT ADERICEL DID (5 customers, one cycle) ===');
for (const [k, v] of Object.entries(report.ledger)) {
  if (typeof v === 'number' && v > 0) console.log(`  ${k.padEnd(32)} ${v}`);
}
console.log('\n=== THE ARITHMETIC ===');
for (const line of report.lines) {
  if (line.performedByAdericel === 0 && line.performedByPeople === 0) continue;
  console.log(
    `  ${line.task.key.padEnd(22)} ${String(line.performedByAdericel).padStart(5)} x ${String(line.minutesEach).padStart(3)}m ` +
      `= ${String(line.hoursDisplaced).padStart(7)}h displaced | ${String(line.hoursStillSpent).padStart(6)}h still spent (${line.performedByPeople} by people)`,
  );
}
console.log('\n  hours if entirely manual :', report.hoursIfEntirelyManual);
console.log('  hours displaced          :', report.hoursDisplaced);
console.log('  hours still spent        :', report.hoursStillSpent);
console.log('  model completeness       :', report.modelCompleteness);

console.log('\n=== PROJECTED TO 100 CUSTOMERS ===');
console.log('  basis                :', projection.basis);
console.log(
  '  without Adericel     :',
  projection.hoursWithoutAdericel,
  'h/month =',
  projection.fteWithoutAdericel,
  'FTE',
);
console.log(
  '  with Adericel        :',
  projection.hoursWithAdericel,
  'h/month =',
  projection.fteWithAdericel,
  'FTE',
);
console.log('  released             :', projection.hoursReleased, 'h/month');

console.log('\n=== CAVEATS THE REPORT RAISES ABOUT ITSELF ===');
for (const c of [...report.caveats, ...projection.caveats]) console.log('  -', c);

console.log(
  '\nThe durations above were typed into this script, not measured by an MSP. ' +
    'Adericel supplied none of them, and supplies none in production either.',
);

await harness.close();
process.exit(0);
