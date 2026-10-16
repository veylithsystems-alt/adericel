/**
 * Start everything a developer needs, in one command.
 *
 * `pnpm dev` is the first command the README tells somebody to run, and it was
 * broken: `package.json` pointed at this file and this file had never been
 * committed. Nothing caught it because nothing runs it in CI — the same shape
 * as the exported functions nothing calls, arriving from the other direction.
 * `tests/unit/scripts-resolve.test.ts` now fails when a command names a file
 * that does not exist.
 *
 * Three processes, not one: the API, the worker and the web interface. The
 * worker matters more than it looks. Without it nothing is collected and
 * nothing is reassessed, so a developer would see an interface full of
 * UNKNOWN and reasonably conclude the product was broken rather than that
 * half of it was not running.
 */
import { spawn } from 'node:child_process';

const PROCESSES = [
  { name: 'api', script: 'dev:api', colour: '\u001b[36m' },
  { name: 'worker', script: 'dev:worker', colour: '\u001b[35m' },
  { name: 'web', script: 'dev:web', colour: '\u001b[32m' },
];

const RESET = '\u001b[0m';
const children = [];
let shuttingDown = false;

/** Prefix every line so three interleaved logs stay readable. */
function pipe(child, name, colour) {
  const label = `${colour}[${name}]${RESET} `;
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    let partial = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      const lines = (partial + chunk).split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) process.stdout.write(`${label}${line}\n`);
    });
    // A final line without a trailing newline would otherwise be swallowed,
    // and that is exactly where a crash message tends to be.
    stream.on('end', () => {
      if (partial.length > 0) process.stdout.write(`${label}${partial}\n`);
    });
  }
}

/**
 * Stop everything, once.
 *
 * A developer pressing Ctrl-C twice must not leave one process orphaned
 * holding port 4000, because the next `pnpm dev` then fails for a reason that
 * looks like a code problem.
 */
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill(signal);
  }
}

for (const { name, script, colour } of PROCESSES) {
  const child = spawn('pnpm', ['-s', 'run', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  children.push(child);
  pipe(child, name, colour);

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    /**
     * One process dying takes the others with it.
     *
     * Leaving the survivors running is worse than stopping: a developer whose
     * worker crashed on startup would carry on against an interface that
     * silently never updates, which is the same confusion the worker exists to
     * prevent.
     */
    process.stdout.write(
      `${colour}[${name}]${RESET} exited (${signal ?? `code ${code}`}); stopping the rest.\n`,
    );
    process.exitCode = code ?? 1;
    shutdown('SIGTERM');
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal));
}

process.stdout.write('API on :4000, worker running, interface on :5173. Ctrl-C stops all three.\n');
