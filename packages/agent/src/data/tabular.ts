import { createHash, randomUUID } from "node:crypto";

export type ColumnType = "string" | "integer" | "number" | "boolean" | "date";

export type TabularColumn = {
  name: string;
  inferredType: ColumnType;
  nullCount: number;
};

export type FilterOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains";

export type FilterExpr = {
  column: string;
  op: FilterOp;
  value: string | number | boolean;
};

export type AggregateOp =
  | "count"
  | "sum"
  | "mean"
  | "median"
  | "min"
  | "max"
  | "stddev"
  | "nunique"
  | "percent";

export type AggregateSpec = {
  id: string;
  op: AggregateOp;
  column?: string;
};

export type AnalysisPlan = {
  filters?: FilterExpr[];
  groupBy?: string[];
  aggregates: AggregateSpec[];
  sort?: Array<{ column: string; direction: "asc" | "desc" }>;
};

export type AnalysisProvenance = {
  inputHash: string;
  path: string;
  normalizedPlanHash: string;
  engine: string;
  engineVersion: string;
  rowCountIn: number;
  rowCountUsed: number;
  durationMs: number;
};

export type ResultSet = {
  id: string;
  columns: Array<{ name: string; type: string }>;
  rows: unknown[][];
};

export type AnalysisRun = {
  runId: string;
  status: "completed";
  datasetRef: string;
  resultSets: ResultSet[];
  provenance: AnalysisProvenance;
  warnings: string[];
};

export type DatasetHandle = {
  datasetRef: string;
  path: string;
  inputHash: string;
  bytes: number;
  rowCount: number;
  columns: TabularColumn[];
  sample: unknown[][];
  warnings: string[];
  /** Internal rows (header excluded). */
  _rows: Record<string, unknown>[];
};

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Minimal RFC4180-ish CSV parse (comma, quotes, CRLF). */
export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  while (i < normalized.length) {
    const ch = normalized[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      field = "";
      if (row.some((c) => c.length > 0) || row.length > 1) rows.push(row);
      row = [];
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  row.push(field);
  if (row.some((c) => c.length > 0) || row.length > 1) rows.push(row);
  if (!rows.length) return { headers: [], rows: [] };
  const headers = rows[0]!.map((h, idx) => (h.trim() ? h.trim() : `col_${idx + 1}`));
  const body = rows.slice(1).map((r) => {
    const padded = [...r];
    while (padded.length < headers.length) padded.push("");
    return padded.slice(0, headers.length);
  });
  return { headers, rows: body };
}

function inferType(values: string[]): ColumnType {
  let nullCount = 0;
  let intOk = 0;
  let numOk = 0;
  let boolOk = 0;
  for (const raw of values) {
    const v = raw.trim();
    if (!v) {
      nullCount += 1;
      continue;
    }
    if (/^(true|false|是|否)$/i.test(v)) {
      boolOk += 1;
      continue;
    }
    if (/^[+-]?\d+$/.test(v)) {
      intOk += 1;
      numOk += 1;
      continue;
    }
    if (/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(v)) {
      numOk += 1;
      continue;
    }
  }
  const nonNull = values.length - nullCount;
  if (nonNull === 0) return "string";
  if (boolOk === nonNull) return "boolean";
  if (intOk === nonNull) return "integer";
  if (numOk === nonNull) return "number";
  return "string";
}

function coerce(value: string, type: ColumnType): unknown {
  const v = value.trim();
  if (!v) return null;
  if (type === "boolean") {
    if (/^(true|是|1)$/i.test(v)) return true;
    if (/^(false|否|0)$/i.test(v)) return false;
    return null;
  }
  if (type === "integer") {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  if (type === "number") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return v;
}

export function inspectCsv(
  relativePath: string,
  text: string,
  sampleRows = 20,
): DatasetHandle {
  if (text.length > 50 * 1024 * 1024) {
    throw new Error("CSV too large (max 50MB)");
  }
  const { headers, rows } = parseCsv(text);
  if (!headers.length) throw new Error("CSV has no header row");
  if (rows.length > 1_000_000) throw new Error("CSV too many rows (max 1e6)");

  const warnings: string[] = [];
  const columns: TabularColumn[] = headers.map((name, colIdx) => {
    const values = rows.map((r) => r[colIdx] ?? "");
    const inferredType = inferType(values);
    const nullCount = values.filter((v) => !v.trim()).length;
    return { name, inferredType, nullCount };
  });

  const objects = rows.map((r) => {
    const obj: Record<string, unknown> = {};
    headers.forEach((h, idx) => {
      obj[h] = coerce(r[idx] ?? "", columns[idx]!.inferredType);
    });
    return obj;
  });

  const sampleLimit = Math.max(1, Math.min(sampleRows, 100));
  const sample = objects.slice(0, sampleLimit).map((obj) => headers.map((h) => obj[h]));

  if (columns.some((c) => c.nullCount > 0)) {
    warnings.push("Some cells are empty; aggregates may drop nulls depending on missing policy.");
  }

  const inputHash = hashText(text);
  return {
    datasetRef: `ds_${inputHash.slice(0, 12)}`,
    path: relativePath.replace(/\\/g, "/"),
    inputHash,
    bytes: Buffer.byteLength(text, "utf8"),
    rowCount: objects.length,
    columns,
    sample,
    warnings,
    _rows: objects,
  };
}

function cmp(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "zh");
}

function passFilter(row: Record<string, unknown>, f: FilterExpr): boolean {
  const left = row[f.column];
  const right = f.value;
  switch (f.op) {
    case "eq":
      return left === right || String(left) === String(right);
    case "neq":
      return !(left === right || String(left) === String(right));
    case "gt":
      return cmp(left, right) > 0;
    case "gte":
      return cmp(left, right) >= 0;
    case "lt":
      return cmp(left, right) < 0;
    case "lte":
      return cmp(left, right) <= 0;
    case "contains":
      return String(left ?? "").includes(String(right));
    default:
      return false;
  }
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function stddev(nums: number[]): number | null {
  if (nums.length < 2) return null;
  const m = nums.reduce((a, b) => a + b, 0) / nums.length;
  const v = nums.reduce((a, b) => a + (b - m) ** 2, 0) / (nums.length - 1);
  return Math.sqrt(v);
}

function aggregate(
  rows: Record<string, unknown>[],
  spec: AggregateSpec,
  totalRows: number,
  missing: "drop" | "keep" | "error",
): unknown {
  if (spec.op === "count") return rows.length;
  if (spec.op === "percent") {
    return totalRows === 0 ? null : (rows.length / totalRows) * 100;
  }
  const col = spec.column;
  if (!col) throw new Error(`Aggregate ${spec.id} requires column`);
  const values = rows.map((r) => r[col]);
  if (missing === "error" && values.some((v) => v === null || v === undefined)) {
    throw new Error(`Null values in column ${col}`);
  }
  const usable =
    missing === "keep" ? values : values.filter((v) => v !== null && v !== undefined);
  if (spec.op === "nunique") {
    return new Set(usable.map((v) => JSON.stringify(v))).size;
  }
  const nums = usable
    .map((v) => (typeof v === "number" ? v : Number(v)))
    .filter((n) => Number.isFinite(n));
  switch (spec.op) {
    case "sum":
      return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
    case "mean":
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
    case "median":
      return median(nums);
    case "min":
      return nums.length
        ? nums.reduce((minimum, value) => (value < minimum ? value : minimum))
        : null;
    case "max":
      return nums.length
        ? nums.reduce((maximum, value) => (value > maximum ? value : maximum))
        : null;
    case "stddev":
      return stddev(nums);
    default:
      throw new Error(`Unknown aggregate op: ${spec.op}`);
  }
}

export function runAnalysis(
  dataset: DatasetHandle,
  plan: AnalysisPlan,
  options?: { missing?: "drop" | "keep" | "error" },
): AnalysisRun {
  const started = Date.now();
  const missing = options?.missing ?? "drop";
  if (!plan.aggregates?.length) throw new Error("plan.aggregates required");

  const columnNames = new Set(dataset.columns.map((column) => column.name));
  for (const f of plan.filters ?? []) {
    if (!columnNames.has(f.column)) {
      throw new Error(`Unknown filter column: ${f.column}`);
    }
  }

  const groupBy = plan.groupBy ?? [];
  const outputColumnNames = new Set<string>();
  for (const g of groupBy) {
    if (!columnNames.has(g)) {
      throw new Error(`Unknown groupBy column: ${g}`);
    }
    if (outputColumnNames.has(g)) {
      throw new Error(`Duplicate groupBy column: ${g}`);
    }
    outputColumnNames.add(g);
  }

  const aggregateIds = new Set<string>();
  for (const aggregateSpec of plan.aggregates) {
    if (aggregateIds.has(aggregateSpec.id)) {
      throw new Error(`Duplicate aggregate id: ${aggregateSpec.id}`);
    }
    if (outputColumnNames.has(aggregateSpec.id)) {
      throw new Error(`Aggregate id conflicts with groupBy column: ${aggregateSpec.id}`);
    }
    aggregateIds.add(aggregateSpec.id);
    outputColumnNames.add(aggregateSpec.id);

    if (aggregateSpec.column !== undefined && !columnNames.has(aggregateSpec.column)) {
      throw new Error(`Unknown aggregate column: ${aggregateSpec.column}`);
    }
    if (
      aggregateSpec.column === undefined &&
      aggregateSpec.op !== "count" &&
      aggregateSpec.op !== "percent"
    ) {
      throw new Error(`Aggregate ${aggregateSpec.id} requires column`);
    }
  }

  let rows = dataset._rows;
  for (const f of plan.filters ?? []) {
    rows = rows.filter((r) => passFilter(r, f));
  }

  const maxResultRows = 10_000;
  const groups = new Map<string, Record<string, unknown>[]>();
  if (!groupBy.length) {
    groups.set("", rows);
  } else {
    for (const row of rows) {
      const key = JSON.stringify(groupBy.map((g) => row[g]));
      let bucket = groups.get(key);
      if (bucket === undefined) {
        if (groups.size >= maxResultRows) {
          throw new Error("Result too large (max 10000 rows)");
        }
        bucket = [];
        groups.set(key, bucket);
      }
      bucket.push(row);
    }
  }

  const outColumns = [
    ...groupBy.map((name) => ({ name, type: "string" })),
    ...plan.aggregates.map((a) => ({ name: a.id, type: "number" })),
  ];
  const outRows: unknown[][] = [];
  for (const [, bucket] of groups) {
    const sample = bucket[0] ?? {};
    const cells: unknown[] = groupBy.map((g) => sample[g] ?? null);
    for (const agg of plan.aggregates) {
      cells.push(aggregate(bucket, agg, dataset._rows.length, missing));
    }
    outRows.push(cells);
  }

  if (plan.sort?.length) {
    const colIndex = new Map(outColumns.map((c, i) => [c.name, i]));
    outRows.sort((a, b) => {
      for (const s of plan.sort!) {
        const idx = colIndex.get(s.column);
        if (idx === undefined) continue;
        const c = cmp(a[idx], b[idx]);
        if (c !== 0) return s.direction === "desc" ? -c : c;
      }
      return 0;
    });
  }

  if (outRows.length > maxResultRows) {
    throw new Error("Result too large (max 10000 rows)");
  }

  const normalizedPlanHash = hashText(JSON.stringify(plan));
  const runId = randomUUID().replace(/-/g, "").slice(0, 16);
  return {
    runId,
    status: "completed",
    datasetRef: dataset.datasetRef,
    resultSets: [
      {
        id: "summary",
        columns: outColumns,
        rows: outRows,
      },
    ],
    provenance: {
      inputHash: dataset.inputHash,
      path: dataset.path,
      normalizedPlanHash,
      engine: "margin-tabular",
      engineVersion: "1",
      rowCountIn: dataset.rowCount,
      rowCountUsed: rows.length,
      durationMs: Date.now() - started,
    },
    warnings: dataset.warnings,
  };
}

export function parseResultRef(ref: string): {
  runId: string;
  resultSetId: string;
  row: number;
  column: string;
} {
  const m = /^run:([^/]+)\/result:([^/]+)\/row:(\d+)\/column:(.+)$/.exec(ref);
  if (!m) throw new Error(`Invalid resultRef: ${ref}`);
  return {
    runId: m[1]!,
    resultSetId: m[2]!,
    row: Number(m[3]),
    column: m[4]!,
  };
}

export function formatResultValue(
  value: unknown,
  format?: { decimals?: number; percent?: boolean; thousandsSeparator?: boolean },
): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
  let n = value;
  if (format?.percent) n = n; // already percent if op=percent
  const decimals = format?.decimals;
  let s =
    decimals === undefined ? String(n) : n.toFixed(Math.max(0, Math.min(8, decimals)));
  if (format?.thousandsSeparator) {
    const [intPart, frac] = s.split(".");
    const withSep = intPart!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    s = frac !== undefined ? `${withSep}.${frac}` : withSep;
  }
  if (format?.percent) s = `${s}%`;
  return s;
}

export function resultRefFor(
  runId: string,
  resultSetId: string,
  row: number,
  column: string,
): string {
  return `run:${runId}/result:${resultSetId}/row:${row}/column:${column}`;
}
