# Bắt đầu với oh-my-codex (OMX)

> [← Docs Home](./index.html) · [Agents](./agents.html) · [Skills](./skills.html) · [Integrations](./integrations.html)

**Language Switcher:** [English](./getting-started.html) | [Tiếng Việt](./getting-started.vi.md)

Hướng dẫn cài đặt và sử dụng OMX từ đầu.

## Yêu cầu

- Node.js 20+ và npm
- OpenAI Codex CLI đã cài và xác thực
- Git (khuyến nghị) cho workflow dự án

## Cài đặt

```bash
npm install -g @openai/codex oh-my-codex
omx setup
omx doctor
```

- `omx setup` cài prompt, skill, config, AGENTS.md và tạo thư mục `.omx/`
- `omx doctor` kiểm tra mọi thứ đã sẵn sàng chưa — chạy lệnh này nếu gặp vấn đề

## Khởi chạy

```bash
omx --xhigh --madmax   # môi trường tin cậy, cho phép chạy tự do
omx                     # chế độ thường
```

## Chạy thử lần đầu

1. Tạo hoặc vào thư mục dự án
2. Chạy `omx setup` để cài prompt, skill, AGENTS.md và config
3. Khởi chạy Codex bằng `omx`
4. Dùng `$deep-interview "clarify the auth change"` khi yêu cầu hoặc scope còn mơ hồ
5. Dùng `$ralplan "approve the auth plan and review tradeoffs"` để chốt kế hoạch triển khai
6. Chọn cách thực thi:
   - `$ralph "carry the approved plan to completion"` — một agent lo từ đầu đến cuối
   - `$team 3:executor "execute the approved plan in parallel"` — nhiều worker chạy song song

## OMX truyền instruction cho Codex như thế nào

Mặc định, OMX thêm hướng dẫn dự án cho Codex qua:

```
-c model_instructions_file="<cwd>/AGENTS.md"
```

OMX chỉ mở rộng thêm, không ghi đè policy hệ thống của Codex.

Tuỳ chỉnh khi cần:

```bash
OMX_BYPASS_DEFAULT_SYSTEM_PROMPT=0 omx                        # tắt AGENTS.md injection
OMX_MODEL_INSTRUCTIONS_FILE=/path/to/instructions.md omx       # dùng file hướng dẫn khác
```

## Xử lý sự cố

| Vấn đề | Kiểm tra |
| --- | --- |
| Lệnh `omx` không tìm thấy | Cài lại global và đảm bảo npm global bin nằm trong PATH |
| Prompt không có sẵn | Kiểm tra `~/.codex/prompts/` có file không, chạy lại `omx setup` |
| Skill không load | Kiểm tra `~/.codex/skills/*/SKILL.md` đã được cài chưa |
| Doctor báo lỗi config | Chạy `omx doctor` và làm theo gợi ý sửa lỗi |

---

Cần thêm context? Xem [README tiếng Việt](../README.vi.md) hoặc [tài liệu đầy đủ (tiếng Anh)](./index.html).
