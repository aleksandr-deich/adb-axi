import { describe, expect, it } from "vitest";
import { textDiff, visibleText } from "../../src/commands/app/compare.js";

describe("visibleText", () => {
  it("collects the text, label and value fields of a snapshot tree in document order", () => {
    // Synthetic snapshot: the shape adb-axi reads, not output recorded from agent-device.
    const snapshot = {
      nodes: [
        { label: "Counter", value: "saved=3", rect: { x: 0 }, children: [{ text: " Save " }] },
        { text: "" },
        { label: 7 },
      ],
    };
    expect(visibleText(snapshot)).toEqual(["Counter", "saved=3", "Save"]);
  });

  it("finds nothing in a tree with no text", () => {
    expect(visibleText({ nodes: [{ rect: {} }] })).toEqual([]);
    expect(visibleText("text")).toEqual([]);
  });
});

describe("textDiff", () => {
  it("marks lines only in the first snapshot with - and only in the second with +", () => {
    expect(textDiff(["a", "b"], ["a", "c"])).toEqual(["- b", "+ c"]);
  });

  it("counts repeats: a line shown twice and then once is one removal", () => {
    expect(textDiff(["a", "a"], ["a"])).toEqual(["- a"]);
  });

  it("is empty when the text is the same", () => {
    expect(textDiff(["a", "b"], ["a", "b"])).toEqual([]);
  });
});
