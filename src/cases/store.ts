import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const CONFIDENCE = ["established", "high", "medium", "low", "supplied"] as const;
export type Confidence = (typeof CONFIDENCE)[number];

export interface CaseLabel {
  label: string;
  confidence: Confidence;
  evidence: string[];
  addedAt: string;
}

export interface CaseNote {
  at: string;
  text: string;
  addresses: string[];
  signatures: string[];
}

export interface CaseArtifact {
  id: string;
  kind: "trace" | "cluster" | "bridge";
  at: string;
  title: string;
  data: unknown;
}

export interface CaseFile {
  name: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
  labels: Record<string, CaseLabel>;
  notes: CaseNote[];
  artifacts: CaseArtifact[];
}

let root: string | null = null;
let labelIndex: Map<string, { caseName: string; label: string; updatedAt: string }> | null = null;

export function initCases(dir: string): void {
  root = dir;
  labelIndex = null;
}

export function casesRoot(): string {
  if (!root) throw new Error("Case store is not initialised");
  return root;
}

export function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!slug) throw new Error(`"${name}" is not a usable case name`);
  return slug;
}

export function caseDir(name: string): string {
  return join(casesRoot(), slugify(name));
}

export function loadCase(name: string): CaseFile | null {
  const file = join(caseDir(name), "case.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as CaseFile;
}

export function updateCase(name: string, mutate: (c: CaseFile) => void): CaseFile {
  const now = new Date().toISOString();
  const current = loadCase(name) ?? {
    name: slugify(name),
    summary: "",
    createdAt: now,
    updatedAt: now,
    labels: {},
    notes: [],
    artifacts: [],
  };
  mutate(current);
  current.updatedAt = now;

  const dir = caseDir(name);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.case.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(current, null, 2));
  renameSync(tmp, join(dir, "case.json"));
  labelIndex = null;
  return current;
}

export function saveArtifact(
  name: string,
  kind: CaseArtifact["kind"],
  title: string,
  data: unknown,
): { case: string; artifactId: string } {
  const id = `${kind}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const saved = updateCase(name, (c) => {
    c.artifacts.push({ id, kind, at: new Date().toISOString(), title, data });
  });
  return { case: saved.name, artifactId: id };
}

export function listCases(): CaseFile[] {
  if (!root || !existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      try {
        return loadCase(entry.name);
      } catch {
        return null;
      }
    })
    .filter((c): c is CaseFile => c !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function caseLabelOf(address: string): string | undefined {
  if (!root) return undefined;
  if (!labelIndex) {
    labelIndex = new Map();
    for (const c of listCases()) {
      for (const [addr, entry] of Object.entries(c.labels)) {
        const existing = labelIndex.get(addr);
        if (!existing || existing.updatedAt < c.updatedAt) {
          labelIndex.set(addr, { caseName: c.name, label: entry.label, updatedAt: c.updatedAt });
        }
      }
    }
  }
  const hit = labelIndex.get(address);
  return hit ? `${hit.label} [case: ${hit.caseName}]` : undefined;
}

export function findAddress(address: string) {
  return listCases()
    .map((c) => ({
      case: c.name,
      label: c.labels[address] ?? null,
      notes: c.notes.filter((n) => n.addresses.includes(address) || n.text.includes(address)),
      artifacts: c.artifacts
        .filter((a) => JSON.stringify(a.data).includes(address))
        .map((a) => ({ id: a.id, kind: a.kind, title: a.title, at: a.at })),
    }))
    .filter((hit) => hit.label || hit.notes.length || hit.artifacts.length);
}
