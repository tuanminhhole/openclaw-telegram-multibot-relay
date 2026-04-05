# OpenClaw Telegram Multibot Relay

[English](#english) | [Tiếng Việt](#tiếng-việt)

An OpenClaw runtime plugin for shared-gateway Telegram multibot setups.

---

## English

### Overview

`openclaw-telegram-multibot-relay` turns multiple Telegram bot accounts in one OpenClaw gateway into a coordinated team.

It is designed for setups where:
- several Telegram bots share one OpenClaw gateway
- each bot has its own identity and account binding
- bots need to hand work off to each other in public group chats
- reminders should appear in the native OpenClaw Cron UI

### Core capabilities

- Route a group turn to the correct Telegram bot account
- Prevent the wrong bot from hijacking the turn
- Support public cross-bot flows such as:
  - `Bot A asks Bot B ...`
  - `Bot A assigns Bot B ...`
  - `Bot A reminds Bot B ...`
- Create one-shot and repeating reminders through native OpenClaw cron
- Remove reminders through the same native cron layer
- Match bot names dynamically from actual OpenClaw agent and Telegram account config

### Why this plugin exists

Telegram Bot API does not provide a strong built-in model for public bot-to-bot collaboration inside the same group. OpenClaw already supports multi-agent routing, multi-account routing, and internal handoff, but the public relay layer still needs explicit orchestration.

This plugin provides that orchestration while staying aligned with OpenClaw conventions:
- native `openclaw.plugin.json` manifest
- runtime registration through `definePluginEntry(...)`
- native OpenClaw cron integration
- ClawHub-compatible package metadata

### Installation

Install from ClawHub:

```bash
openclaw plugins install clawhub:openclaw-telegram-multibot-relay
```

Or install from npm if you publish the package there:

```bash
openclaw plugins install openclaw-telegram-multibot-relay
```

Enable it:

```json
{
  "plugins": {
    "entries": {
      "telegram-multibot-relay": {
        "enabled": true
      }
    }
  }
}
```

### Example phrases

- `Williams asks Luna about the first 30 days of marketing`
- `Luna assigns Williams to draft a deploy checklist`
- `Williams reminds Luna tomorrow at 9:00 to prepare the content plan`
- `delete all reminders`
- `delete reminders for Williams`

### Telegram reaction behavior

The plugin first tries a real Telegram Bot API reaction.

If the target chat rejects reactions, Telegram may return `REACTION_INVALID`. In that case the plugin falls back to a short leading emoji in the message text. That is a Telegram Bot API limitation, not only a prompt issue.

### Compatibility

- Node.js `>=20`
- OpenClaw plugin API `>=2026.3.24`
- OpenClaw gateway `>=2026.3.24`

### License

MIT

---

## Tiếng Việt

### Tổng quan

`openclaw-telegram-multibot-relay` là plugin runtime cho OpenClaw, giúp nhiều bot Telegram chạy chung trong một gateway hoạt động như một đội bot phối hợp.

Plugin phù hợp khi:
- nhiều bot Telegram dùng chung một OpenClaw gateway
- mỗi bot có identity và Telegram account binding riêng
- bot cần giao việc hoặc hỏi qua lại công khai trong group
- lịch nhắc cần đi vào Cron UI native của OpenClaw

### Năng lực chính

- Route đúng lượt chat group vào đúng bot Telegram
- Chặn bot sai chen vào trả lời
- Hỗ trợ relay công khai giữa các bot, ví dụ:
  - `Bot A hỏi Bot B ...`
  - `Bot A giao việc cho Bot B ...`
  - `Bot A nhắc Bot B ...`
- Tạo nhắc hẹn một lần hoặc lặp lại bằng cron native của OpenClaw
- Xóa lịch nhắc qua đúng lớp cron native đó
- Match tên bot động theo agent/account config thật, không hardcode tên riêng

### Vì sao cần plugin này

Telegram Bot API không có sẵn mô hình mạnh cho việc nhiều bot phối hợp công khai trong cùng một group. OpenClaw đã có multi-agent, multi-account và handoff nội bộ, nhưng lớp relay công khai ra đúng bot vẫn cần logic bổ sung.

Plugin này bổ sung lớp đó theo đúng chuẩn OpenClaw:
- manifest `openclaw.plugin.json`
- runtime registration qua `definePluginEntry(...)`
- tích hợp cron native của OpenClaw
- metadata phù hợp để publish lên ClawHub

### Cài đặt

Cài từ ClawHub:

```bash
openclaw plugins install clawhub:openclaw-telegram-multibot-relay
```

Hoặc cài từ npm nếu package đã được publish:

```bash
openclaw plugins install openclaw-telegram-multibot-relay
```

Bật plugin:

```json
{
  "plugins": {
    "entries": {
      "telegram-multibot-relay": {
        "enabled": true
      }
    }
  }
}
```

### Ví dụ câu lệnh

- `Williams hỏi Luna về marketing 30 ngày đầu`
- `Luna giao William soạn checklist deploy`
- `Williams nhắc Luna 9h sáng mai chuẩn bị plan content`
- `xóa hết lịch nhắc`
- `xóa lịch nhắc của Williams`

### Hành vi reaction trên Telegram

Plugin sẽ thử gọi reaction thật qua Telegram Bot API trước.

Nếu chat đích từ chối reaction, Telegram có thể trả `REACTION_INVALID`. Khi đó plugin sẽ fallback sang emoji ngắn ở đầu câu trả lời. Đây là giới hạn từ Telegram Bot API, không chỉ là vấn đề prompt.

### Tương thích

- Node.js `>=20`
- OpenClaw plugin API `>=2026.3.24`
- OpenClaw gateway `>=2026.3.24`

### Giấy phép

MIT
