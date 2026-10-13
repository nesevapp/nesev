import { describe, expect, test } from "bun:test";
import { defaultTemplate } from "./default-template";
import { moveSection, nextFreeY, outlineTemplate } from "./layout";
import { prepareTemplate } from "./render";

const names = (schemas: { name: string }[]) => schemas.map((s) => s.name);

describe("outlineTemplate", () => {
  test("splits the default invoice into header, body sections and footer", () => {
    const outline = outlineTemplate(defaultTemplate("invoice"));
    expect(names(outline.header)).toEqual(["logo", "logoSvg"]);
    expect(names(outline.footer)).toContain("pageNumber");
    expect(outline.sections.map(names)).toEqual([
      ["sellerLine", "infoLabels", "infoValues", "sellerLineRule", "recipientAddress"],
      ["heading", "subject"],
      ["introText"],
      ["items"],
      ["totals", "grossRule", "grossLabel", "grossTotal"],
      ["taxNote"],
      ["closingText"],
      ["epcQr", "paymentInfo", "epcQrLabel"],
    ]);
  });
});

describe("moveSection", () => {
  test("swaps two sections, each keeping the spacing above it", () => {
    const template = defaultTemplate("invoice");
    const moved = moveSection(template, 6, -1); // closing text above the tax note
    const y = (name: string) => moved.schemas[0]!.find((s) => s.name === name)!.position.y;
    expect(y("closingText")).toBe(172); // 2 mm below the gross total, as before below the tax note
    expect(y("taxNote")).toBe(182); // 6 mm below the closing text; the payment block below stays at 189
    expect(outlineTemplate(moved).sections.map(names)[5]).toEqual(["closingText"]);
    // the schema array order is untouched, only positions change
    expect(names(moved.schemas[0]!)).toEqual(names(template.schemas[0]!));
  });

  test("a table right below another one starts its own section", () => {
    const template = defaultTemplate("invoice");
    // the Designer recomputes table heights from the sample rows
    template.schemas[0]!.find((s) => s.name === "items")!.height = 26.86;
    const sections = outlineTemplate(template).sections.map(names);
    expect(sections[3]).toEqual(["items"]);
    expect(sections[4]).toEqual(["totals", "grossRule", "grossLabel", "grossTotal"]);
  });

  test("moves a multi-element section as a block", () => {
    const moved = moveSection(defaultTemplate("invoice"), 4, -1); // totals block above the items table
    const sections = outlineTemplate(moved).sections.map(names);
    expect(sections[3]).toEqual(["totals", "grossRule", "grossLabel", "grossTotal"]);
    expect(sections[4]).toEqual(["items"]);
    const y = (name: string) => moved.schemas[0]!.find((s) => s.name === name)!.position.y;
    expect(y("totals")).toBe(121);
    expect(y("grossLabel")).toBe(136);
  });

  test("moving a section next to a table does not merge it into the table's section", () => {
    const template = defaultTemplate("invoice");
    template.schemas[0]!.find((s) => s.name === "items")!.height = 26.86;
    const moved = moveSection(moveSection(template, 6, -1), 5, -1); // closing text up twice, right below the items
    expect(outlineTemplate(moved).sections.map(names).slice(3, 6)).toEqual([
      ["items"],
      ["closingText"],
      ["totals", "grossRule", "grossLabel", "grossTotal"],
    ]);
  });

  test("is a no-op at the edges", () => {
    const template = defaultTemplate("offer");
    expect(moveSection(template, 0, -1)).toBe(template);
  });
});

test("nextFreeY places new elements below the body, above the footer", () => {
  expect(nextFreeY(defaultTemplate("invoice"), 6)).toBe(220.5);
  expect(nextFreeY(defaultTemplate("invoice"), 100)).toBe(169);
});

test("prepareTemplate renders unbound editable elements with their designed content", () => {
  const template = defaultTemplate("offer");
  template.schemas[0]!.push({ ...template.schemas[0]!.find((s) => s.name === "introText")!, name: "Feld1", content: "Hallo" });
  const page = prepareTemplate(template, { introText: "x" }).schemas[0]!;
  expect(page.find((s) => s.name === "Feld1")!.readOnly).toBe(true);
  expect(page.find((s) => s.name === "introText")!.readOnly).toBeFalsy();
});
