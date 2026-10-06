# @dsh-community/dsh-skill-manager

DSH 技能管理插件：在设置页新增「技能管理」一节，对本地全部技能做全生命周期管理。

## 功能

- **全景清单**：一次扫描全部技能根目录（项目 `.dsh/skills` / 项目 `.agents/skills` / 自定义目录 / `~/.dsh/skills` / `~/.agents/skills`，根目录与 rank 与官方 `dsh-skill-filesystem` 完全对齐，`customSkillDirs` 配置实时读取）。
- **来源与冲突**：每条技能标注来源根、生效/被遮蔽（同名技能按 rank 裁决，败者标明被谁遮蔽）、平铺/目录 bundle、名称与目录不一致等诊断；无效技能（frontmatter 缺字段、name 非 kebab-case、布尔拼写非法）按官方 provider 同款规则标红并给出原因，而不是凭空消失。
- **搜索与筛选**：按名称/描述/whenToUse 搜索；按根目录筛选；「仅看问题」一键聚焦。
- **编辑**：内置 SKILL.md 全文编辑器（frontmatter + 正文），保存时按官方规则校验，原子写入；行尾保持文件原样。
- **启停**：模型可调用 / 用户可调用两个开关，手术式改写 `disable-model-invocation` / `user-invocable` 两个键，其余行（含折叠描述、metadata 等复杂值）逐字节保留。
- **新建**：选根目录 + 表单生成规范 frontmatter 的目录 bundle。
- **删除**：两步确认后移入回收站 `~/.dsh/dsh-skill-manager/trash/`（不直接删除，可找回）。
- **热生效**：所有写入由官方 watcher 自动拾取，下一步/新会话即达模型，无需重启。

## 挂载

```yaml
- name: '@deepseek-ai/dsh-skill'
- name: '@deepseek-ai/dsh-skill-filesystem'
- insert:
    - id: dsh-skill-manager
      name: '@dsh-community/dsh-skill-manager'
```

本插件不依赖 `ctx.skills` 服务（直接镜像 filesystem provider 的发现语义，以便看到被遮蔽与无效条目），宿主半只需 `webServer` + `loader`。

## API（宿主半，`/dsh-skill-manager/v1`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/list?cwd=` | 全量清单（含遮蔽关系）；`cwd` 可选，用于发现项目级根 |
| GET | `/read?path=` | 读 SKILL.md（路径必须落在某根目录第一层结构内） |
| POST | `/save` | `{path, content}` 校验 frontmatter 后原子写入 |
| POST | `/create` | `{rootId, name, description, whenToUse?, body?}` 新建 |
| POST | `/invocation` | `{path, modelInvocable, userInvocable}` 启停 |
| POST | `/delete` | `{path}` 移入回收站 |
| POST | `/reveal` | `{path}` 资源管理器中定位 |

所有请求过 dsh-paste-input 同款 Host/Origin 信任围栏。

## 开发

```bash
node scripts/test.mjs          # 单测（frontmatter 解析/序列化、遮蔽、围栏）
node scripts/smoke-real.mjs    # 只读扫描真实 ~/.agents/skills
```

无构建步骤：`lib/index.js`（宿主半）、`lib/skills.js`（纯逻辑）、`lib/client.js`（设置页 UI，`settings.section` 插槽）。
