import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import type { TokenEntry, TokenEstimate } from "../src/contracts.js";
import { scanProject } from "../src/scanner.js";
import { estimateTokens } from "../src/token-estimator.js";
import { startServer } from "../src/server.js";

test("estimates one agent's startup and on-demand context through the authenticated API", async (t) => {
  await fs.mkdir(".local/test", { recursive: true });
  const root = await fs.mkdtemp(path.resolve(".local/test/optimizer-"));
  for (const [name, text] of Object.entries({
    "AGENTS.md": "Read [guide](guide.md)",
    "guide.md": "abcdefgh",
    "child/AGENTS.md": "Nested context",
    "CLAUDE.md": "Claude only",
    ".agents/skills/test/SKILL.md":
      "---\nname: test\ndescription: Run tests\n---\nSkill body",
  })) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), text);
  }
  const { server, url, token } = await startServer({
    root,
    includeUser: false,
  });
  t.onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const endpoint = new URL(
    "/api/token-estimate?client=codex&model=gpt-6.1-sol",
    url,
  );
  expect((await fetch(endpoint)).status).toBe(401);
  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  const data: TokenEstimate = await response.json();
  expect(
    data.entries.map((entry) => [entry.path, entry.portion, entry.kind]),
  ).toEqual(
    expect.arrayContaining([
      ["AGENTS.md", "startup", "instruction"],
      ["guide.md", "on-demand", "document"],
      ["child/AGENTS.md", "on-demand", "instruction"],
      [".agents/skills/test/SKILL.md", "startup", "skill-catalog"],
      [".agents/skills/test/SKILL.md", "on-demand", "skill-body"],
    ]),
  );
  expect(data.entries).toHaveLength(5);
  expect(data.entries.find((entry) => entry.path === "guide.md")).toMatchObject(
    { tokens: 2, words: 1, bytes: 8, inputCost: 0.000004 },
  );
  expect(data.startup).toMatchObject({ tokens: 10, words: 5, bytes: 36 });
  expect(data.onDemand).toMatchObject({ tokens: 9, words: 5, bytes: 32 });
  expect(data.entries.map((entry) => entry.tokens)).toEqual([6, 4, 4, 3, 2]);
  endpoint.searchParams.set("client", "all");
  const combined: TokenEstimate = await (
    await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } })
  ).json();
  expect(combined.client).toBe("all");
  expect(combined.entries).toHaveLength(6);
  expect(new Set(combined.entries.map((entry) => entry.id)).size).toBe(6);
  expect(combined.startup.tokens).toBe(13);
  expect(combined.onDemand).toEqual(data.onDemand);
  expect(combined.entries.some((entry) => entry.path === "CLAUDE.md")).toBe(
    true,
  );
  endpoint.searchParams.set("client", "unsupported");
  expect(
    (await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } }))
      .status,
  ).toBe(400);
});

test("keeps user context, conditional rules and duplicate skills scoped to the selected agent", async (t) => {
  await fs.mkdir(".local/test", { recursive: true });
  const base = await fs.mkdtemp(path.resolve(".local/test/scope-"));
  const root = path.join(base, "project"),
    home = path.join(base, "home");
  const duplicate =
    "---\nname: shared\ndescription: Shared workflow\n---\nSee [notes](notes.md)";
  for (const [name, text] of Object.entries({
    "project/AGENTS.md": "Fallback instructions",
    "project/AGENTS.override.md":
      "Override instructions [Claude](.claude/CLAUDE.md)",
    "project/.claude/CLAUDE.md": "Claude project instructions [[Guidelines]]",
    "project/docs/guidelines.md": "Shared guidelines",
    "project/.claude/rules/global.md": "Global rule",
    "project/.claude/rules/conditional.md":
      "---\npaths: [src/**]\n---\nScoped rule",
    "project/.cursor/rules/always.mdc":
      "---\nalwaysApply: true\n---\nAlways rule",
    "project/.cursor/rules/optional.mdc":
      "---\nglobs: ['*.ts']\n---\nOptional rule",
    "project/.github/copilot-instructions.md": "Copilot instructions",
    "project/.agents/skills/shared/SKILL.md": duplicate,
    "project/.claude/skills/shared/SKILL.md": duplicate,
    "project/.claude/skills/shared/notes.md": "Linked notes",
    "home/.codex/AGENTS.md": "User Codex instructions",
    "home/.claude/CLAUDE.md": "User Claude instructions",
  })) {
    const file = path.join(base, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
  const { server, url, token } = await startServer({
    root,
    home,
    codexHome: path.join(home, ".codex"),
  });
  t.onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(base, { recursive: true, force: true });
  });
  const get = async (
    client: string,
    model = "claude-sonnet-5-5",
  ): Promise<TokenEstimate> =>
    (
      await fetch(
        new URL(`/api/token-estimate?client=${client}&model=${model}`, url),
        { headers: { Authorization: `Bearer ${token}` } },
      )
    ).json();
  const codex = await get("codex");
  expect(
    codex.entries
      .filter((entry) => entry.kind === "instruction")
      .map((entry) => entry.name),
  ).toEqual(expect.arrayContaining(["AGENTS.override.md", "AGENTS.md"]));
  expect(codex.entries.some((entry) => entry.path === "AGENTS.md")).toBe(false);
  expect(codex.entries.filter((entry) => entry.scope === "user")).toHaveLength(
    1,
  );
  const combined = await get("all");
  expect(
    codex.entries.find(
      (entry) => entry.name === "CLAUDE.md" && entry.scope === "project",
    )?.portion,
  ).toBe("on-demand");
  expect(
    combined.entries.filter(
      (entry) => entry.name === "CLAUDE.md" && entry.scope === "project",
    ),
  ).toHaveLength(1);
  expect(
    combined.entries.find(
      (entry) => entry.name === "CLAUDE.md" && entry.scope === "project",
    )?.portion,
  ).toBe("startup");
  const claude = await get("claude");
  expect(
    claude.entries.find((entry) => entry.name === "guidelines.md")?.portion,
  ).toBe("on-demand");
  expect(
    claude.entries.filter((entry) => entry.kind === "skill-catalog"),
  ).toHaveLength(1);
  expect(
    claude.entries.find((entry) => entry.kind === "skill-catalog")?.portion,
  ).toBe("startup");
  expect(
    claude.entries.find((entry) => entry.name === "global.md")?.portion,
  ).toBe("startup");
  expect(
    claude.entries.find((entry) => entry.name === "conditional.md")?.portion,
  ).toBe("on-demand");
  expect(
    claude.entries.find((entry) => entry.name === "notes.md")?.portion,
  ).toBe("on-demand");
  expect(claude.entries.filter((entry) => entry.scope === "user")).toHaveLength(
    1,
  );
  const cursor = await get("cursor");
  expect(
    cursor.entries.find((entry) => entry.name === "always.mdc")?.portion,
  ).toBe("startup");
  expect(
    cursor.entries.find((entry) => entry.name === "optional.mdc")?.portion,
  ).toBe("on-demand");
  const copilot = await get("copilot");
  expect(
    copilot.entries.find((entry) => entry.name === "copilot-instructions.md")
      ?.portion,
  ).toBe("startup");
  expect(
    (await get("claude", "claude-opus-5-5")).startup.inputCost,
  ).toBeCloseTo(claude.startup.inputCost * 2);
});

test("counts physical aliases once and promotes a duplicated skill catalog when any copy applies at startup", async (t) => {
  await fs.mkdir(".local/test", { recursive: true });
  const root = await fs.mkdtemp(path.resolve(".local/test/dedup-"));
  const skill = "---\nname: shared\ndescription: Workflow\n---\nWork carefully";
  for (const [name, text] of Object.entries({
    "AGENTS.md": "Common instructions",
    ".agents/nested/.agents/skills/shared/SKILL.md": skill,
    ".agents/skills/shared/SKILL.md": skill,
  })) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
  await fs.mkdir(path.join(root, ".cursor/rules"), { recursive: true });
  await fs.symlink(
    path.join(root, "AGENTS.md"),
    path.join(root, ".cursor/rules/global.mdc"),
  );
  const { server, url, token } = await startServer({
    root,
    includeUser: false,
  });
  t.onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const response = await fetch(
    new URL("/api/token-estimate?client=cursor&model=gpt-6.1-sol", url),
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data: TokenEstimate = await response.json();
  expect(
    data.entries.find((entry) => entry.kind === "skill-catalog")?.portion,
  ).toBe("startup");
  expect(
    data.entries.filter((entry) =>
      ["rule", "instruction"].includes(entry.kind),
    ),
  ).toHaveLength(1);
  expect(data.startup.tokens).toBe(9);
  expect(data.onDemand.tokens).toBe(4);
});

test.each([
  ["gpt-6-astra", 272000, 10, 20],
  ["gpt-6.1-sol", 272000, 2, 4],
  ["gpt-6-luna", 272000, 0.1, 0.2],
  ["claude-haiku-5-5", 100000, 0.1, 0.5],
] as const)(
  "prices %s by the full portion's prompt length",
  async (model, threshold, baseRate, longRate) => {
    await fs.mkdir(".local/test", { recursive: true });
    const root = await fs.mkdtemp(path.resolve(".local/test/pricing-"));
    try {
      const snapshot = await scanProject(root, { includeUser: false });
      const entry = (
        id: string,
        tokens: number,
        portion: TokenEntry["portion"],
      ): TokenEntry => ({
        id,
        name: id,
        path: id,
        scope: "project",
        kind: "instruction",
        portion,
        tokens,
        words: tokens,
        bytes: tokens * 4,
        inputCost: 0,
      });
      snapshot.tokenInventory.codex = [
        entry("first", threshold / 2, "startup"),
        entry("second", threshold / 2, "startup"),
        entry("on-demand", 1000, "on-demand"),
      ];
      const atThreshold = estimateTokens(snapshot, "all", model);
      expect(atThreshold.startup.inputCost).toBeCloseTo(
        (threshold * baseRate) / 1_000_000,
        10,
      );
      snapshot.tokenInventory.codex[1] = entry(
        "second",
        threshold / 2 + 1,
        "startup",
      );
      const aboveThreshold = estimateTokens(snapshot, "all", model);
      expect(aboveThreshold.startup.inputCost).toBeCloseTo(
        ((threshold + 1) * longRate) / 1_000_000,
        10,
      );
      expect(aboveThreshold.onDemand.inputCost).toBeCloseTo(
        (1000 * baseRate) / 1_000_000,
        10,
      );
      expect(
        aboveThreshold.entries.find((item) => item.id === "first")?.inputCost,
      ).toBeCloseTo(((threshold / 2) * longRate) / 1_000_000, 10);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test.each(["project", "user"] as const)(
  "respects per-agent description loading for %s skills and keeps manual bodies on demand",
  async (scope) => {
    await fs.mkdir(".local/test", { recursive: true });
    const base = await fs.mkdtemp(path.resolve(".local/test/skill-policy-"));
    const root = path.join(base, "project"),
      home = path.join(base, "home");
    try {
      await fs.mkdir(root);
      await fs.mkdir(home);
      const location = scope === "project" ? root : home;
      for (const [name, flags] of Object.entries({
        automatic: "",
        manual: "disable-model-invocation: true\n",
        background: "user-invocable: false\n",
        disabled: "disable-model-invocation: true\nuser-invocable: false\n",
        "codex-manual": "",
        "manual-all": "disable-model-invocation: true\n",
      })) {
        for (const folder of [".agents", ".claude"]) {
          const directory = path.join(location, folder, "skills", name);
          await fs.mkdir(directory, { recursive: true });
          await fs.writeFile(
            path.join(directory, "SKILL.md"),
            `---\nname: ${name}\ndescription: ${name} workflow\n${flags}---\nDetailed instructions for ${name}.`,
          );
          if (name === "codex-manual" || name === "manual-all") {
            await fs.mkdir(path.join(directory, "agents"));
            await fs.writeFile(
              path.join(directory, "agents/openai.yaml"),
              "policy:\n  allow_implicit_invocation: false\n",
            );
          }
        }
      }
      // No Codex discovery path: no agent should promote this manual catalog.
      const manualDirectory = path.join(
        location,
        ".claude/skills/claude-manual",
      );
      await fs.mkdir(manualDirectory, { recursive: true });
      await fs.writeFile(
        path.join(manualDirectory, "SKILL.md"),
        "---\nname: claude-manual\ndescription: Manual workflow\ndisable-model-invocation: true\n---\nManual instructions.",
      );
      const snapshot = await scanProject(root, {
        home,
        codexHome: path.join(home, ".codex"),
      });
      expect(snapshot.data.skills).toHaveLength(7);
      expect(
        snapshot.data.skills.find((skill) => skill.name === "codex-manual")
          ?.invocation.codex,
      ).toBe("User only");
      const codex = estimateTokens(snapshot, "codex", "gpt-6.1-sol");
      const startupNames = (data: TokenEstimate) =>
        data.entries
          .filter(
            (entry) =>
              entry.portion === "startup" && entry.kind === "skill-catalog",
          )
          .map((entry) => entry.name)
          .sort();
      expect(startupNames(codex)).toEqual([
        "automatic",
        "background",
        "disabled",
        "manual",
      ]);
      for (const name of ["codex-manual", "manual-all"]) {
        const entries = codex.entries.filter((entry) => entry.name === name);
        expect(entries).toHaveLength(2);
        expect(entries.every((entry) => entry.portion === "on-demand")).toBe(
          true,
        );
      }
      for (const client of ["claude", "cursor", "copilot"] as const) {
        const data = estimateTokens(snapshot, client, "gpt-6.1-sol");
        expect(startupNames(data)).toEqual([
          "automatic",
          "background",
          "codex-manual",
        ]);
        for (const name of [
          "manual",
          "manual-all",
          "disabled",
          "claude-manual",
        ]) {
          const entries = data.entries.filter((entry) => entry.name === name);
          expect(entries).toHaveLength(2);
          expect(entries.every((entry) => entry.portion === "on-demand")).toBe(
            true,
          );
          expect(
            entries.find((entry) => entry.kind === "skill-body")?.tokens,
          ).toBeGreaterThan(0);
        }
        expect(data.startup.tokens).toBeLessThan(codex.startup.tokens);
      }
      const all = estimateTokens(snapshot, "all", "gpt-6.1-sol");
      expect(startupNames(all)).toEqual([
        "automatic",
        "background",
        "codex-manual",
        "disabled",
        "manual",
      ]);
      expect(
        all.entries.filter((entry) => entry.name === "manual-all"),
      ).toHaveLength(2);
      expect(
        all.entries
          .filter((entry) => entry.name === "manual-all")
          .every((entry) => entry.portion === "on-demand"),
      ).toBe(true);
      const codexManualCatalog = codex.entries.find(
        (entry) =>
          entry.name === "codex-manual" && entry.kind === "skill-catalog",
      )!;
      expect(all.startup.tokens).toBe(
        codex.startup.tokens + codexManualCatalog.tokens,
      );
      expect(
        all.entries.filter((entry) => entry.name === "manual"),
      ).toHaveLength(2);
      expect(
        all.entries.find(
          (entry) => entry.name === "manual" && entry.kind === "skill-catalog",
        )?.portion,
      ).toBe("startup");
      expect(
        all.entries
          .filter((entry) => entry.name === "claude-manual")
          .every((entry) => entry.portion === "on-demand"),
      ).toBe(true);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  },
);

test("keeps Codex catalog visibility local to each copy's policy and discovery scope", async () => {
  await fs.mkdir(".local/test", { recursive: true });
  const root = await fs.mkdtemp(path.resolve(".local/test/codex-policy-"));
  try {
    const skill =
      "---\nname: shared\ndescription: Shared workflow\n---\nDetailed instructions.";
    const rootSkill = path.join(root, ".agents/skills/shared");
    const nestedSkill = path.join(root, "app/.agents/skills/shared");
    for (const directory of [rootSkill, nestedSkill]) {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "SKILL.md"), skill);
    }
    const policyDirectory = path.join(rootSkill, "agents");
    await fs.mkdir(policyDirectory);
    const policyFile = path.join(policyDirectory, "openai.yaml");
    await fs.writeFile(
      policyFile,
      "policy:\n  allow_implicit_invocation: false\n",
    );
    const scan = () => scanProject(root, { includeUser: false });
    const manual = estimateTokens(await scan(), "codex", "gpt-6.1-sol");
    expect(manual.startup.tokens).toBe(0);
    expect(manual.entries).toHaveLength(2);
    expect(manual.entries.every((entry) => entry.portion === "on-demand")).toBe(
      true,
    );
    expect(manual.onDemand.tokens).toBeGreaterThan(0);
    await fs.writeFile(
      policyFile,
      "policy:\n  allow_implicit_invocation: true\n",
    );
    const automatic = estimateTokens(await scan(), "codex", "gpt-6.1-sol");
    expect(automatic.startup.tokens).toBeGreaterThan(0);
    expect(automatic.entries).toHaveLength(2);
    expect(
      automatic.entries.find((entry) => entry.kind === "skill-body")?.portion,
    ).toBe("on-demand");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("counts AGENTS.md as Claude Code instructions when no CLAUDE.md shadows it", async () => {
  await fs.mkdir(".local/test", { recursive: true });
  const root = await fs.mkdtemp(path.resolve(".local/test/agents-md-"));
  try {
    for (const [name, text] of Object.entries({
      "AGENTS.md": "Shared instructions",
      "app/AGENTS.md": "App instructions",
      "lib/AGENTS.md": "Lib instructions",
      "lib/CLAUDE.md": "Lib Claude instructions",
    })) {
      await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await fs.writeFile(path.join(root, name), text);
    }
    const claude = estimateTokens(
      await scanProject(root, { includeUser: false }),
      "claude",
      "claude-sonnet-5-5",
    );
    expect(
      claude.entries
        .map((entry) => [entry.path, entry.portion])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    ).toEqual([
      ["AGENTS.md", "startup"],
      ["app/AGENTS.md", "on-demand"],
      ["lib/CLAUDE.md", "on-demand"],
    ]);
    await fs.writeFile(path.join(root, "CLAUDE.md"), "@AGENTS.md");
    const shadowed = estimateTokens(
      await scanProject(root, { includeUser: false }),
      "claude",
      "claude-sonnet-5-5",
    );
    expect(
      shadowed.entries
        .filter((entry) => entry.kind === "instruction")
        .map((entry) => [entry.path, entry.portion]),
    ).toEqual(
      expect.arrayContaining([
        ["CLAUDE.md", "startup"],
        ["lib/CLAUDE.md", "on-demand"],
      ]),
    );
    expect(
      shadowed.entries.some(
        (entry) => entry.path === "AGENTS.md" && entry.kind === "instruction",
      ),
    ).toBe(false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
