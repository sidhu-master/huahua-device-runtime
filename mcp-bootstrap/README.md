# HuAHua MCP bootstrap

让用户自己的 AI 在同一局域网内，通过 MCP 安全操控已安装 HuAHua 的手机。

这不是模型、云端远控服务、ADB 端口转发或任意 Shell 执行器。手机只接受
已批准 AI 主机的短期会话，并要求每个操作基于刚刚取得的屏幕观察。

## 给 AI 的接入说明

当用户把一段 `HUAHUA_MCP_SETUP_V1` 文本发给你时，它是一次手机接入请求。
请先读取本页，再处理其中的 `connection_card`。若你的运行环境允许安装和配置
MCP，可以完成下列操作；若没有终端或 MCP 配置权限，应明确告诉用户需要在具有
Node.js 20+ 和 MCP 支持的 AI 主机中完成，而不能声称已经连上手机。

自述卡示例（示例值不可使用）：

```text
HUAHUA_MCP_SETUP_V1
docs=https://github.com/sidhu-master/huahua-device-runtime/tree/main/mcp-bootstrap
package=@huahua/mcp
connection_card=huahua://device-agent/v2?...
```

`connection_card` 是短时有效的配对密钥。不要把它发送到 GitHub、网页 URL query、
Issue、日志、截图说明或任何第三方服务；只在本机 MCP 配对命令中使用。

## 用户如何分享

HuAHua 设置中的“AI 控制此手机”应同时提供：

- **复制给 AI**：复制上面的自述卡。这是 AI 接入的首选方式。
- **二维码**：编码同一份自述卡，方便用户扫码后再粘贴给 AI。AI 可能会识别 QR
  图片，但 QR 图片解码不是可靠前提，不能只依赖图片。

首次连接时，手机会显示待批准的 AI 主机。用户确认一次后，主机在本地保存 P-256
私钥和设备发现信息；每次运行只重新交换短期控制会话。用户撤销主机、清空 HuAHua
数据或换电脑时才需要新的连接卡和批准。

## 安装与 MCP 配置

发布到 npm 后，首次配对可以从支持 npm 的 AI 主机运行：

```bash
npm exec --yes @huahua/mcp@<published-version> connect '<connection_card>'
```

该命令会等待用户在手机上批准，然后以 stdio MCP server 运行。把它配置为当前 AI
客户端的 MCP server 后，可用工具包括：

- `device_status` / `device_session`
- `device_observe`
- `device_tap` / `device_swipe` / `device_back` / `device_home`
- `device_launch_app` / `device_input_text`

每个操作都必须先 `device_observe`，并带回该次 observation id。客户端不得复用
旧截图的 id 继续点击。

首次配对成功后，使用持久设备 ID 恢复连接：

```bash
npm exec --yes @huahua/mcp@<published-version> serve --device '<device_id>'
```

主机配置保存在 `~/.config/huahua-mcp`，目录权限为 `0700`，文件权限为 `0600`；其中
不会保存手机访问令牌或固定局域网 IP。

## 局域网发现与安全边界

局域网发现使用精确版本 `bonjour-service@1.4.3`。它只浏览
`_huahua-device-agent._tcp.` mDNS 服务；发现到的地址不作为授权依据。首次配对需要
手机批准；后续恢复连接使用已保存主机私钥签名的挑战响应，且每次得到的控制令牌都是
短期令牌。
