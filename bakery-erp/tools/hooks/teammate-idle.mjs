#!/usr/bin/env node
// Agent-team hook: TeammateIdle — objective gate (targeted).
// Stops an IMPLEMENTER teammate (bakery-backend / bakery-frontend) from going idle
// while `npm run check:schema` is red — i.e. don't leave the tree broken. Advisory
// agents (flow-expert, schema-guard, qa-pm, ux-researcher) idle freely. Exit 2 =
// keep working. Fails OPEN when the agent type is unknown/absent.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

let data = {};
try { data = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* fail open */ }

const IMPLEMENTERS = new Set(['bakery-backend', 'bakery-frontend']);
if (!IMPLEMENTERS.has(data.agent_type)) process.exit(0);

const here = dirname(fileURLToPath(import.meta.url));
const genSchema = resolve(here, '..', 'gen-schema.mjs');
const r = spawnSync(process.execPath, [genSchema, '--check'], { encoding: 'utf8' });
if (r.status !== 0) {
  process.stderr.write(
    `TeammateIdle blocked for ${data.agent_type}: don't go idle with a red schema — ` +
    '`npm run check:schema` is failing. Run `npm run gen:schema` and fix before idling.\n'
  );
  process.exit(2);
}
process.exit(0);
