#!/usr/bin/env node
// Agent-team hook: TaskCompleted — objective gate.
// Blocks marking a task complete while `npm run check:schema` is failing
// (apps-script.js gen block stale vs js/schema.js). Exit 2 + stderr = feedback.
// Payload-agnostic: the gate is objective, so it does not read the task JSON.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const genSchema = resolve(here, '..', 'gen-schema.mjs'); // bakery-erp/tools/gen-schema.mjs

const r = spawnSync(process.execPath, [genSchema, '--check'], { encoding: 'utf8' });
if (r.status !== 0) {
  process.stderr.write(
    'TaskCompleted blocked: `npm run check:schema` is failing — the apps-script.js ' +
    'gen block is stale vs js/schema.js. Run `npm run gen:schema`, confirm it is green, ' +
    'then mark this task complete.\n' +
    (r.stdout || '') + (r.stderr || '')
  );
  process.exit(2);
}
process.exit(0);
