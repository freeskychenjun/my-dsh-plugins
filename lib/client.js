window.__ModuleLoader__.load({
  id: '@dsh-community/dsh-screenshot',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const SOURCE = 'dsh-screenshot';
    const API = '/dsh-screenshot/v1';
    // dsh-paste-input's host upload protocol: we commit the PNG at capture
    // time and emit the same DSH_PASTE_INPUT_V1 model block, so sending,
    // workspace copy and bubble folding all keep working unchanged.
    const PASTE_API = '/dsh-paste-input/v1';
    const POLL_INTERVAL_MS = 1000;
    const POLL_MAX_MS = 150_000;

    const css = `
      .dshsc-wrap{position:relative;display:inline-flex;align-items:center}
      .dshsc-button{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:0}
      .dshsc-button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
      .dshsc-button:disabled{opacity:.45;cursor:default}
      .dshsc-button[data-capturing=true]{color:var(--dsw-alias-state-business-primary)}
      .dshsc-toast{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:100;max-width:min(560px,calc(100vw - 48px));box-sizing:border-box;padding:9px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;pointer-events:none;opacity:0;transition:opacity .18s ease}
      .dshsc-toast[data-show=true]{opacity:1}
    `;
    if (document.querySelector('style[data-plugin-css="@dsh-community/dsh-screenshot"]') === null) {
      const style = document.createElement('style');
      style.dataset.plugin = '@dsh-community/dsh-screenshot';
      style.dataset.pluginCss = '@dsh-community/dsh-screenshot';
      style.textContent = css;
      document.head.appendChild(style);
    }

    const records = new Map();
    const listeners = new Set();
    let revision = 0;
    function changed() {
      revision += 1;
      for (const listener of [...listeners]) listener();
    }

    function id() {
      return globalThis.crypto?.randomUUID?.()
        ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    }

    function humanBytes(value) {
      if (value < 1024) return `${value} B`;
      const units = ['KiB', 'MiB', 'GiB'];
      let next = value / 1024;
      let unit = units[0];
      for (let index = 1; index < units.length && next >= 1024; index += 1) {
        next /= 1024;
        unit = units[index];
      }
      return `${next >= 10 ? next.toFixed(0) : next.toFixed(1)} ${unit}`;
    }

    function showToast(message) {
      const toast = document.createElement('div');
      toast.className = 'dshsc-toast';
      toast.textContent = message;
      document.body.appendChild(toast);
      requestAnimationFrame(() => { toast.dataset.show = 'true'; });
      setTimeout(() => {
        toast.dataset.show = 'false';
        setTimeout(() => toast.remove(), 220);
      }, 4000);
    }

    async function responseJson(response) {
      let value;
      try {
        value = await response.json();
      } catch {
        throw new Error(`Screenshot Host returned HTTP ${response.status}`);
      }
      if (!response.ok || value?.ok !== true) {
        throw new Error(value?.error?.message ?? `Screenshot Host returned HTTP ${response.status}`);
      }
      return value;
    }

    // ── upload via dsh-paste-input's batch protocol ─────────────────────────
    function modelMessage(committed) {
      const file = committed.file ?? committed.files?.[0];
      return [
        '',
        '==== DSH_PASTE_INPUT_V1 ====',
        committed.root,
        '',
        `Files: 1`,
        `Manifest: ${committed.root.length > 0 ? committed.manifest.slice(committed.root.length + 1) : committed.manifest}`,
        'Attached files (paths are relative to the root above):',
        `- ${JSON.stringify(file.originalPath)} (${humanBytes(file.size)})`,
        '==== END DSH_PASTE_INPUT ====',
        '',
      ].join('\n');
    }

    const clientLog = (message) => {
      fetch(`${API}/client-log`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
      }).catch(() => {});
    };

    async function uploadPng(sessionId, file) {
      // Server-side ingest: one raw-bytes POST; the host writes the
      // attachment send (same layout/marker as dsh-paste-input). Avoids the
      // browser PUT entirely — Electron fetch does not emit Content-Length
      // for Blob/TypedArray bodies and paste-input's protocol requires it.
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        const committed = await responseJson(await fetch(
          `${API}/ingest?sessionId=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(file.name)}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: bytes,
            // Some fetch stacks need this flag only for streams; harmless here.
          },
        ));
        return modelMessage(committed);
      } catch (cause) {
        const message = `uploadPng failed: ${cause instanceof Error ? cause.message : String(cause)} (file=${file.name} bytes=${bytes.byteLength})`;
        console.error('[dsh-screenshot]', message);
        clientLog(message);
        throw cause;
      }
    }

    // ── capture flow ────────────────────────────────────────────────────────
    function stampName() {
      const now = new Date();
      const pad = value => String(value).padStart(2, '0');
      return `截图-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;
    }

    async function postJson(path, body) {
      return responseJson(await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }));
    }

    const restoreWindow = () => {
      fetch(`${API}/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
    };

    async function captureOnce(sessionId) {
      const baseline = await postJson('/clipboard');
      await postJson('/launch');
      const deadline = Date.now() + POLL_MAX_MS;
      while (Date.now() < deadline) {
        await new Promise(resolveSnapshot => setTimeout(resolveSnapshot, POLL_INTERVAL_MS));
        const snap = await postJson('/clipboard');
        if (snap.hasImage && snap.hash !== baseline.hash) {
          const response = await fetch(`${API}/clipboard/data?hash=${encodeURIComponent(snap.hash)}`);
          if (!response.ok) throw new Error(`Screenshot data fetch failed: HTTP ${response.status}`);
          const blob = await response.blob();
          return new File([blob], stampName(), { type: 'image/png' });
        }
      }
      throw new Error('等待超时：没有检测到新截图（截图工具里按 Esc 取消也会这样）');
    }

    const Scissors = () => h('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
      h('circle', { cx: '4', cy: '4', r: '2', stroke: 'currentColor', strokeWidth: 1.4 }),
      h('circle', { cx: '4', cy: '12', r: '2', stroke: 'currentColor', strokeWidth: 1.4 }),
      h('path', { d: 'M5.7 5.4 13.5 12M5.7 10.6 13.5 4', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }));

    function ScreenshotButton(props) {
      const [busy, setBusy] = React.useState(false);
      const locked = props.input?.phase !== undefined && props.input.phase !== 'plain';

      const capture = React.useCallback(async () => {
        const sessionId = props.sessionId;
        if (sessionId === undefined) {
          showToast('请先打开一个会话。');
          return;
        }
        setBusy(true);
        try {
          const file = await captureOnce(sessionId);
          await props.add(sessionId, [{ file, path: file.name }]);
          showToast(`截图已加入输入框（${humanBytes(file.size)}）`);
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          clientLog(`capture failed: ${message}`);
          showToast(message);
        } finally {
          restoreWindow();
          setBusy(false);
        }
      }, [props.add, props.sessionId]);

      return h('div', { className: 'dshsc-wrap' },
        h('button', {
          type: 'button',
          className: 'dshsc-button',
          'data-capturing': busy,
          title: busy ? '等待截图完成…（再点一次取消等待）' : '截图：拉起截图工具，截完自动放进输入框',
          'aria-label': '截图',
          disabled: locked && !busy,
          onClick: () => { if (busy) { setBusy(false); restoreWindow(); } else void capture(); },
        }, h(Scissors)));
    }

    const inject = ['slots', 'conversation', 'sessions', 'inputTriggers'];

    function apply(ctx) {
      const sessions = ctx.get('sessions');
      const conversation = ctx.get('conversation');
      const inputTriggers = ctx.get('inputTriggers');

      const inputFor = sessionId => {
        const actx = sessions.scope(sessionId);
        if (actx === undefined) throw new Error(`Screenshot session is not active: ${sessionId}`);
        return conversation.input.for(actx);
      };
      const inputSnapshotFor = sessionId => {
        try {
          const actx = sessions.scope(sessionId);
          return actx === undefined ? undefined : conversation.input.for(actx).state.getSnapshot();
        } catch {
          return undefined;
        }
      };

      const add = async (sessionId, items) => {
        const input = inputFor(sessionId);
        let snapshot = input.state.getSnapshot();
        if (snapshot.phase !== 'plain') throw new Error('Wait for the current input operation to finish');
        if (snapshot.draft !== '' && !/\s$/u.test(snapshot.draft)) {
          input.setDraft(`${snapshot.draft} `);
          snapshot = input.state.getSnapshot();
        }
        for (const item of items) {
          const ref = id();
          const label = item.path;
          const record = {
            ref, sessionId, file: item.file, size: item.file.size, label,
            status: 'uploading', modelText: undefined, error: undefined,
          };
          records.set(ref, record);
          changed();
          const accepted = input.insertReference({
            source: SOURCE,
            ref,
            label: `🖼 ${label}`,
            clipboardText: `[screenshot: ${label}]`,
          }, {
            start: snapshot.draft.length,
            end: snapshot.draft.length,
            draftRev: snapshot.draftRev,
          });
          if (!accepted) {
            records.delete(ref);
            changed();
            throw new Error('The DSH composer changed before the screenshot could be inserted');
          }
          // Upload in the background; serialize() awaits the result at send time.
          uploadPng(sessionId, item.file).then(
            (modelText) => {
              record.modelText = modelText;
              record.status = 'uploaded';
              changed();
            },
            (cause) => {
              record.status = 'error';
              record.error = cause instanceof Error ? cause.message : String(cause);
              changed();
              showToast(`截图上传失败：${record.error}`);
            },
          );
        }
        changed();
      };

      const source = {
        trigger: '@',
        name: SOURCE,
        order: 1001,
        candidates: () => Promise.resolve([]),
        onPick: () => undefined,
        codec: {
          clipboardText: ref => records.get(ref)?.label ?? `screenshot:${ref}`,
          serialize: (ref, signal) => {
            const record = records.get(ref);
            if (record === undefined) {
              const message = `serialize: record missing ref=${ref}`;
              clientLog(message);
              return Promise.reject(new Error('Screenshot selection is no longer available in this browser tab'));
            }
            if (record.error !== undefined) {
              clientLog(`serialize: record error ref=${ref}: ${record.error}`);
              return Promise.reject(new Error(record.error));
            }
            if (record.modelText !== undefined) return Promise.resolve(record.modelText);
            return uploadPng(record.sessionId, record.file).then((modelText) => {
              record.modelText = modelText;
              record.status = 'uploaded';
              changed();
              return modelText;
            }, (cause) => {
              clientLog(`serialize: send-time upload failed ref=${ref}: ${cause instanceof Error ? cause.message : String(cause)}`);
              throw cause;
            });
          },
        },
      };
      ctx.effect(() => inputTriggers.registerSource(source), 'dsh-screenshot: reference codec');

      ctx.inject(['slots', 'conversation', 'sessions', 'inputTriggers'], scope => {
        scope.slots.inject('conversation.input.left', () => scope.slots.register({
          name: 'conversation.input.left',
          id: 'dsh-screenshot-button',
          order: -99,
          inject: sessionId => ({ add, sessionId, input: inputSnapshotFor(sessionId) }),
        }, ScreenshotButton));
      });
    }

    return { apply, inject };
  },
});
