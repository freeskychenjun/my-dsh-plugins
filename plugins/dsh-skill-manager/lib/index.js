/**
 * dsh-skill-manager host half:
 * - GET  /list                          → full inventory across skill roots (with shadow info)
 * - GET  /read?path=…                   → SKILL.md content (fenced to skill roots)
 * - POST /save      {path, content}     → validate frontmatter, atomic write
 * - POST /create    {rootId, name, description, whenToUse, body, …} → new bundle skill
 * - POST /invocation {path, modelInvocable, userInvocable} → patch frontmatter keys
 * - POST /delete    {path}              → move skill into the plugin trash dir
 * - POST /reveal    {path}              → open Explorer with the file selected
 *
 * No cordis imports; injects webServer/loader like dsh-screenshot/dsh-paste-input.
 * Root discovery mirrors dsh-skill-filesystem (its resolved config is read from
 * the loader so customSkillDirs / homes always stay aligned).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import {
  MAX_SKILL_MD_BYTES,
  SKILL_NAME_RE,
  applyInvocationToContent,
  buildRoots,
  buildSkillDocument,
  parseSkillFile,
  scanInventory,
} from './skills.js';

export const name = 'dsh-skill-manager';
export const inject = ['webServer', 'loader'];

const API_ROOT = '/dsh-skill-manager/v1';
const MAX_BODY_BYTES = 4 * 1024 * 1024;

class UserError extends Error {}

// ─── shared HTTP helpers (same fence as dsh-screenshot) ─────────────────────

function header(headers, key) {
  const value = headers[key];
  return typeof value === 'string' ? value : undefined;
}

function authority(value) {
  try {
    return new URL(`http://${value}`);
  } catch {
    return undefined;
  }
}

function canonicalAuthority(raw, parsed) {
  const port = parsed.port !== '' ? parsed.port : new URL(`https://${raw}`).port;
  return port === '' ? parsed.hostname : `${parsed.hostname}:${port}`;
}

function isLoopback(hostname) {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.');
}

function trustedRequest(req, trustedHosts) {
  const host = header(req.headers, 'host');
  if (host === undefined) return false;
  const parsedHost = authority(host);
  if (parsedHost === undefined) return false;
  const listed = trustedHosts.some((entry) => {
    const parsed = authority(entry);
    if (parsed === undefined) return false;
    return canonicalAuthority(entry, parsed) === parsed.hostname
      ? parsed.hostname === parsedHost.hostname
      : parsed.host === parsedHost.host;
  });
  if (!isLoopback(parsedHost.hostname) && !listed) return false;
  if (header(req.headers, 'sec-fetch-site') === 'cross-site') return false;
  const origin = header(req.headers, 'origin');
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === parsedHost.host;
  } catch {
    return false;
  }
}

function trustedHosts(ctx) {
  try {
    for (const entry of ctx.loader.entries()) {
      if (entry.options.name !== '@deepseek-ai/dsh-client-connection') continue;
      const value = entry.fiber?.config?.trustedHosts;
      if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value;
    }
  } catch { /* fence falls back to loopback-only */ }
  return [];
}

function json(res, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
  });
  res.end(body);
}

function error(res, status, code, message) {
  json(res, status, { ok: false, error: { code, message } });
}

async function readJson(req, maxBytes = MAX_BODY_BYTES) {
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new UserError(`JSON body 超过 ${maxBytes} 字节上限`);
    parts.push(chunk);
  }
  const text = Buffer.concat(parts).toString('utf8');
  try {
    return JSON.parse(text === '' ? '{}' : text);
  } catch {
    throw new UserError('请求体不是合法 JSON');
  }
}

// ─── skill root plumbing ────────────────────────────────────────────────────

function skillFilesystemConfig(ctx) {
  const fallback = { dshHome: undefined, agentsHome: undefined, customSkillDirs: [], includeDefaultRoots: true };
  try {
    for (const entry of ctx.loader.entries()) {
      if (entry.options?.name !== '@deepseek-ai/dsh-skill-filesystem') continue;
      const config = entry.fiber?.config ?? {};
      return {
        dshHome: typeof config.dshHome === 'string' && config.dshHome !== '' ? config.dshHome : undefined,
        agentsHome: typeof config.agentsHome === 'string' && config.agentsHome !== '' ? config.agentsHome : undefined,
        customSkillDirs: Array.isArray(config.customSkillDirs)
          ? config.customSkillDirs.filter(item => typeof item === 'string' && item.trim() !== '')
          : [],
        includeDefaultRoots: config.includeDefaultRoots !== false,
      };
    }
  } catch { /* fall back to defaults */ }
  return fallback;
}

function nearestGitRoot(start) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

function currentRoots(ctx, cwd) {
  let projectRoot;
  if (typeof cwd === 'string' && cwd.trim() !== '') projectRoot = nearestGitRoot(resolve(cwd));
  const config = skillFilesystemConfig(ctx);
  return buildRoots({ ...config, projectRoot });
}

/**
 * Fence: a managed md must be `<root>/<name>.md` (flat, not SKILL.md itself)
 * or `<root>/<dir>/SKILL.md` (bundle). Returns { root, kind } or undefined.
 */
function locateSkillMd(roots, rawPath) {
  const target = resolve(String(rawPath ?? ''));
  for (const root of roots) {
    const rel = relative(resolve(root.path), target);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) continue;
    const parts = rel.split(sep);
    if (parts.length === 1 && parts[0].endsWith('.md') && parts[0].toLowerCase() !== 'skill.md') {
      return { root, kind: 'flat' };
    }
    if (parts.length === 2 && parts[1] === 'SKILL.md') return { root, kind: 'bundle' };
  }
  return undefined;
}

async function atomicWrite(target, content) {
  const tmp = `${target}.dsh-skill-manager.tmp`;
  await writeFile(tmp, content, 'utf8');
  try {
    await rename(tmp, target);
  } catch (cause) {
    // Windows rename-over can race with watchers/AV: retry once via direct write.
    await rm(tmp, { force: true }).catch(() => {});
    try {
      await writeFile(target, content, 'utf8');
    } catch {
      throw new UserError(`写入失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
}

function trashRoot() {
  return join(homedir(), '.dsh', 'dsh-skill-manager', 'trash');
}

// ─── request handlers ───────────────────────────────────────────────────────

export function apply(ctx) {
  const logger = ctx.logger;
  const handleList = async (url) => {
    const cwd = url.searchParams.get('cwd') ?? undefined;
    const roots = currentRoots(ctx, cwd);
    const inventory = await scanInventory(roots);
    return { inventory, trashDir: trashRoot() };
  };

  const handleRead = async (url) => {
    const path = url.searchParams.get('path') ?? '';
    const roots = currentRoots(ctx);
    const located = locateSkillMd(roots, path);
    if (located === undefined) throw new UserError('该文件不在任何技能根目录的第一层内');
    const target = resolve(path);
    let content;
    try {
      content = await readFile(target, 'utf8');
    } catch (cause) {
      throw new UserError(`读取失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (content.length > MAX_SKILL_MD_BYTES) throw new UserError('文件超过读取上限');
    return { path: target, content };
  };

  const handleSave = async (input) => {
    if (typeof input.path !== 'string' || typeof input.content !== 'string') throw new UserError('path 与 content 必填');
    const roots = currentRoots(ctx);
    const located = locateSkillMd(roots, input.path);
    if (located === undefined) throw new UserError('该文件不在任何技能根目录的第一层内');
    if (input.content.length > MAX_SKILL_MD_BYTES) throw new UserError('内容超过大小上限');
    const parsed = parseSkillFile(input.content);
    if (!parsed.valid) throw new UserError(`frontmatter 校验未通过：${parsed.problems.join('；')}`);
    const target = resolve(input.path);
    await atomicWrite(target, input.content);
    logger?.info?.(`dsh-skill-manager: saved ${target}`);
    return { path: target, name: parsed.name };
  };

  const handleCreate = async (input) => {
    const name = String(input.name ?? '').trim();
    const description = String(input.description ?? '').trim();
    const whenToUse = String(input.whenToUse ?? '').trim();
    if (!SKILL_NAME_RE.test(name)) throw new UserError('技能名必须是 kebab-case（小写字母、数字、连字符）');
    if (description === '') throw new UserError('description 必填');
    const roots = currentRoots(ctx);
    const root = roots.find(r => r.id === input.rootId);
    if (root === undefined) throw new UserError('未知的技能根目录，请刷新后重试');
    const dir = join(root.path, name);
    const skillMd = join(dir, 'SKILL.md');
    if (existsSync(dir)) throw new UserError(`目录已存在：${dir}`);
    const document = buildSkillDocument({
      name,
      description,
      whenToUse: whenToUse === '' ? undefined : whenToUse,
      body: typeof input.body === 'string' && input.body.trim() !== '' ? input.body : undefined,
      disableModelInvocation: input.disableModelInvocation === true,
      userInvocable: input.userInvocable === false ? false : true,
    });
    await mkdir(dir, { recursive: true });
    await atomicWrite(skillMd, document);
    logger?.info?.(`dsh-skill-manager: created ${skillMd}`);
    return { skillMdPath: skillMd, dirPath: dir, rootId: root.id };
  };

  const handleInvocation = async (input) => {
    if (typeof input.path !== 'string') throw new UserError('path 必填');
    const modelInvocable = input.modelInvocable === true;
    const userInvocable = input.userInvocable !== false;
    const roots = currentRoots(ctx);
    const located = locateSkillMd(roots, input.path);
    if (located === undefined) throw new UserError('该文件不在任何技能根目录的第一层内');
    const target = resolve(input.path);
    const original = await readFile(target, 'utf8');
    const next = applyInvocationToContent(original, {
      disableModelInvocation: !modelInvocable,
      userInvocable,
    });
    await atomicWrite(target, next);
    logger?.info?.(`dsh-skill-manager: invocation ${target} model=${modelInvocable} user=${userInvocable}`);
    return { path: target };
  };

  const handleDelete = async (input) => {
    if (typeof input.path !== 'string') throw new UserError('path 必填');
    const roots = currentRoots(ctx);
    const located = locateSkillMd(roots, input.path);
    if (located === undefined) throw new UserError('该文件不在任何技能根目录的第一层内');
    const skillMd = resolve(input.path);
    const victim = located.kind === 'bundle' ? dirname(skillMd) : skillMd;
    if (!existsSync(victim)) throw new UserError('目标不存在（可能已被删除，请刷新）');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const trash = join(trashRoot(), `${stamp}-${basename(victim)}`);
    await mkdir(trashRoot(), { recursive: true });
    try {
      await rename(victim, trash);
    } catch (cause) {
      throw new UserError(`移入回收站失败：${cause instanceof Error ? cause.message : String(cause)}（文件可能被占用，关闭占用程序后重试）`);
    }
    logger?.info?.(`dsh-skill-manager: moved ${victim} → ${trash}`);
    return { trashPath: trash, originalPath: victim };
  };

  const handleReveal = async (input) => {
    if (typeof input.path !== 'string') throw new UserError('path 必填');
    const roots = currentRoots(ctx);
    const located = locateSkillMd(roots, input.path);
    if (located === undefined) throw new UserError('该文件不在任何技能根目录的第一层内');
    if (process.platform !== 'win32') throw new UserError('仅支持 Windows');
    const target = resolve(input.path);
    spawn('explorer.exe', [`/select,${target}`], { detached: true, stdio: 'ignore' }).unref();
    return { revealed: target };
  };

  const route = async (req, res) => {
    if (!trustedRequest(req, trustedHosts(ctx))) {
      error(res, 403, 'forbidden', 'request failed the DSH Host/Origin trust fence');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://dsh.internal');
    const suffix = url.pathname.slice(API_ROOT.length);
    try {
      if (req.method === 'GET' && suffix === '/health') {
        json(res, 200, { ok: true, plugin: name, protocol: 1 });
        return;
      }
      if (req.method === 'GET' && suffix === '/list') {
        json(res, 200, { ok: true, ...(await handleList(url)) });
        return;
      }
      if (req.method === 'GET' && suffix === '/read') {
        json(res, 200, { ok: true, ...(await handleRead(url)) });
        return;
      }
      if (req.method === 'POST' && suffix === '/save') {
        json(res, 200, { ok: true, ...(await handleSave(await readJson(req))) });
        return;
      }
      if (req.method === 'POST' && suffix === '/create') {
        json(res, 200, { ok: true, ...(await handleCreate(await readJson(req))) });
        return;
      }
      if (req.method === 'POST' && suffix === '/invocation') {
        json(res, 200, { ok: true, ...(await handleInvocation(await readJson(req))) });
        return;
      }
      if (req.method === 'POST' && suffix === '/delete') {
        json(res, 200, { ok: true, ...(await handleDelete(await readJson(req))) });
        return;
      }
      if (req.method === 'POST' && suffix === '/reveal') {
        json(res, 200, { ok: true, ...(await handleReveal(await readJson(req))) });
        return;
      }
      error(res, 404, 'not-found', 'unknown skill-manager endpoint');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const status = cause instanceof UserError ? 400 : 500;
      error(res, status, 'skill-manager-request-failed', message);
    }
  };

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: API_ROOT, handler: route }),
    'dsh-skill-manager: route',
  );
}

// Exported for unit tests only; not part of the plugin contract.
export { locateSkillMd };

