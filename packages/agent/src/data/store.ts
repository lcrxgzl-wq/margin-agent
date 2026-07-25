import type {
  AnalysisRun,
  DatasetHandle,
} from "./tabular.js";
import { parseResultRef } from "./tabular.js";

/** In-memory analysis artifacts for one agent turn / session bag. */
export class AnalysisRunStore {
  datasets = new Map<string, DatasetHandle>();
  runs = new Map<string, AnalysisRun>();

  putDataset(ds: DatasetHandle): void {
    this.datasets.set(ds.datasetRef, ds);
    // Also index by path for convenience
    this.datasets.set(`path:${ds.path}`, ds);
  }

  getDataset(refOrPath: string): DatasetHandle {
    const byRef = this.datasets.get(refOrPath);
    if (byRef) return byRef;
    const byPath = this.datasets.get(`path:${refOrPath.replace(/\\/g, "/")}`);
    if (byPath) return byPath;
    throw new Error(`Unknown datasetRef: ${refOrPath}. Call inspect_tabular_file first.`);
  }

  putRun(run: AnalysisRun): void {
    this.runs.set(run.runId, run);
  }

  getRun(runId: string): AnalysisRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown runId: ${runId}`);
    return run;
  }

  resolveValue(resultRef: string): { value: unknown; run: AnalysisRun } {
    const parsed = parseResultRef(resultRef);
    const run = this.getRun(parsed.runId);
    const rs = run.resultSets.find((r) => r.id === parsed.resultSetId);
    if (!rs) throw new Error(`Unknown resultSetId: ${parsed.resultSetId}`);
    if (parsed.row < 0 || parsed.row >= rs.rows.length) {
      throw new Error(`Row out of range: ${parsed.row}`);
    }
    const colIdx = rs.columns.findIndex((c) => c.name === parsed.column);
    if (colIdx < 0) throw new Error(`Unknown column: ${parsed.column}`);
    return { value: rs.rows[parsed.row]![colIdx], run };
  }
}
