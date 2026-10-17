import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  findAddress,
  initCases,
  listCases,
  loadCase,
  saveArtifact,
  slugify,
  updateCase,
} from "../src/cases/store.js";
import { cell, exportCase } from "../src/cases/export.js";
import { labelOf } from "../src/util/programs.js";

const ROOT = "Root111111111111111111111111111111111111111";
const SINK = "Sink111111111111111111111111111111111111111";
const BRIDGE_PDA = "BridgePda111111111111111111111111111111111";
const SOL = "So11111111111111111111111111111111111111111";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "coin-scout-cases-"));
  initCases(dir);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("case store", () => {
  it("slugifies names and rejects empty ones", () => {
    expect(slugify("Example Case #1!")).toBe("example-case-1");
    expect(() => slugify("!!!")).toThrow();
  });

  it("creates on first update and feeds labels into labelOf", () => {
    updateCase("Example Case", (c) => {
      c.summary = "Test summary";
      c.labels[SINK] = { label: "rent sink", confidence: "established", evidence: [], addedAt: "" };
      c.notes.push({
        at: "2026-08-13T00:00:00Z",
        text: `funded by ${ROOT}`,
        addresses: [],
        signatures: [],
      });
    });
    expect(loadCase("example-case")?.summary).toBe("Test summary");
    expect(labelOf(SINK)).toBe("rent sink [case: example-case]");
    expect(labelOf("11111111111111111111111111111111")).toBe("System Program");
    expect(listCases().map((c) => c.name)).toEqual(["example-case"]);
  });

  it("finds an address across labels, notes and saved artifacts", () => {
    saveArtifact("other-case", "cluster", "Cluster", { seed: SINK, members: [] });
    const hits = findAddress(SINK);
    expect(hits.map((h) => h.case).sort()).toEqual(["example-case", "other-case"]);
    expect(findAddress(ROOT)[0].notes).toHaveLength(1);
  });
});

describe("cell", () => {
  it("escapes backslashes before pipes so a label cannot break the table", () => {
    expect(cell("a\\|b\nc")).toBe("a\\\\\\|b c");
  });
});

describe("exportCase", () => {
  it("writes a report with a Mermaid block and an SVG per trace, including the bridge hop", () => {
    const { artifactId } = saveArtifact("example-case", "trace", "Funds leaving root", {
      root: ROOT,
      direction: "out",
      hopsRequested: 2,
      totalUsdAtTime: 1234.5,
      nodes: [
        { address: ROOT, label: null, sent: 10, received: 0, outEdges: 2, inEdges: 0 },
        {
          address: SINK,
          label: "rent sink [case: example-case]",
          sent: 0,
          received: 6,
          outEdges: 0,
          inEdges: 1,
        },
        { address: BRIDGE_PDA, label: null, sent: 0, received: 4, outEdges: 0, inEdges: 1 },
      ],
      edges: [
        {
          from: ROOT,
          to: SINK,
          mint: SOL,
          amount: 6,
          usdAtTime: 900,
          transfers: 1,
          sampleSig: "s1",
        },
        {
          from: ROOT,
          to: BRIDGE_PDA,
          mint: SOL,
          amount: 4,
          usdAtTime: 334.5,
          transfers: 1,
          sampleSig: "s2",
        },
      ],
      terminals: [],
      bridgeCrossings: [
        {
          bridge: "debridge",
          signature: "s2",
          direction: "out",
          status: "Fulfilled",
          fromChain: "Solana",
          fromAddress: ROOT,
          toChain: "Base",
          toAddress: "0xabc0000000000000000000000000000000000def",
          sent: { token: "SOL", amount: 4 },
          received: null,
          usd: null,
          sourceTx: "s2",
          destinationTx: "0xdest",
          explorer: "https://app.debridge.finance/order?orderId=0x1",
          via: { from: ROOT, to: BRIDGE_PDA, mint: SOL, amount: 4 },
        },
      ],
    });

    const result = exportCase(loadCase("example-case")!);
    const report = readFileSync(result.report, "utf8");
    expect(report).toContain("```mermaid");
    expect(report).toContain(`| \`${SINK}\` | rent sink | established |`);
    expect(report).toContain("Solana → Base");
    expect(report).toContain("$1,234.5");

    const svgPath = join(dir, "example-case", `${artifactId}.svg`);
    expect(result.diagrams).toContain(svgPath);
    const svg = readFileSync(svgPath, "utf8");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("debridge → Base");
    expect(svg).toContain("rent sink");
    expect(svg).toContain("6 SOL · $900");
    expect(existsSync(join(dir, "example-case", "case.json"))).toBe(true);
  });
});
