import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeInstructionFolders,
  clientsForContextEntry,
  frontmatter,
  links,
  toolsForSkill,
} from "../src/scan/metadata.js";
import { inside, lineCount } from "../src/scan/values.js";

describe("metadata normalization", () => {
  it.each([
    "plain text",
    "---\nnull\n---\nBody",
    "---\n- one\n- two\n---\nBody",
  ])("treats non-mapping frontmatter as empty: %s", (text) =>
    expect(frontmatter(text)).toEqual({}),
  );
  it("preserves typed mapping values and reports malformed YAML", () => {
    expect(
      frontmatter("---\nname: review\nuser-invocable: false\n---\nBody"),
    ).toEqual({ name: "review", "user-invocable": false });
    expect(() => frontmatter("---\nbroken: [\n---\nBody")).toThrow();
  });
  it("extracts supported reference forms without reading documents", () => {
    expect(
      links("[[Guide#part|Label]] [Doc](docs/file.md) `extra.md` @nested.md "),
    ).toEqual([
      { target: "Guide", wiki: true },
      { target: "docs/file.md", wiki: false },
      { target: "extra.md", wiki: false },
      { target: "nested.md", wiki: false },
    ]);
  });
  it.each([
    ["", 0],
    ["one", 1],
    ["one\r\ntwo\r\n", 2],
    ["one\rtwo", 2],
    ["\n", 1],
  ])("counts lines for %j", (text, count) =>
    expect(lineCount(text)).toBe(count),
  );
  it("keeps lexical sibling prefixes outside a scan root", () => {
    const root = path.resolve("fixture");
    expect(inside(root, path.join(root, "doc.md"))).toBe(true);
    expect(inside(root, root + "-private/doc.md")).toBe(false);
  });
  it("distinguishes discovery entry points from arbitrary paths", () => {
    const root = path.resolve("fixture");
    const codexHome = path.resolve("home/.codex");
    expect(
      clientsForContextEntry(
        path.join(root, "CLAUDE.md"),
        "project",
        root,
        codexHome,
      ),
    ).toEqual(["cursor", "claude"]);
    expect(
      clientsForContextEntry(
        path.join(root, "app/CLAUDE.md"),
        "project",
        root,
        codexHome,
      ),
    ).toEqual(["claude"]);
    expect(toolsForSkill("/fixture/docs/review/SKILL.md")).toEqual([]);
    expect(toolsForSkill("/fixture/.agents/skills/review/SKILL.md")).toEqual([
      "cursor",
      "codex",
      "copilot",
    ]);
  });
});

it("lets Claude Code read AGENTS.md only where no Claude instruction file shadows it", () => {
  const root = path.resolve("fixture");
  const codexHome = path.resolve("home/.codex");
  const clients = (alias: string, claude: string[]) =>
    clientsForContextEntry(
      path.join(root, alias),
      "project",
      root,
      codexHome,
      claudeInstructionFolders(claude.map((file) => path.join(root, file))),
    );
  expect(clients("AGENTS.md", [])).toEqual([
    "cursor",
    "codex",
    "copilot",
    "claude",
  ]);
  expect(clients(".claude/AGENTS.md", [])).toContain("claude");
  for (const shadow of ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"])
    expect(clients("AGENTS.md", [shadow])).not.toContain("claude");
  expect(clients("app/AGENTS.md", ["CLAUDE.md"])).not.toContain("claude");
  expect(clients("app/AGENTS.md", ["app/CLAUDE.md"])).not.toContain("claude");
  expect(clients("app/AGENTS.md", ["lib/CLAUDE.md"])).toContain("claude");
  expect(clients("AGENTS.md", ["app/CLAUDE.md"])).toContain("claude");
});

it("keeps Codex internal system skills exclusive without disabling shared legacy skills", () => {
  for (const name of [
    "imagegen",
    "openai-docs",
    "review-agent",
    "skill-creator",
    "skill-installer",
  ]) {
    expect(
      toolsForSkill(`/home/.codex/skills/.system/${name}/SKILL.md`),
    ).toEqual(["codex"]);
  }
  expect(toolsForSkill("/home/.codex/skills/review/SKILL.md")).toEqual([
    "cursor",
    "codex",
  ]);
});
