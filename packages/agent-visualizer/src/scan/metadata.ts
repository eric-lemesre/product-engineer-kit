import path from "node:path";
import { parse as yaml } from "yaml";
import type { Client, Scope } from "../contracts.js";
import { inside, MARKDOWN, record, required, slash } from "./values.js";
export const ruleClient = (file: string): Client | null => {
  if (path.basename(file).toLowerCase() === ".cursorrules") return "cursor";
  if (!MARKDOWN.test(file)) return null;
  const normalized = slash(file).toLowerCase();
  if (/(^|\/)\.cursor\/rules\//.test(normalized)) return "cursor";
  if (/(^|\/)\.claude\/rules\//.test(normalized)) return "claude";
  if (
    /(^|\/)(?:\.github|\.copilot)\/instructions\/.+\.instructions\.md$/.test(
      normalized,
    )
  )
    return "copilot";
  return null;
};
export const toolsForSkill = (p: string): Client[] => {
  // Bundled Codex skills are not part of Cursor's third-party skill import.
  if (/(^|\/)\.codex\/skills\/\.system\//.test(p)) return ["codex"];
  const result: Client[] = [];
  if (/(^|\/)\.(agents|cursor|claude|codex)\/skills\//.test(p))
    result.push("cursor");
  if (/(^|\/)\.claude\/skills\//.test(p)) result.push("claude");
  if (/(^|\/)\.(agents|codex)\/skills\//.test(p)) result.push("codex");
  if (/(^|\/)\.(github|agents|claude|copilot)\/skills\//.test(p))
    result.push("copilot");
  return result;
};
/** Folders whose `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` make Claude Code skip `AGENTS.md`. */
export const claudeInstructionFolders = (
  aliases: Iterable<string>,
): Set<string> => {
  const folders = new Set<string>();
  for (const alias of aliases) {
    const name = path.basename(alias).toLowerCase();
    if (name !== "claude.md" && name !== "claude.local.md") continue;
    const folder = path.dirname(alias);
    folders.add(
      path.basename(folder) === ".claude" ? path.dirname(folder) : folder,
    );
  }
  return folders;
};
// Claude Code reads AGENTS.md only when no Claude instruction file exists in
// its folder or above it, up to the scan root (folders above it are not scanned).
const claudeReadsAgents = (
  alias: string,
  root: string,
  claudeFolders: ReadonlySet<string>,
): boolean => {
  let folder = path.dirname(alias);
  if (path.basename(folder) === ".claude") folder = path.dirname(folder);
  for (;;) {
    if (claudeFolders.has(folder)) return false;
    if (folder === root || !inside(root, folder)) return true;
    folder = path.dirname(folder);
  }
};
export const clientsForContextEntry = (
  alias: string,
  scope: Scope,
  root: string,
  codexHome: string,
  claudeFolders?: ReadonlySet<string>,
): Client[] => {
  const name = path.basename(alias).toLowerCase();
  if (name === "copilot-instructions.md")
    return /[\\/](?:\.github|\.copilot)[\\/]copilot-instructions\.md$/i.test(
      alias,
    )
      ? ["copilot"]
      : [];
  if (name === "agents.override.md") return ["codex"];
  if (name === "agents.md") {
    if (scope === "user")
      return inside(codexHome, alias) ? ["codex"] : ["cursor"];
    return claudeFolders && claudeReadsAgents(alias, root, claudeFolders)
      ? ["cursor", "codex", "copilot", "claude"]
      : ["cursor", "codex", "copilot"];
  }
  if (name === "claude.local.md") return ["claude"];
  if (name === "claude.md")
    return scope === "project" && path.dirname(alias) === root
      ? ["cursor", "claude"]
      : ["claude"];
  return [];
};
export function frontmatter(text: string): Record<string, unknown> {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  const result = yaml(required(match[1]), { maxAliasCount: 20 });
  return record(result);
}
export function links(text: string): { target: string; wiki: boolean }[] {
  const result = [];
  for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g))
    result.push({ target: required(m[1]).split("#")[0] ?? "", wiki: true });
  for (const m of text.matchAll(
    /\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+['"][^)]*)?\)/g,
  ))
    result.push({ target: required(m[1] || m[2]), wiki: false });
  for (const m of text.matchAll(
    /(?:`|@)((?:\.{0,2}\/|~\/)?[\w.\-/À-ž]+\.(?:md|mdc))(?=`|\s|$|[,;)])/g,
  ))
    result.push({ target: required(m[1]), wiki: false });
  return result;
}
