import { describe, expect, it } from "vitest";
import { withPathsToRoot, type FlowEdge } from "../src/analysis/flow.js";

function edge(from: string, to: string, amount: number, hop: number): FlowEdge {
  return {
    from,
    to,
    mint: "m",
    amount,
    transfers: 1,
    firstTs: 0,
    lastTs: 0,
    hop,
    sampleSig: `${from}${to}`,
    maxSig: `${from}${to}`,
    maxAmount: amount,
    samples: [],
    usdAtTime: null,
  };
}

describe("withPathsToRoot", () => {
  it("keeps the chain that connects a big deep edge back to the root", () => {
    const ranked = [
      edge("B", "C", 100, 3),
      edge("A", "B", 2, 2),
      edge("R", "A", 1, 1),
      edge("R", "X", 1.5, 1),
    ];
    const shown = withPathsToRoot(ranked, 1, "R", true);
    expect(shown.map((e) => `${e.from}>${e.to}`)).toEqual(["B>C", "A>B", "R>A"]);
  });

  it("walks toward the root along incoming flows for backward traces", () => {
    const ranked = [edge("C", "B", 100, 2), edge("B", "R", 1, 1)];
    const shown = withPathsToRoot(ranked, 1, "R", false);
    expect(shown).toHaveLength(2);
  });
});
