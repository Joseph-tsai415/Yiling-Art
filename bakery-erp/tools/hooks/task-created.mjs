#!/usr/bin/env node
// Agent-team hook: TaskCreated — objective gate.
// Rejects a task whose text names no file owner, so two teammates don't edit the
// same file (the app.js / submodule conflict class). Exit 2 + stderr = feedback.
// Field-name-agnostic: strips the documented common fields and scans everything
// else for a file path or an owning agent. Fails OPEN (allows) on empty/unreadable
// stdin, so a payload-shape surprise never blocks every task.
import { readFileSync } from 'node:fs';

let raw = '';
try { raw = readFileSync(0, 'utf8'); } catch { /* no stdin */ }
if (!raw.trim()) process.exit(0); // fail open

let data;
try { data = JSON.parse(raw); } catch { process.exit(0); } // fail open on non-JSON

const NOISE = new Set([
  'session_id', 'prompt_id', 'transcript_path', 'cwd', 'permission_mode',
  'hook_event_name', 'agent_id', 'agent_type', 'team_name'
]);
const rest = {};
for (const [k, v] of Object.entries(data)) if (!NOISE.has(k)) rest[k] = v;
const text = JSON.stringify(rest);

// A source file path (has a known extension) OR an explicit owner / one of our agents.
const OWNER = /\.(js|mjs|cjs|ts|html|css|json|md)\b|\bowner\b|bakery-backend|bakery-frontend|bakery-flow-expert|schema-guard|qa-pm|ux-researcher/i;

if (!OWNER.test(text)) {
  process.stderr.write(
    'TaskCreated blocked: this task names no file owner. Rewrite it to name the ' +
    'file(s) it touches (e.g. bakery-erp/js/app.js) or the owning agent (e.g. ' +
    'bakery-backend) so two teammates never edit the same file. See CLAUDE.md → ' +
    '"bakery-erp: execute work as an agent team".\n'
  );
  process.exit(2);
}
process.exit(0);
