/**
 * dsh-screenshot host half:
 * - POST /launch        → spawn the configured screenshot tool (Windows)
 * - POST /clipboard     → snapshot the clipboard image (PS 5.1, STA), cache PNG by hash
 * - GET  /clipboard/data?hash=… → serve a cached PNG snapshot
 *
 * No cordis imports; injects webServer/loader/sessions like dsh-paste-input.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export const name = 'dsh-screenshot';
export const inject = ['webServer', 'loader', 'sessions'];

const API_ROOT = '/dsh-screenshot/v1';
const POLL_TIMEOUT_MS = 12_000;
const MAX_INGEST_BYTES = 128 * 1024 * 1024;

function sessionDirectoryName(sessionId) {
  // Mirrors dsh-paste-input's slug+digest layout so attachments from both
  // plugins land under the same session key namespace.
  const slug = sessionId.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 48) || 'session';
  const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 12);
  return `${slug}-${digest}`;
}

async function readRawBody(req, maxBytes) {
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error(`body exceeds ${maxBytes} bytes`);
    parts.push(chunk);
  }
  return Buffer.concat(parts);
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

async function readJson(req, maxBytes = 64 * 1024) {
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error(`JSON body exceeds ${maxBytes} bytes`);
    parts.push(chunk);
  }
  const text = Buffer.concat(parts).toString('utf8');
  return JSON.parse(text === '' ? '{}' : text);
}

function runPowerShell(script, timeoutMs) {
  return new Promise((resolvePowerShell, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('killed');
      reject(new Error(`clipboard probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`clipboard probe exited ${code}: ${err.trim().slice(0, 400)}`));
      else resolvePowerShell(out.trim());
    });
  });
}

const CLIPBOARD_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# Bitmap clipboard only (CF_BITMAP/CF_DIB via GetImage). Free-form snips —
# which expose themselves solely as registered PNG formats — are NOT
# supported on purpose (user request): they yield NOIMAGE here and the
# capture falls through to the fast cancel path.
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img -eq $null) { 'NOIMAGE' }
else {
  $ms = New-Object System.IO.MemoryStream
  $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $ms.ToArray()
  $ms.Dispose()
  $img.Dispose()
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLower()
  $sha.Dispose()
  $path = Join-Path $env:TEMP ("dsh-shot-" + $hash + ".png")
  [System.IO.File]::WriteAllBytes($path, $bytes)
  "OK $hash $($bytes.Length) $path"
}
`.trim();

// Window visibility control: hide the DSH desktop window while capturing so
// it never appears in the screenshot, restore right after. Implemented with
// Win32 ShowWindow over the top-level windows of the configured process
// (default: the DeepSeek Harness desktop app). Best-effort everywhere.
const WINDOW_HELPER = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class DshShotWin {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  const uint GWL_OWNER_CAN_IGNORE = 0;
  public static string Hide(long[] pids) {
    var set = new HashSet<long>(pids); var hidden = new List<long>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (set.Contains(pid) && IsWindowVisible(h) && GetWindowTextLength(h) > 0) {
        if (ShowWindow(h, 0)) hidden.Add(h.ToInt64());
      }
      return true;
    }, IntPtr.Zero);
    return string.Join(",", hidden);
  }
  public static void Show(long[] handles, int mode) {
    var first = true;
    foreach (var value in handles) {
      var h = new IntPtr(value);
      // mode 9 = SW_RESTORE + foreground (capture done, focus wanted).
      // mode 4 = SW_SHOWNOACTIVATE: cancel/timeout fallback must never steal
      // focus — the snip overlay may still be mid-drawing on top.
      if (ShowWindow(h, mode) && first && mode == 9) { SetForegroundWindow(h); first = false; }
    }
  }
}
`.trim();

function runWindowHelper(method, args) {
  const script = `Add-Type -TypeDefinition @'\n${WINDOW_HELPER}\n'@; [DshShotWin]::${method}(${args})`;
  return runPowerShell(script, 8_000);
}

export function apply(ctx, config = {}) {
  // Cached PNG snapshots: hash → { buffer, createdAt }. Small LRU (screenshots only).
  const cache = new Map();
  const CACHE_MAX = 8;

  // Window hide state: handles hidden for the current capture, auto-restore
  // deadline. Only restored handles we hid ourselves.
  let hiddenHandles = [];
  let restoreTimer = null;

  const restoreWindows = async (activate = true) => {
    if (restoreTimer !== null) { clearTimeout(restoreTimer); restoreTimer = null; }
    const handles = hiddenHandles;
    hiddenHandles = [];
    if (handles.length === 0) return { restored: 0 };
    try {
      await runWindowHelper('Show', `[long[]]@(${handles.join(',')}), ${activate === false ? 4 : 9}`);
    } catch (cause) {
      ctx.logger?.warn?.(`dsh-screenshot: window restore failed: ${cause?.message ?? cause}`);
    }
    return { restored: handles.length };
  };

  const scheduleAutoRestore = (ms) => {
    if (restoreTimer !== null) clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => { void restoreWindows(false); }, ms);
    restoreTimer.unref?.();
  };

  // Cancel detection: watch the screenshot tool's process. When it appears
  // and then exits without a new clipboard image (user pressed Esc / closed
  // the snip overlay), restore the window right away instead of waiting for
  // the long timeouts. Only enabled for ms-screenclip by default (the
  // ScreenClippingHost process is a reliable lifecycle signal); other tools
  // can opt in via config.watchProcess.
  let toolDone = false;
  let toolWatcher = null;

  const stopToolWatcher = () => {
    if (toolWatcher !== null) { clearInterval(toolWatcher); toolWatcher = null; }
  };

  const startToolWatcher = (command) => {
    stopToolWatcher();
    toolDone = false;
    // The snip flow may hand over between family processes across mode
    // switches (overlay respawns / opens the editor), so treat the capture
    // as alive while ANY of them is running, not just the launcher's host.
    const names = Array.isArray(config.watchProcesses) && config.watchProcesses.every(n => typeof n === 'string') && config.watchProcesses.length > 0
      ? config.watchProcesses
      : (command.includes('ms-screenclip')
        ? ['ScreenClippingHost', 'SnippingTool', 'ScreenSketch']
        : null);
    if (names === null) return;
    const safeList = names.map(n => `'${n.replaceAll("'", "''")}'`).join(',');
    const probe = `if (Get-Process -Name ${safeList} -ErrorAction SilentlyContinue) { 'YES' } else { 'NO' }`;
    let seen = false;
    let consecutiveNo = 0;
    const startedAt = Date.now();
    toolWatcher = setInterval(async () => {
      if (toolDone) { stopToolWatcher(); return; }
      try {
        const out = await runPowerShell(probe, 5_000);
        if (out === 'YES') {
          seen = true;
          consecutiveNo = 0;
        } else if (seen) {
          // Possible tool exit: require several consecutive NO probes, then a
          // grace period for the clipboard. If the image lands, the fresh-
          // snapshot path restores the window (activating) and this timer
          // becomes a no-op; a still-hidden window after grace is a real
          // cancel — restore WITHOUT activation so a false positive can
          // never steal focus from an in-progress overlay.
          consecutiveNo += 1;
          if (consecutiveNo >= 3) {
            stopToolWatcher();
            const cancelTimer = setTimeout(() => {
              if (hiddenHandles.length > 0) {
                toolDone = true;
                void restoreWindows(false);
              }
            }, 5_000);
            cancelTimer.unref?.();
          }
        } else if (Date.now() - startedAt > 20_000) {
          // Tool never showed up (e.g. custom command without a matching
          // process); stop watching and fall back to the normal timeouts.
          stopToolWatcher();
        }
      } catch { /* probe failures are non-fatal */ }
    }, 1_200);
    toolWatcher.unref?.();
  };

  const hideWindows = async () => {
    if (config.hideWindow === false) return false;
    const processName = typeof config.hideProcessName === 'string' && config.hideProcessName !== ''
      ? config.hideProcessName
      : 'DeepSeek Harness';
    const safeName = processName.replaceAll("'", "''");
    const script = [
      `Add-Type -TypeDefinition @'\n${WINDOW_HELPER}\n'@`,
      `$p = Get-Process -Name '${safeName}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`,
      `if ($p) { [DshShotWin]::Hide([long[]]@($p)) } else { '' }`,
    ].join('; ');
    try {
      const raw = await runPowerShell(script, 10_000);
      hiddenHandles = raw.split(',').filter(Boolean).map(Number).filter(Number.isSafeInteger);
      return hiddenHandles.length > 0;
    } catch {
      return false;
    }
  };

  const remember = (hash, buffer) => {
    cache.set(hash, { buffer, createdAt: Date.now() });
    while (cache.size > CACHE_MAX) {
      const oldest = [...cache.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      for (const [key, value] of cache) {
        if (value === oldest) cache.delete(key);
      }
    }
  };

  const snapshotClipboard = async () => {
    const raw = await runPowerShell(CLIPBOARD_SCRIPT, POLL_TIMEOUT_MS);
    if (raw === 'NOIMAGE') return { hasImage: false };
    const match = /^OK ([0-9a-f]{64}) (\d+) (.+?)\s*$/.exec(raw);
    if (match === null) throw new Error(`unexpected clipboard probe output: ${raw.slice(0, 200)}`);
    const [, hash, lengthText, path] = match;
    if (!cache.has(hash)) {
      const buffer = await readFile(path);
      remember(hash, buffer);
      await rm(path, { force: true }).catch(() => {});
      return { hasImage: true, hash, size: Number(lengthText), fresh: true };
    }
    return { hasImage: true, hash, size: Number(lengthText), fresh: false };
  };

  const launchScreenshotTool = async () => {
    const command = typeof config.command === 'string' && config.command.trim() !== ''
      ? config.command.trim()
      : 'explorer.exe ms-screenclip:';
    // Hide the DSH window first so the screenshot never contains it, then
    // start the capture tool. Safety net: auto-restore after 90 s no matter
    // what (client also restores on success/cancel/failure).
    const hidden = await hideWindows();
    if (hidden) scheduleAutoRestore(90_000);
    startToolWatcher(command);
    await new Promise((resolveLaunch, reject) => {
      const child = spawn(command, { shell: true, detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolveLaunch();
      });
    });
    return { command, hidden };
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
      if (req.method === 'POST' && suffix === '/launch') {
        await readJson(req);
        const result = await launchScreenshotTool();
        json(res, 200, { ok: true, ...result });
        return;
      }
      if (req.method === 'POST' && suffix === '/clipboard') {
        await readJson(req);
        const snapshot = await snapshotClipboard();
        // First time we see the captured image → the capture is done, bring
        // the DSH window back before the client even fetches the PNG.
        if (snapshot.fresh) await restoreWindows();
        json(res, 200, { ok: true, toolDone, ...snapshot });
        return;
      }
      if (req.method === 'POST' && suffix === '/restore') {
        await readJson(req);
        json(res, 200, { ok: true, ...(await restoreWindows()) });
        return;
      }
      if (req.method === 'POST' && suffix === '/ingest') {
        // Server-side ingest: the browser uploads the raw PNG here and we
        // write the attachment send directly (same directory layout and
        // owner marker as dsh-paste-input), skipping its strict
        // Content-Length HTTP protocol entirely — Electron fetch does not
        // emit that header for Blob bodies.
        const name = (url.searchParams.get('name') ?? '').trim();
        const sessionId = (url.searchParams.get('sessionId') ?? '').trim();
        if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
          throw new Error('invalid attachment name');
        }
        if (!sessionId) throw new Error('sessionId is required');
        const session = ctx.sessions.get(sessionId);
        if (session === undefined) throw new Error(`live session not found: ${sessionId}`);
        const cwd = resolve(session.header.cwd);
        const buffer = await readRawBody(req, MAX_INGEST_BYTES);
        if (buffer.length === 0) throw new Error('empty body');
        const attachmentsRoot = join(cwd, '.dsh', 'tmp', 'attachments');
        const sendId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
        const finalRoot = join(attachmentsRoot, sessionDirectoryName(sessionId), sendId);
        if (!finalRoot.startsWith(attachmentsRoot + sep)) throw new Error('resolved path escapes attachments root');
        await mkdir(finalRoot, { recursive: true });
        const safeName = name.replace(/[<>:"|?*\u0000-\u001f]/g, '_');
        await writeFile(join(finalRoot, safeName), buffer);
        const marker = {
          owner: 'dsh-paste-input',
          version: 1,
          sessionId,
          createdAt: new Date().toISOString(),
          committedAt: new Date().toISOString(),
          totalBytes: buffer.length,
          files: [{
            index: 0,
            originalPath: safeName,
            actualPath: safeName,
            size: buffer.length,
            type: 'image/png',
          }],
        };
        const manifest = join(finalRoot, '.dsh-paste-input.json');
        await writeFile(manifest, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
        json(res, 200, {
          ok: true,
          root: finalRoot,
          manifest,
          file: { originalPath: safeName, absolutePath: join(finalRoot, safeName), size: buffer.length },
        });
        return;
      }
      if (req.method === 'POST' && suffix === '/client-log') {
        const input = await readJson(req);
        const line = `[${new Date().toISOString()}] ${String(input.message ?? '').slice(0, 2000)}\n`;
        const { appendFile } = await import('node:fs/promises');
        const target = join(tmpdir(), 'dsh-screenshot-client.log');
        await appendFile(target, line, 'utf8').catch(() => {});
        ctx.logger?.warn?.(`dsh-screenshot client: ${String(input.message ?? '').slice(0, 500)}`);
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === 'GET' && suffix === '/clipboard/data') {
        const hash = url.searchParams.get('hash') ?? '';
        if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('invalid hash');
        const cached = cache.get(hash);
        if (cached === undefined) throw new Error('snapshot expired, capture again');
        const body = cached.buffer;
        res.writeHead(200, {
          'cache-control': 'no-store',
          'content-length': body.length,
          'content-type': 'image/png',
        });
        res.end(body);
        return;
      }
      error(res, 404, 'not-found', 'unknown screenshot endpoint');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      error(res, 500, 'screenshot-request-failed', message);
    }
  };

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: API_ROOT, handler: route }),
    'dsh-screenshot: route',
  );
  ctx.effect(() => async () => {
    // If the plugin unloads mid-capture, never leave the window hidden.
    stopToolWatcher();
    await restoreWindows();
  }, 'dsh-screenshot: restore on unload');
}
