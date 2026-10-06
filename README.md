# my-dsh-plugins

[DeepSeek Harness (DSH)](https://github.com/deepseek-ai) 自定义插件合集——一个仓库管理多个 DSH 插件，避免一插件一仓库。

| 插件 | 版本 | 说明 |
|---|---|---|
| [dsh-skill-manager](plugins/dsh-skill-manager/) | 0.1.0 | 设置页「技能管理」：浏览/搜索/来源遮蔽冲突诊断/内置编辑器/启停/新建/删除（回收站），覆盖全部 5 层技能根目录 |
| [dsh-screenshot](plugins/dsh-screenshot/) | 0.5.0 | 一键截图进对话框：剪刀下拉菜单，自绘遮罩矩形/全屏截图，截完自动作为附件进输入框 |

## 安装（任一插件）

以 dsh-skill-manager 为例，在 DSH 所在机器执行（pnpm 的 git 子目录语法，已实测 pnpm 11）：

```bash
# 跟踪 main 分支最新
dsh plugin add github:freeskychenjun/my-dsh-plugins#path:/plugins/dsh-skill-manager

# 或钉死 commit（稳定复现，推荐）
dsh plugin add github:freeskychenjun/my-dsh-plugins#<commit-sha>&path:/plugins/dsh-skill-manager
```

然后在本机 profile 的 `cordis.patch.yml` 加 insert 行（这些插件没有 bundle patch，`plugin add` 只装依赖不挂载）：

```yaml
- insert:
    - id: dsh-skill-manager
      name: '@dsh-community/dsh-skill-manager'
```

> 桌面端（Electron）注意：若 DSH 运行时版本与插件不匹配，需在 profile 目录 `compatibility.json` 加精确豁免
> `{"<包>@<版本>": ["<DSH 版本>"]}` 并重启应用；详见 [DSH 文档](plugins/dsh-skill-manager/README.md)。

安装 dsh-screenshot 同理，把 path 换成 `plugins/dsh-screenshot`。

## 本仓库布局

```
plugins/
  <plugin-name>/     # 独立 npm 包，互不依赖（dsh-screenshot 的上传协议除外）
```

- 每个插件是完整独立包：`lib/index.js`（宿主半）+ `lib/client.js`（Web 客户端半）+ `package.json`（`dsh.client.inject` 声明客户端依赖）。
- 本机开发用 pnpm `link:` 依赖直连本仓库目录，改源码重启即生效。
- 各插件自带单测/冒烟脚本（见 `plugins/*/scripts/`），无构建步骤，纯 JS。

## License

MIT
