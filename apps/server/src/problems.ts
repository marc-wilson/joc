// What went wrong in each machine's plugin, as the plugin reports it once the server answers
// again (apps/plugin/src/problems.ts keeps the record). One document per owner, machine, kind
// and place, updated as the plugin's count goes up; one nobody re-reports for a week is dropped.
import { getDb } from '@joc/db';
import type { MachineProblem, ProblemKind, ProblemsReport } from '@joc/protocol';
import type { Owner } from './owner.ts';

const KEEP_DAYS = 7;
/** The Machines page shows this many, latest first. */
const LISTED = 50;

interface ProblemDoc {
  owner: string;
  machine: string;
  kind: ProblemKind;
  where: string;
  detail: string;
  firstAt: Date;
  lastAt: Date;
  count: number;
  resolvedAt: Date | null;
  updatedAt: Date;
}

const problems = () => getDb().collection<ProblemDoc>('plugin_problems');

let indexed: Promise<unknown> | undefined;
function ensureProblemIndexes(): Promise<unknown> {
  indexed ??= Promise.all([
    problems().createIndex({ owner: 1, machine: 1, kind: 1, where: 1 }, { unique: true }),
    problems().createIndex({ owner: 1, lastAt: -1 }),
    problems().createIndex({ updatedAt: 1 }, { expireAfterSeconds: KEEP_DAYS * 86_400 }),
  ]);
  return indexed;
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

/** Stores what one of the owner's machines sent; an older version than stored is dropped. */
export async function saveProblems(owner: Owner, report: ProblemsReport): Promise<void> {
  await ensureProblemIndexes();
  const updatedAt = new Date();
  for (const p of report.problems) {
    const lastAt = new Date(p.lastAt);
    try {
      await problems().updateOne(
        // Hooks run side by side, so a machine's reports can arrive out of order.
        { owner, machine: report.machine, kind: p.kind, where: p.where, lastAt: { $lte: lastAt } },
        {
          $set: {
            detail: p.detail,
            firstAt: new Date(p.firstAt),
            lastAt,
            count: p.count,
            resolvedAt: p.resolvedAt ? new Date(p.resolvedAt) : null,
            updatedAt,
          },
        },
        { upsert: true },
      );
    } catch (error) {
      // A newer version is stored: the filter missed it and the upsert hit the unique key.
      if (!isDuplicateKey(error)) throw error;
    }
  }
}

export async function listProblems(owner: Owner): Promise<MachineProblem[]> {
  const docs = await problems().find({ owner }).sort({ lastAt: -1 }).limit(LISTED).toArray();
  return docs.map((d) => ({
    machine: d.machine,
    kind: d.kind,
    where: d.where,
    detail: d.detail,
    firstAt: d.firstAt.toISOString(),
    lastAt: d.lastAt.toISOString(),
    count: d.count,
    resolvedAt: d.resolvedAt?.toISOString(),
  }));
}
