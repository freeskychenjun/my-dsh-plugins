/**
 * Pure skill-inventory logic for dsh-skill-manager.
 *
 * Mirrors @deepseek-ai/dsh-skill-filesystem discovery semantics:
 * - roots ranked 100..500 (project-dsh, project-agents, custom, user-dsh, user-agents);
 * - a skill is `<root>/<name>/SKILL.md` (bundle) or `<root>/<name>.md` (flat);
 * - frontmatter: name (kebab-case, required), description (required), whenToUse,
 *   disable-model-invocation / user-invocable (strict boolean spellings);
 * - lower rank wins a duplicated name; losers are "shadowed".
 *
 * No cordis imports so the module stays unit-testable with plain node.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SKILL_MD_BYTES = 1024 * 1024;

/** Root ranks, matching dsh-skill-filesystem constants. */
export const ROOT_RANKS = {
  'project-dsh': 100,
  'project-agents': 200,
  custom: 300,
  'user-dsh': 400,
  'user-agents': 500,
};

const ROOT_LABELS_ZH = {
  'project-dsh': '项目 .dsh/skills',
  'project-agents': '项目 .agents/skills',
  'user-dsh': '用户 ~/.dsh/skills',
  'user-agents': '用户 ~/.agents/skills',
};

// ─── frontmatter parsing ────────────────────────────────────────────────────

/** Split a SKILL.md into frontmatter text + body. Returns undefined when absent. */
export function splitFrontmatter(content) {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (match === null) return undefined;
  return { fmText: match[1], body: content.slice(match[0].length) };
}

function unescapeDoubleQuoted(inner) {
  return inner.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, g) => {
    if (g === 'n') return '\n';
    if (g === 't') return '\t';
    if (g === 'r') return '\r';
    if (g === '0') return '\0';
    if (g[0] === 'u' || g[0] === 'x') {
      const hex = g.replace(/[ux{}]/g, '');
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : g;
    }
    return g;
  });
}

/**
 * Parse frontmatter text into ordered fields.
 * A field is { key, line, kind } with kind:
 *  - 'scalar'  → value.text holds the scalar text (block scalars folded, quotes resolved)
 *  - 'complex' → nested mapping / flow collection / unresolvable value
 *  - 'unknown' → line that is not a `key: value` mapping at top level
 *
 * Handles the YAML subset the provider accepts for scalar fields: plain
 * scalars, single/double-quoted (incl. multi-line continuation), and `>` / `|`
 * block scalars with chomping indicators.
 */
export function parseFrontmatterFields(fmText) {
  const lines = fmText.split(/\r?\n/);
  const fields = [];
  let i = 0;
  const isIndented = line => /^[ \t]+\S/.test(line);
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) { i += 1; continue; }
    const match = /^([A-Za-z0-9_.-]+):(?:[ \t]*(.*))?$/.exec(line);
    if (match === null) {
      fields.push({ key: null, line: i, endLine: i, kind: 'unknown', raw: line });
      i += 1;
      continue;
    }
    const key = match[1];
    const raw = (match[2] ?? '').trim();
    const keyLine = i;

    if (raw === '') {
      // Nested mapping / flow collection on following lines → complex.
      const next = lines[i + 1] ?? '';
      if (isIndented(next)) {
        i += 2;
        while (i < lines.length && (lines[i].trim() === '' || isIndented(lines[i]))) i += 1;
        fields.push({ key, line: keyLine, endLine: i - 1, kind: 'complex' });
        continue;
      }
      fields.push({ key, line: keyLine, endLine: keyLine, kind: 'scalar', text: '' });
      i += 1;
      continue;
    }
    if (raw.startsWith('|') || raw.startsWith('>')) {
      const header = raw;
      const blockLines = [];
      i += 1;
      while (i < lines.length) {
        const ln = lines[i];
        if (ln.trim() === '') { blockLines.push(''); i += 1; continue; }
        if (isIndented(ln)) { blockLines.push(ln.replace(/^[ \t]+/, '')); i += 1; continue; }
        break;
      }
      let text;
      if (header.startsWith('>')) {
        // Folded: single line break → space; blank line → newline.
        const parts = [];
        let pendingBlank = 0;
        for (const blockLine of blockLines) {
          if (blockLine === '') { pendingBlank += 1; continue; }
          if (parts.length > 0) parts.push(pendingBlank > 0 ? '\n' : ' ');
          pendingBlank = 0;
          parts.push(blockLine);
        }
        text = parts.join('');
      } else {
        text = blockLines.join('\n');
      }
      const indicator = header.replace(/[0-9]/g, '');
      if (indicator.endsWith('-')) text = text.replace(/\n+$/, '');
      else text = text.replace(/\n+$/, '\n');
      text = text.replace(/^\n+/, '');
      fields.push({ key, line: keyLine, endLine: i - 1, kind: 'scalar', text });
      continue;
    }
    if (raw.startsWith('"') || raw.startsWith("'")) {
      const parsed = parseQuotedScalar(raw, lines, i);
      if (parsed !== undefined) {
        fields.push({ key, line: keyLine, endLine: parsed.endLine, kind: 'scalar', text: parsed.text });
        i = parsed.endLine + 1;
        continue;
      }
      fields.push({ key, line: keyLine, endLine: keyLine, kind: 'complex' });
      i += 1;
      continue;
    }
    fields.push({ key, line: keyLine, endLine: keyLine, kind: 'scalar', text: raw });
    i += 1;
  }
  return fields;
}

/** Termination index of a quoted scalar starting in `line` (ignoring escapes), or -1. */
function closingQuoteIndex(line, quote) {
  if (quote === '"') {
    for (let index = 1; index < line.length; index += 1) {
      if (line[index] === '\\') { index += 1; continue; }
      if (line[index] === '"') return index;
    }
    return -1;
  }
  for (let index = 1; index < line.length; index += 1) {
    if (line[index] === "'") {
      if (line[index + 1] === "'") { index += 1; continue; }
      return index;
    }
  }
  return -1;
}

/**
 * Parse a quoted scalar that may continue across lines (YAML folding: parts
 * joined with a space, leading whitespace of continuation lines stripped).
 * `firstValue` is the already-trimmed value that starts with the quote.
 * Returns { text, endLine } or undefined when it never terminates cleanly.
 */
function parseQuotedScalar(firstValue, lines, startLine) {
  const quote = firstValue[0];
  const parts = [];
  let line = firstValue;
  let offset = startLine;
  let first = true;
  for (;;) {
    const close = closingQuoteIndex(line, quote);
    if (close !== -1) {
      const inner = line.slice(first ? 1 : 0, close);
      const trailing = line.slice(close + 1).trim();
      if (trailing !== '' && !trailing.startsWith('#')) return undefined;
      parts.push(inner);
      const text = parts.join(' ');
      return {
        text: quote === '"' ? unescapeDoubleQuoted(text) : text.replace(/''/g, "'"),
        endLine: offset,
      };
    }
    parts.push(line.slice(first ? 1 : 0));
    first = false;
    offset += 1;
    if (offset >= lines.length) return undefined;
    const next = lines[offset];
    if (next.trim() === '') { parts.push('\n'); line = ''; continue; }
    if (!isIndentedLine(next)) return undefined;
    line = next.replace(/^[ \t]+/, '');
  }
}

function isIndentedLine(line) {
  return /^[ \t]+\S/.test(line);
}

/** Boolean spelling rules replicated from dsh-skill-filesystem frontmatterBoolean. */
export function parseFrontmatterBoolean(fields, key) {
  const field = fields.find(f => f.key === key);
  if (field === undefined) return { state: 'absent' };
  if (field.kind !== 'scalar') return { state: 'error', problem: `frontmatter 字段 "${key}" 必须是布尔值` };
  const value = field.text;
  if (value === 'true' || value === '1') return { state: 'present', value: true };
  if (value === 'false' || value === '0') return { state: 'present', value: false };
  const lowered = value.toLowerCase();
  if (lowered === 'true' || lowered === 'yes' || lowered === 'on') return { state: 'present', value: true };
  if (lowered === 'false' || lowered === 'no' || lowered === 'off') return { state: 'present', value: false };
  return { state: 'error', problem: `frontmatter 字段 "${key}" 必须是布尔值（当前值: ${JSON.stringify(value.slice(0, 40))}）` };
}

/**
 * Validate one parsed frontmatter exactly the way the provider does.
 * Returns { valid, problems, name, description, whenToUse, modelInvocable, userInvocable }.
 */
export function validateFrontmatter(fields) {
  const problems = [];
  for (const legacy of ['disableModelInvocation', 'modelInvocable', 'userInvocable']) {
    if (fields.some(f => f.key === legacy)) {
      const canonical = legacy === 'userInvocable' ? 'user-invocable' : 'disable-model-invocation';
      problems.push(`frontmatter 字段 "${legacy}" 不受支持，请改用 "${canonical}"`);
    }
  }
  const scalarText = (key) => {
    const field = fields.find(f => f.key === key);
    if (field === undefined) return undefined;
    if (field.kind !== 'scalar') return undefined;
    return field.text;
  };
  const name = scalarText('name');
  const description = scalarText('description');
  const whenToUse = scalarText('whenToUse');
  if (fields.some(f => f.key === 'name') && name === undefined) problems.push('name 不是纯文本标量');
  if (fields.some(f => f.key === 'description') && description === undefined) problems.push('description 不是纯文本标量');
  if (name === undefined || name === '') problems.push('缺少必填字段 name');
  if (description === undefined || description === '') problems.push('缺少必填字段 description');
  if (name !== undefined && name !== '' && !SKILL_NAME_RE.test(name)) problems.push(`name "${name}" 不是合法的 kebab-case`);
  const disableModel = parseFrontmatterBoolean(fields, 'disable-model-invocation');
  if (disableModel.state === 'error') problems.push(disableModel.problem);
  const userInvocable = parseFrontmatterBoolean(fields, 'user-invocable');
  if (userInvocable.state === 'error') problems.push(userInvocable.problem);
  return {
    valid: problems.length === 0,
    problems,
    name: name === '' ? undefined : name,
    description: description === '' ? undefined : description,
    whenToUse: whenToUse === '' ? undefined : whenToUse,
    modelInvocable: disableModel.state === 'present' ? disableModel.value !== true : true,
    userInvocable: userInvocable.state === 'present' ? userInvocable.value !== false : true,
  };
}

/** Parse a full SKILL.md. Returns { exists: true, valid, problems, ... } shape. */
export function parseSkillFile(content) {
  const split = splitFrontmatter(content);
  if (split === undefined) {
    return { valid: false, problems: ['缺少 YAML frontmatter（文件须以 --- 开始）'], kind: 'nofm' };
  }
  const fields = parseFrontmatterFields(split.fmText);
  const validated = validateFrontmatter(fields);
  return { ...validated, kind: 'ok' };
}

// ─── frontmatter serialization ──────────────────────────────────────────────

/** Quote a scalar for YAML output when needed; plain otherwise. */
export function yamlScalar(value) {
  if (value === '') return '""';
  if (
    /[:#\n"'&*!|>%@`{}[\],]/.test(value) ||
    /^\s|\s$/u.test(value) ||
    /^(?:true|false|yes|no|on|off|null|~)$/i.test(value) ||
    /^[-?] /.test(value) ||
    /^[-+.]?\d/.test(value)
  ) {
    return JSON.stringify(value);
  }
  return value;
}

/**
 * Rewrite the two invocation keys inside fmText, preserving every other line
 * (including block-scalar values, nested mappings and comments).
 * A `true` value is written as `<key>: true`; `false` lines are dropped.
 * Insertion anchors to the END of the description field's value block so a
 * folded/literal description is never split.
 */
export function rewriteInvocationKeys(fmText, { disableModelInvocation, userInvocable }) {
  const lines = fmText.split(/\r?\n/);
  const fields = parseFrontmatterFields(fmText);
  const dropKeys = new Set(['disable-model-invocation', 'user-invocable']);
  const dropped = new Set();
  for (const field of fields) {
    if (!dropKeys.has(field.key)) continue;
    for (let i = field.line; i <= (field.endLine ?? field.line); i += 1) dropped.add(i);
  }
  const insertions = [];
  if (disableModelInvocation === true) insertions.push('disable-model-invocation: true');
  if (userInvocable === false) insertions.push('user-invocable: false');
  let insertAt = -1;
  if (insertions.length > 0) {
    for (const anchor of ['description', 'name']) {
      const field = fields.find(f => f.key === anchor && !dropped.has(f.line));
      if (field !== undefined) { insertAt = field.endLine ?? field.line; break; }
    }
  }
  const out = [];
  let inserted = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (dropped.has(i)) continue;
    out.push(lines[i]);
    if (!inserted && insertions.length > 0 && i === insertAt) {
      out.push(...insertions);
      inserted = true;
    }
  }
  if (!inserted && insertions.length > 0) out.unshift(...insertions);
  return out.join('\n');
}

/** Apply invocation changes to a full SKILL.md document; returns new content. */
export function applyInvocationToContent(content, changes) {
  const split = splitFrontmatter(content);
  if (split === undefined) throw new Error('文件缺少 YAML frontmatter，无法修改调用策略');
  const fields = parseFrontmatterFields(split.fmText);
  const validated = validateFrontmatter(fields);
  if (!validated.valid) throw new Error(`frontmatter 无效：${validated.problems.join('；')}`);
  let nextFm = rewriteInvocationKeys(split.fmText, changes);
  // Preserve the file's dominant line ending (body slice keeps its own bytes).
  const nl = content.includes('\r\n') ? '\r\n' : '\n';
  if (nl === '\r\n') nextFm = nextFm.replace(/\n/g, '\r\n');
  return ['---', nextFm, '---', split.body].join(nl);
}

/** Build a brand-new SKILL.md document. */
export function buildSkillDocument({ name, description, whenToUse, body, disableModelInvocation, userInvocable }) {
  const lines = [
    '---',
    `name: ${name}`,
    `description: ${yamlScalar(description)}`,
  ];
  if (whenToUse !== undefined && whenToUse !== '') lines.push(`whenToUse: ${yamlScalar(whenToUse)}`);
  if (disableModelInvocation === true) lines.push('disable-model-invocation: true');
  if (userInvocable === false) lines.push('user-invocable: false');
  lines.push('---', '');
  const text = body === undefined || body === '' ? `# ${name}\n` : body;
  return `${lines.join('\n')}\n${text}`;
}

// ─── root resolution & scanning ─────────────────────────────────────────────

/** Build the root list from resolved config, mirroring provider precedence. */
export function buildRoots({ dshHome, agentsHome, customSkillDirs, includeDefaultRoots, projectRoot }) {
  const roots = [];
  const home = homedir();
  const dsh = dshHome || process.env.DSH_HOME || join(home, '.dsh');
  const agents = agentsHome || process.env.DSH_AGENTS_HOME || join(home, '.agents');
  if (includeDefaultRoots !== false) {
    if (projectRoot !== undefined && projectRoot !== '') {
      roots.push({ id: 'project-dsh', label: ROOT_LABELS_ZH['project-dsh'], path: join(projectRoot, '.dsh', 'skills'), rank: ROOT_RANKS['project-dsh'], kind: 'default' });
      roots.push({ id: 'project-agents', label: ROOT_LABELS_ZH['project-agents'], path: join(projectRoot, '.agents', 'skills'), rank: ROOT_RANKS['project-agents'], kind: 'default' });
    }
  }
  for (const dir of customSkillDirs) {
    if (typeof dir !== 'string' || dir.trim() === '') continue;
    roots.push({ id: `custom-${dir}`, label: `自定义 ${dir}`, path: resolve(dir), rank: ROOT_RANKS.custom, kind: 'custom' });
  }
  if (includeDefaultRoots !== false) {
    roots.push({ id: 'user-dsh', label: ROOT_LABELS_ZH['user-dsh'], path: join(dsh, 'skills'), rank: ROOT_RANKS['user-dsh'], kind: 'default' });
    roots.push({ id: 'user-agents', label: ROOT_LABELS_ZH['user-agents'], path: join(agents, 'skills'), rank: ROOT_RANKS['user-agents'], kind: 'default' });
  }
  // De-duplicate identical paths, first occurrence wins.
  const seen = new Set();
  return roots.filter(root => {
    const key = root.path.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function safeStat(target) {
  try { return await stat(target); } catch { return undefined; }
}

/**
 * Scan one root directory and return raw entries (valid or not).
 * `kind`: 'bundle' | 'flat'.
 */
export async function scanRoot(root) {
  const rootStat = await safeStat(root.path);
  if (rootStat === undefined || !rootStat.isDirectory()) return { root, exists: false, entries: [] };
  let dirents;
  try {
    dirents = await readdir(root.path, { withFileTypes: true });
  } catch (error) {
    return { root, exists: true, entries: [], problem: `无法读取目录：${error.message}` };
  }
  const entries = [];
  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) continue;
    if (dirent.isDirectory()) {
      const skillMd = join(root.path, dirent.name, 'SKILL.md');
      const info = await safeStat(skillMd);
      if (info === undefined || !info.isFile()) continue;
      entries.push({ locator: dirent.name, kind: 'bundle', dirPath: join(root.path, dirent.name), skillMdPath: skillMd, mtimeMs: info.mtimeMs, sizeBytes: info.size });
    } else if (dirent.isFile() && dirent.name.endsWith('.md')) {
      const skillMd = join(root.path, dirent.name);
      const info = await safeStat(skillMd);
      if (info === undefined) continue;
      entries.push({ locator: dirent.name.slice(0, -3), kind: 'flat', dirPath: root.path, skillMdPath: skillMd, mtimeMs: info.mtimeMs, sizeBytes: info.size });
    }
  }
  return { root, exists: true, entries };
}

/** Parse one discovered entry into a full inventory record. */
export async function readEntry(root, entry) {
  const record = {
    rootId: root.id,
    rootLabel: root.label,
    rank: root.rank,
    kind: entry.kind,
    locator: entry.locator,
    dirPath: entry.dirPath,
    skillMdPath: entry.skillMdPath,
    mtimeMs: entry.mtimeMs,
    sizeBytes: entry.sizeBytes,
    name: entry.locator,
    valid: true,
    problems: [],
    locatorMismatch: false,
  };
  if (entry.sizeBytes > MAX_SKILL_MD_BYTES) {
    return { ...record, valid: false, problems: [`文件超过 ${MAX_SKILL_MD_BYTES} 字节上限`] };
  }
  let content;
  try {
    content = await readFile(entry.skillMdPath, 'utf8');
  } catch (error) {
    return { ...record, valid: false, problems: [`读取失败：${error.message}`] };
  }
  const parsed = parseSkillFile(content);
  record.problems = parsed.problems ?? [];
  record.valid = parsed.valid;
  if (parsed.name !== undefined) record.name = parsed.name;
  if (parsed.description !== undefined) record.description = parsed.description;
  if (parsed.whenToUse !== undefined) record.whenToUse = parsed.whenToUse;
  if (parsed.modelInvocable !== undefined) record.modelInvocable = parsed.modelInvocable;
  if (parsed.userInvocable !== undefined) record.userInvocable = parsed.userInvocable;
  if (parsed.valid && parsed.name !== entry.locator) {
    record.locatorMismatch = true;
    record.problems.push(`目录/文件名 "${entry.locator}" 与 frontmatter name "${parsed.name}" 不一致（目录名只影响存放位置，技能名以 frontmatter 为准）`);
  }
  return record;
}

/** Scan every root and compute shadow relationships. Returns the inventory. */
export async function scanInventory(roots) {
  const results = await Promise.all(roots.map(root => scanRoot(root)));
  const rootStates = results.map(({ root, exists, problem }) => ({ id: root.id, label: root.label, path: root.path, rank: root.rank, exists, problem }));
  const records = [];
  for (const result of results) {
    for (const entry of result.entries) {
      records.push(await readEntry(result.root, entry));
    }
  }
  // Effective-name shadow resolution: lower rank wins; same rank keeps scan order.
  const byName = new Map();
  for (const record of records) {
    if (!record.valid) continue;
    const key = record.name;
    const current = byName.get(key);
    if (current === undefined || record.rank < current.rank) byName.set(key, record);
  }
  for (const record of records) {
    if (!record.valid) continue;
    const winner = byName.get(record.name);
    record.effective = winner === record;
    if (!record.effective) record.shadowedBy = { rootId: winner.rootId, rootLabel: winner.rootLabel, skillMdPath: winner.skillMdPath };
  }
  records.sort((a, b) => a.name.localeCompare(b.name) || a.rank - b.rank);
  const counts = new Map(rootStates.map(r => [r.id, 0]));
  for (const record of records) counts.set(record.rootId, (counts.get(record.rootId) ?? 0) + 1);
  for (const state of rootStates) state.count = counts.get(state.id) ?? 0;
  return { roots: rootStates, skills: records, generatedAt: new Date().toISOString() };
}
