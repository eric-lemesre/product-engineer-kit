import path from "node:path";
import type {
  Client,
  ContextMetrics,
  ModelPrice,
  ScanData,
  TokenEntry,
  TokenEstimate,
} from "./contracts.js";
import { HttpError } from "./http/errors.js";
import {
  claudeInstructionFolders,
  clientsForContextEntry,
  links,
  toolsForSkill,
} from "./scan/metadata.js";
import type { FileEntry, ScanEnvironment, Snapshot } from "./scan/types.js";
import { referenceResolver } from "./scan/references.js";
import { inside, slash } from "./scan/values.js";

export const modelPrices: ModelPrice[] = [
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    inputPerMillion: 10,
    longContext: { aboveTokens: 272000, inputPerMillion: 20 },
    source: "https://developers.openai.com/api/docs/pricing",
    verifiedAt: "2026-10-17",
  },
  {
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    inputPerMillion: 2,
    longContext: { aboveTokens: 272000, inputPerMillion: 4 },
    source: "https://developers.openai.com/api/docs/pricing",
    verifiedAt: "2026-10-17",
  },
  {
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    inputPerMillion: 0.1,
    longContext: { aboveTokens: 272000, inputPerMillion: 0.2 },
    source: "https://developers.openai.com/api/docs/pricing",
    verifiedAt: "2026-10-17",
  },
  {
    id: "claude-fable-5-1",
    name: "Claude Fable 5.1",
    inputPerMillion: 10,
    source: "https://platform.claude.com/docs/en/about-claude/pricing",
    verifiedAt: "2026-10-17",
  },
  {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    inputPerMillion: 4,
    source: "https://platform.claude.com/docs/en/about-claude/pricing",
    verifiedAt: "2026-10-17",
  },
  {
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    inputPerMillion: 2,
    source: "https://platform.claude.com/docs/en/about-claude/pricing",
    verifiedAt: "2026-10-17",
  },
  {
    id: "claude-haiku-5-5",
    name: "Claude Haiku 5.5",
    inputPerMillion: 0.1,
    longContext: { aboveTokens: 100000, inputPerMillion: 0.5 },
    source: "https://platform.claude.com/docs/en/about-claude/pricing",
    verifiedAt: "2026-10-17",
  },
];
const clients: Client[] = ["codex", "claude", "cursor", "copilot"];
export const estimationMethod =
  "Local heuristic: Unicode characters / 4, rounded up per entry. Words are whitespace-separated; sizes are UTF-8 bytes. Not a model tokenizer or live usage measurement.";

/** Counts discovered text only; references never promote their targets to startup. */
export function contextInventory(
  entries: FileEntry[],
  data: ScanData,
  env: ScanEnvironment,
  skillCatalogClients: ReadonlyMap<string, ReadonlySet<Client>>,
): Record<Client, TokenEntry[]> {
  const byAlias = new Map(
    entries.flatMap((entry) =>
      entry.aliases.map((alias) => [alias, entry] as const),
    ),
  );
  const result: Record<Client, TokenEntry[]> = {
    codex: [],
    claude: [],
    cursor: [],
    copilot: [],
  };
  const claudeFolders = claudeInstructionFolders(
    entries.flatMap((entry) =>
      entry.scope === "project" ? entry.aliases : [],
    ),
  );
  const resolveReference = referenceResolver(entries, env);
  const nodes = new Map(data.nodes.map((node) => [node.id, node]));
  const rules = new Map(data.rules.map((rule) => [rule.id, rule]));
  const skills = new Map(
    data.skills.flatMap((skill) =>
      skill.editTargets.map((target) => [target.id, skill] as const),
    ),
  );
  for (const client of clients) {
    const rows = new Map<string, TokenEntry>();
    const queue = new Set<FileEntry>();
    const add = (
      entry: FileEntry,
      kind: TokenEntry["kind"],
      startup: boolean,
      text = entry.text,
      name = path.basename(entry.file),
      id = entry.id,
    ) => {
      queue.add(entry);
      const existing = rows.get(id);
      if (existing) {
        if (startup)
          rows.set(id, {
            ...existing,
            portion: "startup",
            path: env.display(entry.file, entry.scope),
          });
        return;
      }
      rows.set(id, {
        id,
        name,
        path: env.display(entry.file, entry.scope),
        scope: entry.scope,
        kind,
        portion: startup ? "startup" : "on-demand",
        tokens: Math.ceil(Array.from(text).length / 4),
        words: text.match(/\S+/gu)?.length ?? 0,
        bytes: Buffer.byteLength(text),
        inputCost: 0,
      });
    };
    for (const entry of entries) {
      const node = nodes.get(entry.id);
      if (node?.kind === "instruction") {
        const aliases = entry.aliases.filter((alias) =>
          clientsForContextEntry(
            alias,
            entry.scope,
            env.root,
            env.codexHome,
            claudeFolders,
          ).includes(client),
        );
        const effective = aliases.filter(
          (alias) =>
            !(
              client === "codex" &&
              path.basename(alias) === "AGENTS.md" &&
              byAlias.has(path.join(path.dirname(alias), "AGENTS.override.md"))
            ),
        );
        if (effective.length)
          add(
            entry,
            "instruction",
            effective.some(
              (alias) =>
                entry.scope === "user" ||
                path.dirname(alias) === env.root ||
                (client === "claude" &&
                  path.dirname(alias) === path.join(env.root, ".claude")) ||
                (client === "copilot" &&
                  alias ===
                    path.join(env.root, ".github/copilot-instructions.md")),
            ),
          );
      }
      const rule = rules.get(entry.id);
      if (rule?.clients.includes(client)) {
        const unscoped =
          client === "cursor"
            ? rule.alwaysApply || rule.legacy
            : client === "claude"
              ? !rule.pathsCondition.length
              : rule.applyTo.includes("**") || rule.applyTo.includes("**/*");
        const rootRule =
          entry.scope === "user" ||
          entry.aliases.some((alias) =>
            /^(?:\.cursorrules|\.(?:claude|cursor)\/rules\/|\.github\/instructions\/)/.test(
              slash(path.relative(env.root, alias)),
            ),
          );
        add(entry, "rule", unscoped && rootRule);
      }
      const skill = skills.get(entry.id);
      if (
        skill?.clients.includes(client) &&
        entry.aliases.some(
          (alias) =>
            toolsForSkill(slash(alias)).includes(client) ||
            (client === "codex" &&
              entry.scope === "user" &&
              inside(path.join(env.codexHome, "skills"), alias)),
        )
      ) {
        // Identical copies and symlink aliases represent one discovered skill.
        const catalog = `${skill.name}\n${skill.description}`;
        const startup =
          skillCatalogClients.get(entry.id)?.has(client) === true &&
          (entry.scope === "user" ||
            entry.aliases.some((alias) => {
              const relative = slash(path.relative(env.root, alias));
              return (
                /^\.(?:agents|codex|claude|cursor|github)\/skills\//.test(
                  relative,
                ) && toolsForSkill(relative).includes(client)
              );
            }));
        add(
          entry,
          "skill-catalog",
          startup,
          catalog,
          skill.name,
          `${skill.id}:skill-catalog`,
        );
        add(
          entry,
          "skill-body",
          false,
          entry.text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, ""),
          skill.name,
          `${skill.id}:skill-body`,
        );
      }
    }
    // Sets preserve insertion order and visit newly discovered references, including cycles, once.
    for (const entry of queue) {
      for (const link of links(entry.text)) {
        const found = resolveReference(entry, link);
        if (
          !found ||
          queue.has(found) ||
          !env.allowed.some((base) => inside(base, found.real))
        )
          continue;
        add(found, "document", false);
      }
    }
    result[client] = [...rows.values()].sort(
      (a, b) => b.tokens - a.tokens || a.path.localeCompare(b.path),
    );
  }
  return result;
}

export function estimateTokens(
  snapshot: Snapshot,
  clientId: string | null,
  modelId: string | null,
): TokenEstimate {
  const client =
    clientId === "all" ? "all" : clients.find((client) => client === clientId);
  const model = modelPrices.find((model) => model.id === modelId);
  if (!client || !model)
    throw new HttpError(400, "Select supported agents and a model.");
  const inventory = new Map<string, TokenEntry>();
  for (const selected of client === "all" ? clients : [client]) {
    for (const entry of snapshot.tokenInventory[selected]) {
      const existing = inventory.get(entry.id);
      if (
        !existing ||
        (existing.portion !== "startup" && entry.portion === "startup")
      )
        inventory.set(entry.id, entry);
    }
  }
  const portionTokens = { startup: 0, "on-demand": 0 };
  for (const entry of inventory.values())
    portionTokens[entry.portion] += entry.tokens;
  const inputRate = (portion: TokenEntry["portion"]): number =>
    model.longContext && portionTokens[portion] > model.longContext.aboveTokens
      ? model.longContext.inputPerMillion
      : model.inputPerMillion;
  const entries = [...inventory.values()]
    .sort((a, b) => b.tokens - a.tokens || a.path.localeCompare(b.path))
    .map((entry) => ({
      ...entry,
      inputCost: (entry.tokens * inputRate(entry.portion)) / 1_000_000,
    }));
  const total = (portion: TokenEntry["portion"]): ContextMetrics =>
    entries
      .filter((entry) => entry.portion === portion)
      .reduce(
        (sum, entry) => ({
          tokens: sum.tokens + entry.tokens,
          words: sum.words + entry.words,
          bytes: sum.bytes + entry.bytes,
          inputCost: sum.inputCost + entry.inputCost,
        }),
        { tokens: 0, words: 0, bytes: 0, inputCost: 0 },
      );
  return {
    client,
    model,
    models: modelPrices,
    method: estimationMethod,
    entries,
    startup: total("startup"),
    onDemand: total("on-demand"),
    includeUser: snapshot.data.limits.includeUser,
    warnings: snapshot.data.warnings,
  };
}
