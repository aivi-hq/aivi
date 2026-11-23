'use strict';
// Loaded into the test runner and into every test process (`--require` in the
// `test` scripts). Two failsafes, so that a stuck test costs seconds or
// minutes, never hours.
//
// A test process: still alive a few seconds after its last test, it is held
// open by something a test left behind (a server, a timer, a child process).
// This fails that file, by name. It replaces `test-force-exit`, which cut such
// a process off, and could drop the report of its last tests while doing so:
// Node writes to the runner's pipe asynchronously on POSIX, and `process.exit()`
// does not wait for the write.
//
// The runner: still going after 5 minutes (a full run takes well under one), it
// kills every process under it and fails. `--test-timeout` ends a test that
// awaits something that never comes, but not one that never yields (a
// synchronous loop), and killing the runner alone leaves its test processes
// running. `AIVI_TEST_LIMIT_MS` moves the ceiling.
//
// A `--require`, not an `--import`: the runner does not run `--import`
// modules, and not a `nodeOptions` entry in node.config.json either: with
// `NODE_OPTIONS` set, which the scripts need, Node leaves those out.
const { execFileSync } = require('node:child_process');

const GRACE_MS = 10_000;
const LIMIT_MS = Number(process.env.AIVI_TEST_LIMIT_MS ?? 300_000);
// The real ones: a test may have mocked the global timer, or replaced these.
const arm = setTimeout;
const exit = process.exit;
const write = process.stderr.write.bind(process.stderr);
// What keeps a test process alive before any test ran (its pipes to the runner): not a leak.
const baseline = process.getActiveResourcesInfo();

/** Every process under this one, however deep. */
function descendants() {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map(line => line.trim().split(/\s+/).map(Number));
  const found = [];
  const queue = [process.pid];
  while (queue.length) {
    const parent = queue.shift();
    for (const [pid, ppid] of rows) {
      if (ppid === parent) {
        found.push(pid);
        queue.push(pid);
      }
    }
  }
  return found;
}

/** End this process and everything it started: an orphan outlives its parent by hours. */
function end(message) {
  const doomed = descendants();
  write(`${message}\n`);
  for (const pid of doomed) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  exit(1);
}

// What is keeping the process alive now, beyond that baseline.
function leaked() {
  const held = process.getActiveResourcesInfo();
  for (const name of baseline) {
    const at = held.indexOf(name);
    if (at !== -1) held.splice(at, 1);
  }
  return held;
}

if (process.env.NODE_TEST_CONTEXT) {
  require('node:test').after(() => {
    arm(() => {
      const held = [...new Set(leaked())].join(', ') || 'nothing it can name';
      end(`still running ${GRACE_MS} ms after its last test, held open by: ${held}`);
    }, GRACE_MS).unref();
  });
} else {
  arm(
    () => end(`the test run is still going after ${LIMIT_MS / 1000} s. Killing every test process.`),
    LIMIT_MS,
  ).unref();
}
