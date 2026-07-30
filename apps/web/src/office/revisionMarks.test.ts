import type { IElement } from "@hufe921/canvas-editor";
import { describe, expect, it } from "vitest";
import type { Block, Proposal } from "../api";
import {
  ANCHOR_CONTEXT,
  MARK_DELETE_COLOR,
  MARK_EXTENSION_ATTR,
  MARK_INSERT_COLOR,
  buildAnchor,
  buildMarkSpans,
  buildSaveConfirmMessage,
  canInjectMark,
  countPendingProposals,
  duplicateBlockOrdinal,
  locateMarkRun,
  markAnchor,
  markBaseStyle,
  markKey,
  markProposalId,
  planInjectionOrder,
  planMarkRestoreOrder,
  proposalFocusQueries,
  proposalsToReinjectAfterSave,
  selectionContainsMark,
  sliceElements,
  stripMarks,
} from "./revisionMarks";

function makeProposal(overrides: Partial<Proposal>): Proposal {
  return {
    id: "prop-1",
    documentId: "doc-1",
    blockId: "p-1",
    baseRevision: 1,
    before: "原文段落内容",
    after: "原文修订内容",
    rationale: "",
    risk: "low",
    status: "proposed",
    baseHash: "hash",
    ...overrides,
  };
}

const blocks: Block[] = [
  { id: "p-1", kind: "paragraph", text: "原文段落内容", order: 0, contentHash: "a" },
  { id: "t-1", kind: "table", text: "表头\t表体", order: 1, contentHash: "b" },
  { id: "p-2", kind: "paragraph", text: "原文段落内容", order: 2, contentHash: "c" },
];

describe("markKey", () => {
  it("拼接 before/after 片段作为定位串", () => {
    expect(markKey("旧", "新")).toBe("旧新");
    expect(markKey("", "纯插入")).toBe("纯插入");
    expect(markKey("纯删除", "")).toBe("纯删除");
  });
});

describe("proposalFocusQueries", () => {
  it("prioritizes the live marked fragment before the now-discontinuous original block", () => {
    const proposal = makeProposal({
      before: "前文旧词后文",
      after: "前文新词后文",
    });
    expect(proposalFocusQueries(proposal)).toEqual([
      "前文旧新",
      "前文旧词后文",
    ]);
  });

  it("keeps table-cell focus on the cell text", () => {
    const proposal = makeProposal({
      before: "单元格",
      after: "新单元格",
      tableCell: { address: "A1", row: 1, column: 1, before: "单元格", after: "新单元格" },
    });
    expect(proposalFocusQueries(proposal)).toEqual(["单元格"]);
  });
});

describe("buildMarkSpans", () => {
  const base = { font: "宋体", size: 14, bold: true };

  it("替换：del（删除线+灰）在前、ins（下划线+主题色）在后，均带 marginMark", () => {
    const spans = buildMarkSpans(base, "旧文", "新文", "prop-9");
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({
      value: "旧文",
      strikeout: true,
      color: MARK_DELETE_COLOR,
      font: "宋体",
      size: 14,
      bold: true,
      extension: { [MARK_EXTENSION_ATTR]: "prop-9" },
    });
    expect(spans[1]).toMatchObject({
      value: "新文",
      underline: true,
      strikeout: false,
      color: MARK_INSERT_COLOR,
      font: "宋体",
      extension: { [MARK_EXTENSION_ATTR]: "prop-9" },
    });
  });

  it("纯插入只产 ins span", () => {
    const spans = buildMarkSpans(base, "", "新增", "p");
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ value: "新增", underline: true });
  });

  it("纯删除只产 del span", () => {
    const spans = buildMarkSpans(base, "删掉", "", "p");
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ value: "删掉", strikeout: true });
  });

  it("两个片段都为空时不产 span", () => {
    expect(buildMarkSpans(base, "", "", "p")).toHaveLength(0);
  });
});

describe("markBaseStyle / markProposalId", () => {
  it("只提取可继承的排版属性", () => {
    const element: IElement = {
      value: "x",
      font: "Times New Roman",
      size: 16,
      bold: false,
      color: "#ff0000",
      strikeout: true,
      extension: { marginMark: "p-1" },
    };
    expect(markBaseStyle(element)).toEqual({ font: "Times New Roman", size: 16, bold: false });
    expect(markBaseStyle(undefined)).toEqual({});
  });

  it("读取 extension 上的提案 id，非字符串/缺失返回 null", () => {
    expect(markProposalId({ value: "a", extension: { marginMark: "p-1" } })).toBe("p-1");
    expect(markProposalId({ value: "a" })).toBeNull();
    expect(markProposalId({ value: "a", extension: { marginMark: 7 } })).toBeNull();
    expect(markProposalId({ value: "a", extension: "other" })).toBeNull();
  });

  it("用 extension 区分重复文本中真正带标记的选区", () => {
    const plain: IElement[] = [{ value: "重复文本" }];
    const marked: IElement[] = [{ value: "重复文本", extension: { marginMark: "p-1" } }];
    expect(selectionContainsMark(plain, "p-1")).toBe(false);
    expect(selectionContainsMark(marked, "p-1")).toBe(true);
    expect(selectionContainsMark(marked, "p-2")).toBe(false);
  });
});

describe("stripMarks", () => {
  const plainA: IElement = { value: "A", font: "宋体" };
  const plainB: IElement = { value: "B" };
  const del: IElement = {
    value: "旧",
    strikeout: true,
    color: MARK_DELETE_COLOR,
    extension: { marginMark: "p-1" },
  };
  const ins: IElement = {
    value: "新",
    underline: true,
    color: MARK_INSERT_COLOR,
    extension: { marginMark: "p-1" },
  };
  const snapshot: IElement[] = [{ value: "原", font: "宋体", size: 16 }];

  it("同 id 连续标记 spans 整体替换为快照原文（往返一致）", () => {
    const result = stripMarks([plainA, del, ins, plainB], new Map([["p-1", snapshot]]));
    expect(result).toEqual([plainA, ...snapshot, plainB]);
    expect(result.some((element) => markProposalId(element))).toBe(false);
  });

  it("多个提案的标记分别还原", () => {
    const other: IElement = { value: "乙", underline: true, extension: { marginMark: "p-2" } };
    const result = stripMarks([del, ins, plainA, other], {
      "p-1": snapshot,
      "p-2": [{ value: "甲" }],
    });
    expect(result).toEqual([...snapshot, plainA, { value: "甲" }]);
  });

  it("快照缺失时去掉标记样式与 extension、保留文本", () => {
    const result = stripMarks([del, ins], new Map());
    expect(result).toEqual([
      { value: "旧", strikeout: false, underline: false },
      { value: "新", strikeout: false, underline: false },
    ]);
  });

  it("无标记元素原样保留", () => {
    expect(stripMarks([plainA, plainB], new Map())).toEqual([plainA, plainB]);
  });
});

describe("canInjectMark", () => {
  it("普通块级提案可注入", () => {
    expect(canInjectMark(makeProposal({}), blocks)).toBe(true);
  });

  it("selection 提案（数据一致）可注入", () => {
    const proposal = makeProposal({
      operation: {
        kind: "polish",
        scope: "selection",
        selection: { start: 2, end: 4, before: "段落", after: "文字" },
      },
      after: "原文文字内容",
    });
    expect(canInjectMark(proposal, blocks)).toBe(true);
  });

  it("table_cell 提案跳过", () => {
    const proposal = makeProposal({
      blockId: "t-1",
      tableCell: { address: "A1", row: 1, column: 1, before: "表头", after: "新表头" },
      before: "表头",
      after: "新表头",
    });
    expect(canInjectMark(proposal, blocks)).toBe(false);
  });

  it("表格块与缺失块跳过", () => {
    expect(canInjectMark(makeProposal({ blockId: "t-1" }), blocks)).toBe(false);
    expect(canInjectMark(makeProposal({ blockId: "missing" }), blocks)).toBe(false);
  });

  it("含换行（跨块/多段）跳过", () => {
    expect(canInjectMark(makeProposal({ before: "第一段\n第二段", after: "第一段\n改后" }), blocks)).toBe(false);
  });

  it("数据不一致（proposalChange 抛错）跳过", () => {
    const proposal = makeProposal({
      operation: {
        kind: "rewrite",
        scope: "selection",
        selection: { start: 0, end: 2, before: "不一致", after: "x" },
      },
    });
    expect(canInjectMark(proposal, blocks)).toBe(false);
  });

  it("before/after 完全相同（无变更片段）跳过", () => {
    expect(canInjectMark(makeProposal({ after: "原文段落内容" }), blocks)).toBe(false);
  });

  it("提案 before 与当前块文本不一致（stale base）跳过", () => {
    expect(canInjectMark(makeProposal({ before: "旧版本段落", after: "旧版本改后" }), blocks)).toBe(false);
  });
});

describe("markAnchor", () => {
  it("block 级提案用公共前缀定位偏移", () => {
    const anchor = markAnchor(makeProposal({}));
    expect(anchor?.offset).toBe(2);
    expect(anchor?.change.beforeFragment).toBe("段落");
    expect(anchor?.change.afterFragment).toBe("修订");
  });

  it("selection 提案用 selection.start", () => {
    const anchor = markAnchor(makeProposal({
      operation: {
        kind: "polish",
        scope: "selection",
        selection: { start: 2, end: 4, before: "段落", after: "文字" },
      },
      after: "原文文字内容",
    }));
    expect(anchor?.offset).toBe(2);
    expect(anchor?.change.scope).toBe("selection");
  });

  it("table_cell 与不一致数据返回 null", () => {
    expect(markAnchor(makeProposal({
      tableCell: { address: "A1", row: 1, column: 1, before: "a", after: "b" },
    }))).toBeNull();
    expect(markAnchor(makeProposal({
      operation: { kind: "rewrite", scope: "selection", selection: { start: 9, end: 10, before: "z", after: "y" } },
    }))).toBeNull();
  });
});

describe("buildAnchor（片段级锚定）", () => {
  it("长段落中的片段：key 只含片段与前后各 20 字符上下文，区间按偏移换算", () => {
    const before = `${"甲".repeat(600)}旧词${"乙".repeat(600)}`;
    const after = `${"甲".repeat(600)}新句${"乙".repeat(600)}`;
    const anchor = markAnchor(makeProposal({ before, after }))!;
    expect(anchor.offset).toBe(600);
    const fragment = buildAnchor(before, anchor)!;
    expect(fragment.key).toBe(`${"甲".repeat(ANCHOR_CONTEXT)}旧词${"乙".repeat(ANCHOR_CONTEXT)}`);
    expect(fragment.keyStart).toBe(580);
    expect(fragment.replaceStart).toBe(600);
    expect(fragment.replaceEnd).toBe(602);
    expect(fragment.occurrence).toBe(0);
    expect(fragment.occurrences).toBe(1);
    expect(fragment.markText).toBe("旧词新句");
    expect(fragment.markedKey).toBe(`${"甲".repeat(ANCHOR_CONTEXT)}旧词新句`);
    expect(fragment.markedOffset).toBe(ANCHOR_CONTEXT);
  });

  it("注入后正文（上下文+del+ins+后上下文）中 markedKey 仍逐字命中且起点不变", () => {
    const before = `${"甲".repeat(600)}旧词${"乙".repeat(600)}`;
    const after = `${"甲".repeat(600)}新句${"乙".repeat(600)}`;
    const fragment = buildAnchor(before, markAnchor(makeProposal({ before, after }))!)!;
    const injected = `${"甲".repeat(600)}旧词新句${"乙".repeat(600)}`;
    expect(injected.indexOf(fragment.markedKey)).toBe(fragment.keyStart);
    // 注入前 key 含后上下文，注入后被 ins 截断而失效——故还原必须用 markedKey。
    expect(injected.includes(fragment.key)).toBe(false);
  });

  it("片段过长（整段改写）：key 只取片段头部，replaceEnd 落在 key 之外", () => {
    const before = `前缀${"长".repeat(100)}后缀`;
    const after = "前缀短后缀";
    const anchor = markAnchor(makeProposal({ before, after }))!;
    expect(anchor.change.beforeFragment).toBe("长".repeat(100));
    const fragment = buildAnchor(before, anchor)!;
    expect(fragment.key).toBe(`前缀${"长".repeat(ANCHOR_CONTEXT)}`);
    expect(fragment.keyStart).toBe(0);
    expect(fragment.replaceStart).toBe(2);
    expect(fragment.replaceEnd).toBe(102);
    expect(fragment.markedKey).toBe(`前缀${"长".repeat(ANCHOR_CONTEXT)}`);
    expect(fragment.markText).toBe(`${"长".repeat(100)}短`);
  });

  it("重复片段按块内第 N 次出现消歧（occurrence），occurrences 供块级 ordinal 换算", () => {
    const before = `${"A".repeat(20)}X${"A".repeat(40)}X${"A".repeat(20)}`;
    const second = buildAnchor(
      before,
      markAnchor(makeProposal({
        before,
        after: `${"A".repeat(20)}X${"A".repeat(40)}Y${"A".repeat(20)}`,
      }))!,
    )!;
    expect(second.replaceStart).toBe(61);
    expect(second.key).toBe(`${"A".repeat(20)}X${"A".repeat(20)}`);
    expect(second.occurrence).toBe(1);
    expect(second.occurrences).toBe(2);
    const first = buildAnchor(
      before,
      markAnchor(makeProposal({
        before,
        after: `${"A".repeat(20)}Y${"A".repeat(40)}X${"A".repeat(20)}`,
      }))!,
    )!;
    expect(first.replaceStart).toBe(20);
    expect(first.occurrence).toBe(0);
    expect(first.occurrences).toBe(2);
  });

  it("上下文不足（片段距段首/段尾 <20 字符）时退化为实际可用上下文", () => {
    const nearStart = buildAnchor(
      "短上下文X尾",
      markAnchor(makeProposal({ before: "短上下文X尾", after: "短上下文Y尾" }))!,
    )!;
    expect(nearStart.keyStart).toBe(0);
    expect(nearStart.key).toBe("短上下文X尾");
    expect(nearStart.markedKey).toBe("短上下文XY");
    const nearEnd = buildAnchor(
      "头X短上下文",
      markAnchor(makeProposal({ before: "头X短上下文", after: "头Y短上下文" }))!,
    )!;
    expect(nearEnd.key).toBe("头X短上下文");
    expect(nearEnd.replaceStart).toBe(1);
    expect(nearEnd.replaceEnd).toBe(2);
  });

  it("纯插入（beforeFragment 为空）用锚点前后文本定位插入点", () => {
    const before = "插入点之前插入点之后";
    const after = "插入点之前新增内容插入点之后";
    const anchor = markAnchor(makeProposal({ before, after }))!;
    expect(anchor.change.beforeFragment).toBe("");
    const fragment = buildAnchor(before, anchor)!;
    expect(fragment.key).toBe(before);
    expect(fragment.replaceStart).toBe(5);
    expect(fragment.replaceEnd).toBe(5);
    expect(fragment.markText).toBe("新增内容");
    expect(fragment.markedKey).toBe("插入点之前新增内容");
    expect(fragment.markedOffset).toBe(5);
    // 注入后正文 = 上文 + ins + 下文，markedKey 仍命中且起点不变。
    expect(after.indexOf(fragment.markedKey)).toBe(fragment.keyStart);
  });

  it("空块纯插入无锚点可用，返回 null（降级 rail）", () => {
    const anchor = markAnchor(makeProposal({ before: "", after: "新" }))!;
    expect(buildAnchor("", anchor)).toBeNull();
  });

  it("blockText 锚点处与 beforeFragment 不一致（stale base 片段级）返回 null", () => {
    const anchor = markAnchor(makeProposal({}))!;
    expect(anchor.change.beforeFragment).toBe("段落");
    expect(buildAnchor("已被改写的文本", anchor)).toBeNull();
  });
});

describe("duplicateBlockOrdinal", () => {
  it("重复文本块按 blockId 取序号", () => {
    expect(duplicateBlockOrdinal(blocks, "p-2", "原文段落内容")).toBe(1);
    expect(duplicateBlockOrdinal(blocks, "p-1", "原文段落内容")).toBe(0);
  });

  it("找不到 blockId 或空文本时退化为 0", () => {
    expect(duplicateBlockOrdinal(blocks, "missing", "原文段落内容")).toBe(0);
    expect(duplicateBlockOrdinal(blocks, "p-1", "")).toBe(0);
  });
});

describe("planInjectionOrder", () => {
  it("按块序降序、同块偏移降序，且过滤不可注入提案", () => {
    const late = makeProposal({ id: "late", blockId: "p-2" });
    const early = makeProposal({ id: "early", blockId: "p-1" });
    const skipped = makeProposal({
      id: "cell",
      blockId: "t-1",
      tableCell: { address: "A1", row: 1, column: 1, before: "表头", after: "新" },
      before: "表头",
      after: "新",
    });
    expect(planInjectionOrder([early, skipped, late], blocks).map((p) => p.id)).toEqual(["late", "early"]);
  });

  it("同块多提案按偏移降序", () => {
    const front = makeProposal({
      id: "front",
      before: "原文段落内容",
      after: "改写段落内容",
    });
    const back = makeProposal({
      id: "back",
      before: "原文段落内容",
      after: "原文段落改后",
    });
    expect(planInjectionOrder([front, back], blocks).map((p) => p.id)).toEqual(["back", "front"]);
  });
});

describe("sliceElements", () => {
  const elements: IElement[] = [
    { value: "ab", font: "宋体" },
    { value: "cd", size: 16 },
    { value: "\n" },
    { value: "ef" },
  ];

  it("按字符区间切片并拆分部分重叠元素", () => {
    expect(sliceElements(elements, 1, 4)).toEqual([
      { value: "b", font: "宋体" },
      { value: "cd", size: 16 },
    ]);
  });

  it("跨段落分隔符计数", () => {
    expect(sliceElements(elements, 4, 6)).toEqual([{ value: "\n" }, { value: "e" }]);
  });

  it("空区间返回空数组，且切片不带元素 id", () => {
    expect(sliceElements(elements, 2, 2)).toEqual([]);
    const withIds: IElement[] = [{ id: "el-1", value: "xyz" }];
    expect(sliceElements(withIds, 0, 2)).toEqual([{ value: "xy" }]);
  });
});

describe("planMarkRestoreOrder", () => {
  it("按块文档序倒序还原，避免还原改变长度影响后续定位", () => {
    const marks = new Map([
      ["early", { blockId: "p-1" }],
      ["late", { blockId: "p-2" }],
    ]);
    expect(planMarkRestoreOrder(marks, blocks)).toEqual(["late", "early"]);
  });

  it("同块保持插入序，未知块沉底最后还原", () => {
    const marks = new Map([
      ["first", { blockId: "p-1" }],
      ["unknown", { blockId: "missing" }],
      ["second", { blockId: "p-1" }],
    ]);
    expect(planMarkRestoreOrder(marks, blocks)).toEqual(["first", "second", "unknown"]);
  });
});

describe("locateMarkRun", () => {
  const del: IElement = {
    value: "旧",
    strikeout: true,
    extension: { marginMark: "p-1" },
  };
  const ins: IElement = {
    value: "新",
    underline: true,
    extension: { marginMark: "p-1" },
  };

  it("连续标记 spans 覆盖整段，前缀文本计入偏移", () => {
    expect(locateMarkRun([{ value: "前缀" }, del, ins, { value: "尾" }], "p-1"))
      .toEqual({ start: 2, end: 4 });
  });

  it("标记被用户输入切开时取首末之间整段（含缝隙）", () => {
    expect(locateMarkRun([del, { value: "夹" }, ins], "p-1")).toEqual({ start: 0, end: 3 });
  });

  it("无匹配标记返回 null，其他提案的标记不计入", () => {
    expect(locateMarkRun([{ value: "ab" }], "p-1")).toBeNull();
    expect(locateMarkRun([{ value: "乙", extension: { marginMark: "p-2" } }], "p-1")).toBeNull();
  });
});

describe("countPendingProposals / buildSaveConfirmMessage（保存前确认）", () => {
  it("proposed 与 pending 计入待审，其余状态不计", () => {
    const proposals = [
      makeProposal({ id: "a", status: "proposed" }),
      makeProposal({ id: "b", status: "pending" }),
      makeProposal({ id: "c", status: "accepted" }),
      makeProposal({ id: "d", status: "superseded" }),
      makeProposal({ id: "e", status: "rejected" }),
    ];
    expect(countPendingProposals(proposals)).toBe(2);
    expect(countPendingProposals([])).toBe(0);
  });

  it("确认文案包含待审数量", () => {
    expect(buildSaveConfirmMessage(3)).toContain("3");
    expect(buildSaveConfirmMessage(3)).toContain("待审提案");
  });

  it("保存成功后不重注入已被服务端关闭的旧提案，失败时才恢复未标记提案", () => {
    const proposals = [
      makeProposal({ id: "fresh", status: "proposed" }),
      makeProposal({ id: "marked", status: "proposed" }),
      makeProposal({ id: "closed", status: "superseded" }),
    ];
    expect(proposalsToReinjectAfterSave(proposals, new Set(["marked"]), true)).toEqual([]);
    expect(proposalsToReinjectAfterSave(proposals, new Set(["marked"]), false).map((p) => p.id))
      .toEqual(["fresh"]);
  });
});

describe("保存兜底：expandLeft 快照还原语义（stripMarks 不接线的回归锁定）", () => {
  it("纯插入标记按 [run.start - 1, run.end) 区间替换为快照，左邻字符不重复", () => {
    // 注入前正文 "AB"，纯插入提案在 B 后插入"新"：快照 = [B]（左扩 1 字符），
    // 注入后元素流 = A | B（克隆，无标记）| 新（ins，带标记）。
    const injected: IElement[] = [
      { value: "A", font: "宋体" },
      { value: "B", font: "宋体" },
      {
        value: "新",
        font: "宋体",
        underline: true,
        color: MARK_INSERT_COLOR,
        extension: { marginMark: "p-1" },
      },
    ];
    const run = locateMarkRun(injected, "p-1");
    expect(run).toEqual({ start: 2, end: 3 });
    const snapshot: IElement[] = [{ value: "B", font: "宋体" }];
    // restoreMark 语义：快照整体替换 [run.start - expandLeft, run.end)。
    const restored = [
      ...sliceElements(injected, 0, run!.start - 1),
      ...snapshot,
      ...sliceElements(injected, run!.end, run!.end),
    ];
    expect(restored.map((element) => element.value).join("")).toBe("AB");
    // 对照：stripMarks 只替换标记连续段，会把左扩字符再写一遍（"ABB"）——
    // 因此保存兜底走“全量 restoreMark → 导出 → 再注入”，stripMarks 不接线。
    const stripped = stripMarks(injected, new Map([["p-1", snapshot]]));
    expect(stripped.map((element) => element.value).join("")).toBe("ABB");
  });
});
