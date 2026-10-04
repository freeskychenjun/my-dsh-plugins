# @dsh-community/dsh-screenshot

DSH WebUI 一键截图插件：输入框旁的剪刀按钮 → 拉起本机截图工具 → 截完自动检测剪贴板新图 → 直接作为附件进入对话框，**不需要再手动 Ctrl+V**。

配套 `@dsh-community/dsh-paste-input`：截图 PNG 走它的 batch 上传协议写入会话临时附件目录，发送时复用同一套 `DSH_PASTE_INPUT_V1` 消息协议，气泡折叠 chip 照常工作。

## 使用

1. 点输入框左侧剪刀按钮（回形针旁）；
2. 弹出截图选框后正常截图（Windows 截图工具 / Snipaste 等均可，结果进剪贴板）；
3. 截图自动出现在对话框附件 chip 里，写正文发送即可。

按钮再次点击可取消等待（最长等 150 秒；截图时按 Esc 取消选框会以"超时未检测到新截图"收场）。

## 配置

宿主半 `config.command` 指定截图工具启动命令（在 profile 的 `cordis.patch.yml` 该插件条目下配）：

```yaml
- insert:
    - id: dsh-screenshot
      name: '@dsh-community/dsh-screenshot'
      config:
        command: 'explorer.exe ms-screenclip:'   # 默认：Win11 截图工具（Win+Shift+S 同款）
        # command: 'C:\Tools\Snipaste.exe snip'  # Snipaste 示例
```

默认 `explorer.exe ms-screenclip:` 拉起系统截图工具；换其他工具改 command 即可。

## 安全

宿主路由复用 DSH Host/Origin 信任围栏（同 dsh-paste-input 的 trustedRequest），只放行本机/受信来源；剪贴板快照按内容哈希缓存（最多 8 份），只回放本插件自己生成过的快照。

## 环境要求

- Windows（剪贴板读取走 PowerShell 5.1 STA + System.Windows.Forms）；
- DSH 运行在**本机交互桌面会话**（pm2 托管的 `dsh-web` 满足）；
- 已安装并启用 `@dsh-community/dsh-paste-input`（上传协议依赖）。

## 截图时隐藏 DSH 窗口（v0.1.1）

截图期间 DSH 桌面窗口自动隐藏（Win32 ShowWindow，只针对 `hideProcessName` 指定的进程，默认 `DeepSeek Harness`）；截到图 / 取消 / 超时 / 90 秒兜底 / 插件卸载，五种路径都会自动恢复窗口。config 里 `hideWindow: false` 可关闭。
### v0.3.4

- 取消/超时路径恢复窗口改为 SW_SHOWNOACTIVATE（不抢焦点）——误判取消时不再打断截图遮罩的绘制；截图成功路径仍带焦点恢复。
- 进程监视覆盖截图工具全家桶（ScreenClippingHost / SnippingTool / ScreenSketch，可用 config.watchProcesses 自定义），模式切换时的进程交接不再误判。
### v0.4.0

- 按用户要求**移除任意形状截图支持**：剪贴板探测回退为纯位图路径（`Clipboard.GetImage`）。任意形状截图（仅以 PNG 注册格式存在的数据）会被判定为无图，走快速取消路径直接结束并恢复窗口；矩形/窗口/全屏截图不受影响。
