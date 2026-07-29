# HuAHua 手机控制 CLI

当用户希望让具备本地终端权限的 AI 控制同一局域网中的 HuAHua 手机、但当前 AI 客户端不能配置 MCP 时使用本 Skill。它不需要 MCP 配置；它通过 `huahua` CLI 调用手机既有的受限设备协议。

若用户要求“连接 MCP”“启动 MCP”、配置 MCP Server，或希望手机保持“电脑 AI 已连接”，
不要使用本 Skill 的 `pair` 流程。改为读取包内 README 的 MCP 配置章节，并使用
`prepare -> connect '<connection_card>'`。`pair` 不能代替 `connect`。

If the user asks to connect or start MCP, configure an MCP server, or keep the
phone online, do not use this Skill's `pair` flow. Follow the MCP setup in the
package README and use `prepare -> connect '<connection_card>'`. The one-shot
`pair` command is not a substitute for `connect`.

## 前提

- 当前 AI 必须能在用户电脑上执行终端命令，并且电脑与手机位于同一局域网。
- 首次使用需要用户从 HuAHua 复制 AI 接入卡，并在手机上批准本机连接。
- 纯网页聊天 AI 没有本地终端或局域网权限时，必须说明无法直接控制手机，不得声称已连接。

## 首次配对

从用户提供的自述卡中读取 `connection_card`，只在本机终端中使用它。不得把连接卡写入日志、网页、Issue、截图说明或第三方服务。

先安装并准备本地运行环境。只有返回 `state: "prepared"` 后，才允许发起手机配对：

```bash
npx --yes @newwe/huahua@<published-version> prepare
npx --yes @newwe/huahua@<published-version> pair '<connection_card>'
```

命令会等待用户在手机确认，并返回 `device_id`。保存这个 device id；后续命令会自动通过已保存的主机私钥恢复短期会话，不会再次要求连接卡或手机确认。

`pair` 只登记主机信任。它输出 `device_id` 后会立即退出，不启动 stdio MCP，也不维持手机
端的在线状态。手机随后显示断开属于直接 CLI 模式的预期行为。每条后续 CLI 命令会按需建立
短期会话并在完成后退出；不得向用户声称 MCP 已经启动或正在常驻连接。

`pair` only records host trust. It exits after returning `device_id`; it does
not start stdio MCP or keep the phone online. A subsequent disconnected status
is expected in direct CLI mode. Each later CLI command creates a short-lived
session on demand and exits when done. Never claim that MCP is running or
persistently connected.

配对成功只表示这台电脑已获信任，不表示手机已经可以执行操作。先查询状态：

```bash
npx --yes @newwe/huahua@<published-version> status --device '<device_id>'
```

返回 `phone_setup_required` 时，提示用户按 HuAHua 页面完成手机控制准备，并继续查询状态。
不得通过截图请求来试探准备是否完成。只有返回 `connected` 后才能执行下一节。

若当前客户端已经配置 MCP，配对后应调用一次 `device_wait_ready`，由手机准备完成事件主动
结束等待；不要反复调用 `device_status`。等待超时后仍未就绪时，再提示用户查看 HuAHua
连接页面。

## 每一步操作

每个新的用户任务先执行一次下面的命令。`--command` 必须完整复制用户要求控制手机的原始文字，不得改成摘要、计划或第一步动作：

```bash
npx --yes @newwe/huahua@<published-version> task-start \
  --device '<device_id>' --command '<用户原始命令>'
```

然后先观察，再根据这次观察的 `observation_id` 执行一个动作。观察时应要求输出图片文件，并使用当前 AI 的本地图片阅读能力查看它；没有图片阅读能力时，不得根据 base64 文本猜测屏幕内容。

```bash
npx --yes @newwe/huahua@<published-version> observe --device '<device_id>' --image-file /tmp/huahua-current.jpg
```

观察返回 JSON，其中包含 `observation_id`、前台应用、视觉布局和 `image_file`。所有坐标均为当前视觉输入上的 `0–1000` 归一化坐标；如果 `visual_layout` 为 `before_current`，只能操作右侧 CURRENT 半屏（`x >= 500`）。示例点击：

```bash
npx --yes @newwe/huahua@<published-version> command \
  --device '<device_id>' --action tap --x 300 --y 800 \
  --observation-id '<observation_id>' --summary '点击搜索框'
```

支持的 action：

- `tap`：需要 `--x --y`，范围都是 0–1000。
- `tap_element`：需要 `--ref`，优先使用 observation 返回的 `ui_tree` 元素引用。
- `swipe`：需要 `--x --y --end-x --end-y`，范围都是 0–1000。
- `input_text`：需要 `--text`。
- `launch`：需要 `--package`。
- `back`、`home`：不需要额外动作参数。

每次动作后的返回结果可能含新的 observation；有新观察时继续使用最新的 observation id。
如果返回 `reobserve_required`，说明局域网地址已变化且连接已恢复；不得重放原动作，先重新 observe。

## 安全规则

- 不得执行密码、验证码、支付、下单确认、账号切换或其他私密/不可逆操作；交给手机上的用户完成。
- 不得请求或调用 Shell、ADB、文件、通知、联系人、剪贴板等未公开能力。
- 必须先完成 `prepare` 再消费连接卡；直接 CLI 不得被描述为已安装、已启动或已连接的 MCP。
- 状态不是 `connected` 时不得调用 `observe` 或任何动作命令。
- 每个用户任务只调用一次 `task-start`，成功后才能调用 `observe` 或动作命令。
- 屏幕或操作结果不明确时，重新 observe；不能把已发送命令当作任务已完成。
- 用户要求停止时，不再发送任何动作。
