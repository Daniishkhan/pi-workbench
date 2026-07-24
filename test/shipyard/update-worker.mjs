import { updateFinding } from "../../extensions/shipyard/findings-store.ts";

const [store, id, summary, expected] = process.argv.slice(2);
try {
  const finding = await updateFinding(store, id, { summary }, Number(expected));
  process.stdout.write(JSON.stringify({ ok: true, revision: finding.revision, summary: finding.summary }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 2;
}
