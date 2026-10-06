/**
 * dsh-skill-manager client half: a Settings section ("技能管理") that lists
 * every local skill across roots, shows source & shadow conflicts, and offers
 * create / edit (markdown editor) / invocation toggles / delete / reveal.
 */
window.__ModuleLoader__.load({
  id: '@dsh-community/dsh-skill-manager',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const API = '/dsh-skill-manager/v1';

    const css = `
      .dshsm-section{width:100%;max-width:820px;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);font:inherit}
      .dshsm-headerRow{display:flex;align-items:center;gap:10px;min-height:32px}
      .dshsm-title{font-size:16px;font-weight:600;line-height:24px}
      .dshsm-count{color:var(--dsw-alias-label-tertiary);font-size:13px}
      .dshsm-spacer{flex:1}
      .dshsm-button{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:5px 12px;cursor:pointer}
      .dshsm-button:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .dshsm-button:disabled{opacity:.45;cursor:default}
      .dshsm-button[data-primary=true]{border-color:transparent;background:var(--dsw-alias-state-business-primary);color:#fff}
      .dshsm-button[data-primary=true]:hover{opacity:.9}
      .dshsm-button[data-danger=true]{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}
      .dshsm-search{position:relative;display:flex;width:100%;color:var(--dsw-alias-label-tertiary)}
      .dshsm-search input{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);width:100%;height:36px;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none;padding:0 12px}
      .dshsm-search input::placeholder{color:var(--dsw-alias-label-tertiary)}
      .dshsm-search input:focus-visible{border-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)) 18%,transparent)}
      .dshsm-chips{display:flex;flex-wrap:wrap;gap:8px}
      .dshsm-chip{border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;padding:3px 11px;cursor:pointer}
      .dshsm-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .dshsm-chip[data-active=true]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
      .dshsm-chip[data-warn=true][data-active=true]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
      .dshsm-list{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
      .dshsm-row{border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-settings-card-fill);display:flex;flex-direction:column;text-align:left;cursor:pointer;font:inherit;color:inherit;padding:10px 14px;gap:3px}
      .dshsm-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .dshsm-rowMain{display:flex;align-items:center;gap:10px;min-width:0}
      .dshsm-rowName{font-family:var(--ds-font-family-code);font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dshsm-rowDesc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
      .dshsm-rowTrailing{margin-left:auto;display:inline-flex;align-items:center;gap:6px;flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px}
      .dshsm-badge{display:inline-flex;align-items:center;border-radius:var(--dsw-radius-xs);padding:1px 7px;font-size:11px;line-height:17px;white-space:nowrap}
      .dshsm-badge[data-kind=source]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
      .dshsm-badge[data-kind=ok]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);color:var(--dsw-alias-state-business-primary)}
      .dshsm-badge[data-kind=warn]{background:color-mix(in srgb,#e6a700 14%,transparent);color:#c78a00}
      .dshsm-badge[data-kind=error]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}
      .dshsm-badge[data-kind=muted]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-tertiary)}
      .dshsm-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;padding:8px 2px}
      .dshsm-note{border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dshsm-note-color,var(--dsw-alias-state-error-primary)) 8%,transparent);color:var(--dshsm-note-color,var(--dsw-alias-state-error-primary));padding:8px 12px;font-size:12px;line-height:18px;white-space:pre-line;overflow-wrap:anywhere}
      .dshsm-note[data-kind=info]{--dshsm-note-color:var(--dsw-alias-state-business-primary)}
      .dshsm-detail{display:flex;flex-direction:column;gap:12px}
      .dshsm-detailTop{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
      .dshsm-detailName{font-family:var(--ds-font-family-code);font-size:15px;font-weight:600}
      .dshsm-path{font-family:var(--ds-font-family-code);font-size:11px;line-height:16px;color:var(--dshsm-path-color,var(--dsw-alias-label-tertiary));overflow-wrap:anywhere}
      .dshsm-path[data-readonly=true]{--dshsm-path-color:var(--dsw-alias-state-error-primary)}
      .dshsm-field label,.dshsm-field>span{display:block;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin-bottom:4px}
      .dshsm-field input[type=text],.dshsm-field textarea{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none;padding:7px 10px;width:100%}
      .dshsm-field input[type=text]:focus-visible,.dshsm-field textarea:focus-visible{border-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)) 18%,transparent)}
      .dshsm-field input[data-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}
      .dshsm-editor{font-family:var(--ds-font-family-code);font-size:12.5px;line-height:19px;min-height:300px;resize:vertical;white-space:pre;overflow-wrap:normal;overflow:auto}
      .dshsm-toggleRow{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
      .dshsm-switch{position:relative;width:36px;height:21px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-module-platform);cursor:pointer;padding:0;flex:none}
      .dshsm-switch[data-on=true]{background:var(--dshsm-switch-color,var(--dsw-alias-state-business-primary));border-color:transparent}
      .dshsm-switch[data-off-semantic=true]{--dshsm-switch-color:#c78a00}
      .dshsm-switch::after{content:'';position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#fff;transition:transform .15s var(--ds-ease-in-out,ease)}
      .dshsm-switch[data-on=true]::after{transform:translateX(15px)}
      .dshsm-switch:disabled{opacity:.5;cursor:default}
      .dshsm-actionsBar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .dshsm-createForm{display:flex;flex-direction:column;gap:12px}
      .dshsm-formGrid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
      @media (max-width:640px){.dshsm-formGrid{grid-template-columns:1fr}}
      .dshsm-metaLine{display:flex;gap:14px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:17px}
      .dshsm-toast{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:100;max-width:min(560px,calc(100vw - 48px));box-sizing:border-box;padding:9px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dshsm-toast-bg,var(--dsw-alias-bg-base));box-shadow:var(--dsh-shadow-lv3,0 8px 28px rgba(0,0,0,.28));color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;pointer-events:none;opacity:0;transition:opacity .18s ease}
      .dshsm-toast[data-show=true]{opacity:1}
      .dshsm-toast[data-error=true]{--dshsm-toast-bg:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,var(--dsw-alias-bg-base));border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}
      .dshsm-loading{color:var(--dsw-alias-label-tertiary);font-size:13px;padding:8px 2px}
    `;
    if (document.querySelector('style[data-plugin-css="@dsh-community/dsh-skill-manager"]') === null) {
      const style = document.createElement('style');
      style.dataset.plugin = '@dsh-community/dsh-skill-manager';
      style.dataset.pluginCss = '@dsh-community/dsh-skill-manager';
      style.textContent = css;
      document.head.appendChild(style);
    }

    // ── utilities ────────────────────────────────────────────────────────────
    let toastHost = null;
    function showToast(message, isError = false) {
      if (toastHost === null) {
        toastHost = document.createElement('div');
        toastHost.className = 'dshsm-toast';
        document.body.appendChild(toastHost);
      }
      toastHost.textContent = message;
      toastHost.dataset.error = String(isError);
      requestAnimationFrame(() => { toastHost.dataset.show = 'true'; });
      clearTimeout(showToast._timer);
      showToast._timer = setTimeout(() => {
        toastHost.dataset.show = 'false';
      }, isError ? 6500 : 4000);
    }

    async function apiJson(path, options = {}) {
      let response;
      try {
        response = await fetch(path.startsWith('http') ? path : `${API}${path}`, options);
      } catch (cause) {
        throw new Error(`网络错误：${cause instanceof Error ? cause.message : String(cause)}`);
      }
      let value;
      try {
        value = await response.json();
      } catch {
        throw new Error(`Host 返回 HTTP ${response.status}`);
      }
      if (!response.ok || value?.ok !== true) {
        throw new Error(value?.error?.message ?? `Host 返回 HTTP ${response.status}`);
      }
      return value;
    }

    const getList = () => apiJson('/list');
    const readSkill = path => apiJson(`/read?path=${encodeURIComponent(path)}`);
    const postJson = (path, body) => apiJson(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });

    function formatBytes(value) {
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

    const formatTime = ms => new Date(ms).toLocaleString(undefined, { hour12: false });

    const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

    // ── shared bits ──────────────────────────────────────────────────────────
    function Badge({ kind, title, children }) {
      return h('span', { className: 'dshsm-badge', 'data-kind': kind, title: title ?? '' }, children);
    }

    function SourceBadge({ record }) {
      return h(Badge, { kind: 'source', title: record.skillMdPath }, record.rootLabel);
    }

    function Switch({ on, semantic, disabled, title, onChange, label }) {
      return h('div', { className: 'dshsm-toggleRow' },
        h('button', {
          type: 'button',
          className: 'dshsm-switch',
          role: 'switch',
          'aria-checked': on,
          'aria-label': label,
          'data-on': String(on),
          'data-off-semantic': String(semantic === 'warn'),
          disabled,
          title,
          onClick: onChange,
        }),
        h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, label));
    }

    // ── skill row ────────────────────────────────────────────────────────────
    function SkillRow({ record, onOpen }) {
      const badges = [h(SourceBadge, { key: 'src', record })];
      if (record.valid) {
        if (record.effective) badges.push(h(Badge, { key: 'eff', kind: 'ok' }, '生效中'));
        else badges.push(h(Badge, { key: 'shadow', kind: 'warn', title: `被 ${record.shadowedBy?.rootLabel ?? ''} 的同名技能遮蔽：${record.shadowedBy?.skillMdPath ?? ''}` }, '被遮蔽'));
        if (record.modelInvocable === false) badges.push(h(Badge, { key: 'm', kind: 'muted', title: 'frontmatter disable-model-invocation: true — 模型目录不可见，仅 / 用户入口' }, '模型不可见'));
        if (record.userInvocable === false) badges.push(h(Badge, { key: 'u', kind: 'muted', title: 'frontmatter user-invocable: false — 用户命令入口不可用' }, '仅模型'));
        if (record.locatorMismatch) badges.push(h(Badge, { key: 'loc', kind: 'warn', title: '目录/文件名与 frontmatter name 不一致' }, '名称不一致'));
      } else {
        badges.push(h(Badge, { key: 'bad', kind: 'error', title: (record.problems ?? []).join('\n') }, '无效'));
      }
      return h('li', null,
        h('button', {
          type: 'button',
          className: 'dshsm-row',
          onClick: onOpen,
        },
          h('div', { className: 'dshsm-rowMain' },
            h('span', { className: 'dshsm-rowName' }, record.name),
            h('span', { className: 'dshsm-rowTrailing' },
              record.kind === 'flat' ? h(Badge, { key: 'k', kind: 'muted' }, '平铺') : null,
              badges)),
          h('div', { className: 'dshsm-rowDesc' }, record.description ?? (record.problems ?? [])[0] ?? '')));
    }

    // ── skill detail ─────────────────────────────────────────────────────────
    function SkillDetail({ record, roots, onBack, onChanged }) {
      const [content, setContent] = React.useState(null);
      const [draft, setDraft] = React.useState('');
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [confirmDelete, setConfirmDelete] = React.useState(false);
      const [live, setLive] = React.useState(record);

      const reload = React.useCallback(async () => {
        setError('');
        setBusy(true);
        try {
          const value = await readSkill(record.skillMdPath);
          setContent(value.content);
          setDraft(value.content);
        } catch (cause) {
          setError(cause.message);
          setContent(null);
        } finally {
          setBusy(false);
        }
      }, [record.skillMdPath]);

      React.useEffect(() => { void reload(); }, [reload]);
      React.useEffect(() => { setLive(record); }, [record]);

      const dirty = content !== null && draft !== content;

      const save = async () => {
        setBusy(true);
        setError('');
        try {
          await postJson('/save', { path: record.skillMdPath, content: draft });
          showToast('已保存。技能目录将由 watcher 自动刷新，新会话/下一步即生效。');
          await reload();
          onChanged();
        } catch (cause) {
          setError(cause.message);
          showToast(`保存失败：${cause.message}`, true);
        } finally {
          setBusy(false);
        }
      };

      const toggleInvocation = async (key) => {
        const nextModel = key === 'model' ? !(live.modelInvocable ?? true) : (live.modelInvocable ?? true);
        const nextUser = key === 'user' ? !(live.userInvocable ?? true) : (live.userInvocable ?? true);
        setBusy(true);
        setError('');
        try {
          await postJson('/invocation', { path: record.skillMdPath, modelInvocable: nextModel, userInvocable: nextUser });
          showToast(nextModel ? '已恢复模型可见' : '已对模型隐藏（仅 / 用户入口可调用）');
          await reload();
          onChanged();
        } catch (cause) {
          setError(cause.message);
          showToast(`操作失败：${cause.message}`, true);
        } finally {
          setBusy(false);
        }
      };

      const reveal = async () => {
        try {
          await postJson('/reveal', { path: record.skillMdPath });
        } catch (cause) {
          showToast(`打开目录失败：${cause.message}`, true);
        }
      };

      const remove = async () => {
        setBusy(true);
        setError('');
        try {
          const value = await postJson('/delete', { path: record.skillMdPath });
          showToast(`已删除并移入回收站：${value.trashPath}`);
          onChanged();
          onBack();
        } catch (cause) {
          setError(cause.message);
          showToast(`删除失败：${cause.message}`, true);
          setConfirmDelete(false);
        } finally {
          setBusy(false);
        }
      };

      const badges = [];
      badges.push(h(SourceBadge, { key: 'src', record: live }));
      if (live.valid) {
        badges.push(live.effective
          ? h(Badge, { key: 'eff', kind: 'ok' }, '生效中')
          : h(Badge, { key: 'sh', kind: 'warn', title: `被 ${live.shadowedBy?.rootLabel ?? ''} 的同名技能遮蔽` }, '被遮蔽'));
        if (live.modelInvocable === false) badges.push(h(Badge, { key: 'm', kind: 'muted' }, '模型不可见'));
        if (live.userInvocable === false) badges.push(h(Badge, { key: 'u', kind: 'muted' }, '仅模型'));
      } else {
        badges.push(h(Badge, { key: 'bad', kind: 'error' }, '无效'));
      }

      return h('div', { className: 'dshsm-detail' },
        h('div', { className: 'dshsm-detailTop' },
          h('button', { type: 'button', className: 'dshsm-button', onClick: onBack, disabled: busy }, '← 返回列表'),
          h('span', { className: 'dshsm-detailName' }, live.name),
          badges),
        h('div', { className: 'dshsm-path', 'data-readonly': String(!live.valid) }, live.skillMdPath),
        h('div', { className: 'dshsm-metaLine' },
          h('span', null, `修改时间 ${formatTime(live.mtimeMs)}`),
          h('span', null, `大小 ${formatBytes(live.sizeBytes)}`),
          h('span', null, live.kind === 'flat' ? '平铺 .md 文件' : '目录 bundle')),
        !live.valid && (live.problems ?? []).length > 0
          ? h('div', { className: 'dshsm-note' }, `该技能不会被加载（与官方 provider 判定一致）：\n${live.problems.join('\n')}`)
          : null,
        live.valid === false ? null : h('div', { className: 'dshsm-toggleRow', style: { gap: 18, flexWrap: 'wrap' } },
          h(Switch, {
            key: 'model',
            on: live.modelInvocable ?? true,
            disabled: busy || dirty || !live.valid,
            label: '模型可调用',
            title: dirty ? '编辑器有未保存修改，先保存或放弃' : '关闭 = 写入 disable-model-invocation: true（模型目录与 skill 工具不可见，仅 / 用户入口）',
            onChange: () => void toggleInvocation('model'),
          }),
          h(Switch, {
            key: 'user',
            on: live.userInvocable ?? true,
            semantic: 'warn',
            disabled: busy || dirty || !live.valid,
            label: '用户可调用',
            title: dirty ? '编辑器有未保存修改，先保存或放弃' : '关闭 = 写入 user-invocable: false（/ 菜单不可见，仅模型可加载）',
            onChange: () => void toggleInvocation('user'),
          })),
        error !== '' ? h('div', { className: 'dshsm-note' }, error) : null,
        busy && content === null ? h('div', { className: 'dshsm-loading' }, '读取中…') : null,
        content !== null ? h('div', { className: 'dshsm-field' },
          h('span', null, 'SKILL.md 全文编辑（frontmatter + 正文，保存时校验）'),
          h('textarea', {
            className: 'dshsm-editor',
            value: draft,
            spellCheck: false,
            onChange: event => setDraft(event.target.value),
          })) : null,
        h('div', { className: 'dshsm-actionsBar' },
          h('button', { type: 'button', className: 'dshsm-button', 'data-primary': 'true', disabled: busy || !dirty, onClick: () => void save() }, '保存'),
          h('button', { type: 'button', className: 'dshsm-button', disabled: busy || !dirty, onClick: () => setDraft(content) }, '放弃更改'),
          dirty ? h('span', { className: 'dshsm-count' }, '有未保存修改') : null,
          h('span', { className: 'dshsm-spacer' }),
          h('button', { type: 'button', className: 'dshsm-button', disabled: busy, onClick: () => void reveal() }, '打开所在目录'),
          confirmDelete
            ? h('span', { className: 'dshsm-toggleRow' },
              h('button', { type: 'button', className: 'dshsm-button', 'data-danger': 'true', disabled: busy, onClick: () => void remove() }, '确认删除（移入回收站）'),
              h('button', { type: 'button', className: 'dshsm-button', disabled: busy, onClick: () => setConfirmDelete(false) }, '取消'))
            : h('button', { type: 'button', className: 'dshsm-button', disabled: busy, onClick: () => setConfirmDelete(true) }, '删除')));
    }

    // ── create form ──────────────────────────────────────────────────────────
    function CreateForm({ roots, defaultRootId, onCancel, onCreated }) {
      const [rootId, setRootId] = React.useState(defaultRootId);
      const [name, setName] = React.useState('');
      const [description, setDescription] = React.useState('');
      const [whenToUse, setWhenToUse] = React.useState('');
      const [body, setBody] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const nameOk = NAME_RE.test(name);
      const valid = nameOk && description.trim() !== '' && rootId !== '';

      const submit = async () => {
        setBusy(true);
        setError('');
        try {
          const value = await postJson('/create', {
            rootId, name, description: description.trim(),
            whenToUse: whenToUse.trim(),
            body: body.trim() === '' ? `# ${name}\n\n在下方补充正文。\n` : body,
          });
          showToast(`已创建：${value.skillMdPath}`);
          onCreated(value.skillMdPath);
        } catch (cause) {
          setError(cause.message);
          showToast(`创建失败：${cause.message}`, true);
        } finally {
          setBusy(false);
        }
      };

      return h('div', { className: 'dshsm-createForm' },
        h('div', { className: 'dshsm-headerRow' },
          h('span', { className: 'dshsm-title' }, '新建技能'),
          h('span', { className: 'dshsm-spacer' }),
          h('button', { type: 'button', className: 'dshsm-button', disabled: busy, onClick: onCancel }, '取消'),
          h('button', { type: 'button', className: 'dshsm-button', 'data-primary': 'true', disabled: busy || !valid, onClick: () => void submit() }, '创建')),
        h('div', { className: 'dshsm-formGrid' },
          h('div', { className: 'dshsm-field' },
            h('label', null, '技能名（kebab-case，小写字母/数字/连字符）'),
            h('input', {
              type: 'text', value: name, 'data-invalid': String(name !== '' && !nameOk),
              placeholder: 'my-skill', onChange: event => setName(event.target.value.trim()),
            })),
          h('div', { className: 'dshsm-field' },
            h('label', null, '创建到根目录'),
            h('select', {
              value: rootId,
              onChange: event => setRootId(event.target.value),
              style: {
                width: '100%', height: '34px', border: '.5px solid var(--dsw-alias-border-l4)',
                borderRadius: 'var(--dsw-radius-md)', background: 'var(--dsw-alias-bg-layer-1)',
                color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: '13px', outline: 'none', padding: '0 8px',
              },
            }, roots.map(root => h('option', { key: root.id, value: root.id }, `${root.label}${root.exists ? '' : '（不存在，将自动创建）'}`))))),
        h('div', { className: 'dshsm-field' },
          h('label', null, 'description（必填，展示在技能目录里）'),
          h('textarea', { rows: 2, value: description, style: { resize: 'vertical' }, onChange: event => setDescription(event.target.value) })),
        h('div', { className: 'dshsm-field' },
          h('label', null, 'whenToUse（可选，提示模型何时使用）'),
          h('input', { type: 'text', value: whenToUse, onChange: event => setWhenToUse(event.target.value) })),
        h('div', { className: 'dshsm-field' },
          h('label', null, '正文 Markdown（可留空，自动生成标题骨架）'),
          h('textarea', { rows: 8, value: body, className: 'dshsm-editor', style: { minHeight: 160 }, spellCheck: false, onChange: event => setBody(event.target.value) })),
        error !== '' ? h('div', { className: 'dshsm-note' }, error) : null,
        h('div', { className: 'dshsm-note', 'data-kind': 'info' },
          '创建的是 <根目录>/<技能名>/SKILL.md 目录 bundle，可放 scripts/、assets/ 等资源；保存后 watcher 自动进目录，无需重启。'));
    }

    // ── section root ─────────────────────────────────────────────────────────
    function SkillManagerSection() {
      const [data, setData] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [error, setError] = React.useState('');
      const [query, setQuery] = React.useState('');
      const [rootFilter, setRootFilter] = React.useState('all');
      const [selectedPath, setSelectedPath] = React.useState(null);
      const [creating, setCreating] = React.useState(false);

      const refresh = React.useCallback(async ({ keepSelection = true } = {}) => {
        setLoading(true);
        setError('');
        try {
          const value = await getList();
          setData(value);
          if (!keepSelection) setSelectedPath(null);
        } catch (cause) {
          setError(cause.message);
        } finally {
          setLoading(false);
        }
      }, []);

      React.useEffect(() => { void refresh(); }, [refresh]);

      const skills = data?.inventory?.skills ?? [];
      const roots = (data?.inventory?.roots ?? []);
      const record = selectedPath === null ? null : (skills.find(s => s.skillMdPath === selectedPath) ?? null);

      const problemCount = skills.filter(s => !s.valid || !s.effective || s.locatorMismatch).length;
      const effectiveCount = skills.filter(s => s.valid && s.effective).length;

      const filtered = skills.filter(skill => {
        if (rootFilter === 'problems') {
          if (!(!skill.valid || !skill.effective || skill.locatorMismatch)) return false;
        } else if (rootFilter !== 'all' && skill.rootId !== rootFilter) return false;
        if (query.trim() === '') return true;
        const q = query.trim().toLowerCase();
        return [skill.name, skill.description, skill.whenToUse, skill.locator, skill.rootLabel]
          .filter(Boolean).some(text => text.toLowerCase().includes(q));
      });

      const defaultRootId = roots.find(r => r.id === 'user-agents')?.id ?? roots[0]?.id ?? '';

      if (record !== null) {
        return h('div', { className: 'dshsm-section' },
          h(SkillDetail, {
            record,
            roots,
            onBack: () => setSelectedPath(null),
            onChanged: () => void refresh(),
          }));
      }

      return h('div', { className: 'dshsm-section' },
        h('div', { className: 'dshsm-headerRow' },
          h('span', { className: 'dshsm-title' }, '技能管理'),
          data !== null ? h('span', { className: 'dshsm-count' }, `${effectiveCount} 个生效 / 共 ${skills.length} 个`) : null,
          h('span', { className: 'dshsm-spacer' }),
          h('button', { type: 'button', className: 'dshsm-button', disabled: loading, onClick: () => void refresh() }, '刷新'),
          h('button', { type: 'button', className: 'dshsm-button', 'data-primary': 'true', onClick: () => setCreating(true) }, '新建技能')),
        creating
          ? h(CreateForm, {
            roots,
            defaultRootId,
            onCancel: () => setCreating(false),
            onCreated: (path) => {
              setCreating(false);
              void refresh().then(() => setSelectedPath(path));
            },
          })
          : h(React.Fragment, null,
            h('div', { className: 'dshsm-search' },
              h('input', {
                type: 'text', value: query, placeholder: '搜索名称 / 描述 / whenToUse…',
                onChange: event => setQuery(event.target.value),
              })),
            h('div', { className: 'dshsm-chips' },
              h('button', {
                type: 'button', className: 'dshsm-chip', 'data-active': String(rootFilter === 'all'),
                onClick: () => setRootFilter('all'),
              }, `全部 ${skills.length}`),
              roots.map(root => h('button', {
                key: root.id,
                type: 'button',
                className: 'dshsm-chip',
                'data-active': String(rootFilter === root.id),
                title: root.exists ? root.path : `${root.path}（不存在）`,
                onClick: () => setRootFilter(root.id),
              }, `${root.label} ${root.count ?? 0}`)),
              problemCount > 0 ? h('button', {
                type: 'button', className: 'dshsm-chip', 'data-warn': 'true',
                'data-active': String(rootFilter === 'problems'),
                onClick: () => setRootFilter('problems'),
              }, `仅看问题 ${problemCount}`) : null),
            error !== '' ? h('div', { className: 'dshsm-note' }, `加载失败：${error}`) : null,
            loading && data === null ? h('div', { className: 'dshsm-loading' }, '扫描技能根目录…') : null,
            !loading && data !== null && filtered.length === 0
              ? h('div', { className: 'dshsm-empty' }, query.trim() !== '' ? '没有匹配的技能。' : '该范围内没有技能。')
              : null,
            h('ul', { className: 'dshsm-list' },
              filtered.map(skill => h(SkillRow, {
                key: skill.skillMdPath,
                record: skill,
                onOpen: () => setSelectedPath(skill.skillMdPath),
              })))),
        data !== null && roots.some(r => !r.exists)
          ? h('div', { className: 'dshsm-note', 'data-kind': 'info' },
            `不存在的根目录（暂无技能，新建时会自动创建）：${roots.filter(r => !r.exists).map(r => r.path).join('；')}。项目级根目录（.dsh/skills、.agents/skills）在有会话打开的cwd下才会出现。`)
          : null);
    }

    // ── registration ─────────────────────────────────────────────────────────
    const inject = ['slots'];

    function apply(ctx) {
      ctx.inject(['slots'], scope => {
        scope.slots.inject('settings.section', () => scope.slots.register({
          name: 'settings.section',
          id: 'dsh-skill-manager',
          order: 20,
          label: '技能管理',
        }, SkillManagerSection));
      });
    }

    return { apply, inject };
  },
});
