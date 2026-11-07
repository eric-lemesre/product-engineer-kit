import fs from "node:fs/promises";
import path from "node:path";
import { parse as yaml } from "yaml";
import type { Client, ContextNode, Rule, Skill } from "../contracts.js";
import {
  claudeInstructionFolders,
  clientsForContextEntry,
  frontmatter,
  ruleClient,
  toolsForSkill,
} from "./metadata.js";
import type { EditableFile, FileEntry, ScanEnvironment } from "./types.js";
import {
  falsehood,
  id,
  inside,
  INSTRUCTION,
  lineCount,
  record,
  required,
  slash,
  truth,
} from "./values.js";
export async function discoverAssets(
  entries: FileEntry[],
  env: ScanEnvironment,
) {
  const { root, codexHome, display, warnings } = env;
  const claudeFolders = claudeInstructionFolders(
    entries.flatMap((entry) =>
      entry.scope === "project" ? entry.aliases : [],
    ),
  );
  const context = new Map<string, ContextNode>();
  const rules = new Map<string, Rule>();
  const skills = new Map<string, Skill>();
  const skillCatalogClients = new Map<string, Set<Client>>();
  const content = new Map<string, string>();
  const editable = new Map<string, EditableFile>();
  function addContext(entry: FileEntry): void {
    if (context.has(entry.id)) return;
    const aliases = entry.aliases.filter((p) => !ruleClient(p));
    const firstAlias = aliases[0];
    if (!firstAlias) return;
    const deletable =
      entry.aliases.length === 1 &&
      path.relative(entry.file, entry.real) === "";
    const paths = aliases.map((p) => display(p, entry.scope));
    const kind = aliases.some((p) => INSTRUCTION.test(path.basename(p)))
      ? "instruction"
      : aliases.some((p) => /[\\/]rules[\\/]|\.mdc$/.test(p))
        ? "rule"
        : "knowledge";
    context.set(entry.id, {
      id: entry.id,
      name: path.basename(firstAlias),
      path: required(paths[0]),
      aliases: paths,
      clients: [
        ...new Set(
          aliases.flatMap((alias) =>
            clientsForContextEntry(
              alias,
              entry.scope,
              root,
              codexHome,
              claudeFolders,
            ),
          ),
        ),
      ],
      editTargets: [{ id: entry.id, path: required(paths[0]), deletable }],
      scope: entry.scope,
      kind,
      bytes: Buffer.byteLength(entry.text),
      lines: lineCount(entry.text),
      excerpt: entry.text.slice(0, 180),
    });
    content.set(entry.id, entry.text);
    editable.set(entry.id, { file: entry.file, real: entry.real, deletable });
  }
  for (const entry of entries) {
    if (path.basename(entry.file) === "SKILL.md") {
      const deletable =
        entry.aliases.length === 1 &&
        path.relative(entry.file, entry.real) === "";
      let meta: Record<string, unknown> = {};
      try {
        meta = frontmatter(entry.text);
      } catch {
        warnings.push(
          `Invalid skill frontmatter: ${display(entry.file, entry.scope)}`,
        );
      }
      const name =
        typeof meta.name === "string"
          ? meta.name
          : path.basename(path.dirname(entry.file));
      const key = `${entry.scope}:${name}:${id(entry.text)}`;
      if (!skills.has(key))
        skills.set(key, {
          id: id(key),
          name,
          description:
            typeof meta.description === "string" ? meta.description : "",
          scope: entry.scope,
          paths: [],
          editTargets: [],
          clients: [],
          invocation: {},
          legacy: false,
          mode: "Not discovered",
        });
      const skill = required(skills.get(key));
      content.set(skill.id, entry.text);
      editable.set(entry.id, { file: entry.file, real: entry.real, deletable });
      skill.editTargets.push({
        id: entry.id,
        path: display(entry.file, entry.scope),
        deletable,
      });
      let policy: Record<string, unknown> = {};
      try {
        policy = record(
          record(
            yaml(
              await fs.readFile(
                path.join(path.dirname(entry.real), "agents/openai.yaml"),
                "utf8",
              ),
            ),
          ).policy,
        );
      } catch {
        /* Optional metadata. */
      }
      const descriptionClients = new Set<Client>();
      skillCatalogClients.set(entry.id, descriptionClients);
      for (const alias of entry.aliases) {
        const p = display(alias, entry.scope);
        skill.paths.push(p);
        if (p.includes(".codex/skills/")) skill.legacy = true;
        const discovered = toolsForSkill(slash(alias));
        if (
          entry.scope === "user" &&
          inside(path.join(codexHome, "skills"), alias) &&
          !discovered.includes("codex")
        )
          discovered.push("codex");
        for (const client of discovered) {
          if (!skill.clients.includes(client)) skill.clients.push(client);
          const descriptionVisible =
            client === "codex"
              ? !falsehood(policy.allow_implicit_invocation)
              : !truth(meta["disable-model-invocation"]);
          if (descriptionVisible) descriptionClients.add(client);
          const invocation =
            client === "codex"
              ? falsehood(policy.allow_implicit_invocation)
                ? "User only"
                : "Model + user"
              : truth(meta["disable-model-invocation"])
                ? falsehood(meta["user-invocable"])
                  ? "Disabled"
                  : "User only"
                : falsehood(meta["user-invocable"]) &&
                    (client === "claude" || client === "copilot")
                  ? "Model only"
                  : "Model + user";
          skill.invocation[client] = [
            ...new Set([
              ...(skill.invocation[client]?.split(" / ") || []),
              invocation,
            ]),
          ].join(" / ");
        }
      }
      skill.mode =
        [...new Set(Object.values(skill.invocation))].join(" / ") ||
        "Not discovered";
    } else {
      const ruleAliases = entry.aliases.filter((p) => ruleClient(p));
      if (ruleAliases.length) {
        let meta: Record<string, unknown> = {};
        try {
          meta = frontmatter(entry.text);
        } catch {
          warnings.push(
            `Invalid rule frontmatter: ${display(entry.file, entry.scope)}`,
          );
        }
        const patterns = (value: unknown): string[] =>
          (Array.isArray(value)
            ? value
            : typeof value === "string"
              ? [value]
              : []
          )
            .filter((item) => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean);
        rules.set(entry.id, {
          id: entry.id,
          name: path.basename(required(ruleAliases[0])),
          description:
            typeof meta.description === "string" ? meta.description : "",
          scope: entry.scope,
          paths: ruleAliases.map((p) => display(p, entry.scope)),
          clients: [
            ...new Set(
              ruleAliases
                .map(ruleClient)
                .filter((client): client is Client => client !== null),
            ),
          ],
          legacy: ruleAliases.some(
            (p) => path.basename(p).toLowerCase() === ".cursorrules",
          ),
          globs: patterns(meta.globs),
          pathsCondition: patterns(meta.paths),
          applyTo: patterns(meta.applyTo),
          alwaysApply: meta.alwaysApply === true,
        });
        content.set(entry.id, entry.text);
      }
      if (
        !entry.aliases.every((p) => /[\\/]skills[\\/]/.test(p)) &&
        entry.aliases.some(
          (p) =>
            !ruleClient(p) &&
            (INSTRUCTION.test(path.basename(p)) ||
              /[\\/]\.(agents|claude|cursor|codex)[\\/](knowledge|rules)[\\/]/.test(
                p,
              )),
        )
      )
        addContext(entry);
    }
  }

  return {
    context,
    rules,
    skills,
    skillCatalogClients,
    content,
    editable,
    addContext,
  };
}
