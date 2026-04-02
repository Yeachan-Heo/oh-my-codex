# Hướng dẫn Bắt đầu nhanh (Vietnamese)

> [← Back to Docs Home](./index.html)

**Language Switcher:** [English](./getting-started.md) | [한국어](./getting-started.ko.md) | [日本語](./getting-started.ja.md) | [简体中文](./getting-started.zh.md) | [繁體中文](./getting-started.zh-TW.md) | [Tiếng Việt](./getting-started.vi.md) | [Español](./getting-started.es.md) | [Português](./getting-started.pt.md) | [Русский](./getting-started.ru.md) | [Türkçe](./getting-started.tr.md) | [Deutsch](./getting-started.de.md) | [Français](./getting-started.fr.md) | [Italiano](./getting-started.it.md)

## Tổng quan

oh-my-codex (OMX) là một lớp workflow cho [OpenAI Codex CLI](https://github.com/openai/codex).

OMX giữ Codex làm engine thực thi và bổ sung:
- Khởi động phiên Codex mạnh hơn mặc định
- Chạy một workflow nhất quán từ làm rõ đến hoàn thành
- Gọi các skills chuẩn với `$deep-interview`, `$ralplan`, `$team`, và `$ralph`
- Giữ project guidance, plans, logs, và state trong `.omx/`

## Yêu cầu

- Node.js 20+
- Codex CLI đã cài đặt: `npm install -g @openai/codex`
- Codex đã được xác thực
- `tmux` trên macOS/Linux nếu bạn muốn sử dụng durable team runtime
- `psmux` trên Windows native nếu bạn muốn sử dụng Windows team mode

## Cài đặt

```bash
# Bước 1: Cài đặt Codex CLI
npm install -g @openai/codex

# Bước 2: Cài đặt OMX
npm install -g oh-my-codex

# Bước 3: Thiết lập OMX
omx setup
```

## Bắt đầu nhanh

### Khởi động OMX với cấu hình khuyến nghị

```bash
omx --madmax --high
```

### Workflow chuẩn

Sau khi khởi động, hãy thử workflow chuẩn:

```text
$deep-interview "làm rõ thay đổi authentication"
$ralplan "phê duyệt plan auth và xem xét tradeoffs"
$ralph "thực thi plan đến khi hoàn thành"
$team 3:executor "thực thi plan song song"
```

Sử dụng `$team` khi plan cần thực thi song song phối hợp, hoặc `$ralph` khi một owner kiên trì nên tiếp tục đẩy đến hoàn thành.

### Một phiên làm việc tốt

Dưới đây là ví dụ workflow điển hình:

```text
# Làm rõ yêu cầu
$deep-interview "tạo API authentication mới"

# Lập kế hoạch
$ralplan "phê duyệt plan an toàn nhất"

# Thực thi
$ralph "thực thi plan đã phê duyệt"
```

## OMX hoạt động như thế nào

OMX **không thay thế** Codex.

Nó bổ sung một lớp làm việc tốt hơn:
- **Codex** thực hiện công việc agent thực sự
- **OMX role keywords** làm các role hữu ích có thể tái sử dụng
- **OMX skills** làm các workflow phổ biến có thể tái sử dụng
- **`.omx/`** lưu trữ plans, logs, memory, và runtime state

Hầu hết users nên nghĩ về OMX như **tốt hơn task routing + tốt hơn workflow + tốt hơn runtime**, không phải là command surface để vận hành thủ công mỗi ngày.

## Các lệnh hữu ích

| Lệnh | Mô tả |
|------|-------|
| `omx setup` | Thiết lập OMX lần đầu |
| `omx --madmax --high` | Khởi động với cấu hình mạnh nhất |
| `$deep-interview` | Làm rõ yêu cầu trước khi code |
| `$ralplan` | Lập và phê duyệt kế hoạch |
| `$ralph` | Owner kiên trì đẩy đến hoàn thành |
| `$team N:role` | Thực thi song song với N workers |

## Tiếp theo

- 📖 [Agents](./agents.html) — Tìm hiểu về các role có sẵn
- 🔧 [Skills](./skills.html) — Xem các skills tích hợp
- 🔌 [Integrations](./integrations.html) — Kết nối với các dịch vụ bên ngoài
- 💬 [Discord](https://discord.gg/PUwSMR9XNk) — Tham gia cộng đồng

---

*Đóng góp bản dịch: @Jah-yee*