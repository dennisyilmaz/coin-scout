import { join } from "node:path";
import { z } from "zod";
import { assertPubkey, assertSignature } from "../util/base58.js";
import { json } from "../util/format.js";
import {
  CONFIDENCE,
  caseDir,
  casesRoot,
  findAddress,
  listCases,
  loadCase,
  updateCase,
} from "../cases/store.js";
import { exportCase } from "../cases/export.js";
import { READ_ONLY, safe, type ToolContext } from "./common.js";

const Address = z.string().describe("Base58 Solana address");
const CaseName = z.string().describe("Case name, e.g. exchange-hack-2026");
const LOCAL_WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export function registerCaseTools({ server }: ToolContext): void {
  server.registerTool(
    "case_update",
    {
      title: "Update case file",
      description:
        "Create a case or add to it: summary, address labels with confidence and evidence signatures, and dated notes (findings, leads, retractions). Labels are shown by every other tool from then on, across sessions and cases.",
      inputSchema: z.object({
        case: CaseName.describe("Case name; created if it does not exist"),
        summary: z.string().optional().describe("Replace the case summary"),
        labels: z
          .array(
            z.object({
              address: Address,
              label: z.string().describe("Role, e.g. 'exploiter wallet', 'cash-out address'"),
              confidence: z.enum(CONFIDENCE).default("medium"),
              evidence: z.array(z.string()).max(10).default([]).describe("Supporting signatures"),
            }),
          )
          .max(50)
          .optional(),
        removeLabels: z.array(Address).max(50).optional(),
        note: z.string().optional().describe("Finding, lead or retraction to append"),
        noteAddresses: z.array(Address).max(20).default([]),
        noteSignatures: z.array(z.string()).max(20).default([]),
      }),
      annotations: LOCAL_WRITE,
    },
    safe(async (args) => {
      args.labels?.forEach((l) => {
        assertPubkey(l.address);
        l.evidence.forEach((sig) => assertSignature(sig));
      });
      args.removeLabels?.forEach((a) => assertPubkey(a));
      args.noteAddresses.forEach((a) => assertPubkey(a));
      args.noteSignatures.forEach((s) => assertSignature(s));

      const now = new Date().toISOString();
      const saved = updateCase(args.case, (c) => {
        if (args.summary !== undefined) c.summary = args.summary;
        for (const l of args.labels ?? []) {
          c.labels[l.address] = {
            label: l.label,
            confidence: l.confidence,
            evidence: l.evidence,
            addedAt: now,
          };
        }
        for (const address of args.removeLabels ?? []) delete c.labels[address];
        if (args.note) {
          c.notes.push({
            at: now,
            text: args.note,
            addresses: args.noteAddresses,
            signatures: args.noteSignatures,
          });
        }
      });
      return json({
        case: saved.name,
        file: join(caseDir(saved.name), "case.json"),
        labels: Object.keys(saved.labels).length,
        notes: saved.notes.length,
        artifacts: saved.artifacts.length,
        updatedAt: saved.updatedAt,
      });
    }),
  );

  server.registerTool(
    "case_read",
    {
      title: "Read case files",
      description:
        "With no arguments, list every case. With address, search all cases for prior labels, notes and saved traces mentioning it — do this before starting on any address. With case, return that case's labels, notes and an index of saved artifacts; add artifactId to get one saved trace, cluster or bridge result in full.",
      inputSchema: z.object({
        case: CaseName.optional(),
        address: Address.optional(),
        artifactId: z.string().optional(),
      }),
      annotations: { ...READ_ONLY, openWorldHint: false },
    },
    safe(async ({ case: name, address, artifactId }) => {
      if (address) {
        assertPubkey(address);
        const hits = findAddress(address).filter((hit) => !name || hit.case === name);
        return json({ address, cases: hits.length, hits });
      }

      if (!name) {
        return json({
          casesDir: casesRoot(),
          cases: listCases().map((c) => ({
            name: c.name,
            summary: c.summary.slice(0, 240),
            labels: Object.keys(c.labels).length,
            notes: c.notes.length,
            artifacts: c.artifacts.length,
            updatedAt: c.updatedAt,
          })),
        });
      }

      const c = loadCase(name);
      if (!c) throw new Error(`No case named ${name}. case_read with no arguments lists cases.`);
      if (artifactId) {
        const artifact = c.artifacts.find((a) => a.id === artifactId);
        if (!artifact) throw new Error(`No artifact ${artifactId} in case ${c.name}`);
        return json(artifact);
      }
      return json({
        ...c,
        artifacts: c.artifacts.map((a) => ({ id: a.id, kind: a.kind, title: a.title, at: a.at })),
      });
    }),
  );

  server.registerTool(
    "case_export",
    {
      title: "Export case report",
      description:
        "Write the case to disk as report.md (labels, notes, tables, Mermaid diagrams) plus one standalone SVG fund-flow diagram per saved trace or cluster, ready to drop into a report. Returns the file paths.",
      inputSchema: z.object({
        case: CaseName,
        artifactId: z.string().optional().describe("Export only this artifact"),
      }),
      annotations: { ...LOCAL_WRITE, idempotentHint: true },
    },
    safe(async ({ case: name, artifactId }) => {
      const c = loadCase(name);
      if (!c) throw new Error(`No case named ${name}`);
      return json(exportCase(c, artifactId));
    }),
  );
}
