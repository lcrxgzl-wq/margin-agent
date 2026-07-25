import { describe, expect, it } from "vitest";
import {
  MAX_CLARIFICATION_ROUNDS,
  buildClarificationHint,
  isEditOrRewriteIntent,
  nextClarificationRound,
} from "./clarification.js";

describe("clarification budget", () => {
  it("detects rewrite/edit intents", () => {
    expect(isEditOrRewriteIntent("把这段写得更学术一点")).toBe(true);
    expect(isEditOrRewriteIntent("重写选区")).toBe(true);
    expect(isEditOrRewriteIntent("打开样章")).toBe(false);
    expect(isEditOrRewriteIntent("你好")).toBe(false);
  });

  it("advances up to three rounds then stays capped", () => {
    let round = 0;
    round = nextClarificationRound({
      previous: round,
      message: "改得更好一点",
      proposalCount: 0,
    });
    expect(round).toBe(1);
    round = nextClarificationRound({
      previous: round,
      message: "偏论证结构",
      proposalCount: 0,
    });
    expect(round).toBe(2);
    round = nextClarificationRound({
      previous: round,
      message: "因果更清楚",
      proposalCount: 0,
    });
    expect(round).toBe(3);
    round = nextClarificationRound({
      previous: round,
      message: "再问一下",
      proposalCount: 0,
    });
    expect(round).toBe(MAX_CLARIFICATION_ROUNDS);
  });

  it("resets when proposals land", () => {
    expect(
      nextClarificationRound({
        previous: 2,
        message: "按这个改",
        proposalCount: 1,
      }),
    ).toBe(0);
  });

  it("forces propose wording when budget exhausted", () => {
    const hint = buildClarificationHint({ clarificationRound: 3 });
    expect(hint).toContain("澄清预算已用尽");
    expect(hint).toContain("禁止再追问");
    expect(hint).toContain("propose_*");
  });

  it("allows ask-first wording while budget remains", () => {
    const hint = buildClarificationHint({ clarificationRound: 1, chatMode: "direct" });
    expect(hint).toContain("1/3");
    expect(hint).toContain("协作澄清");
    expect(hint).not.toContain("已用尽");
  });
});
