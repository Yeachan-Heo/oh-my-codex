# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex character" width="280">
  <br>
  <em>Dùng Codex hiệu quả hơn — OMX lo phần prompt, workflow và runtime khi dự án phức tạp dần.</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/PUwSMR9XNk)

**Website:** https://yeachan-heo.github.io/oh-my-codex-website/  
**Tài liệu:** [Bắt đầu](../getting-started.html) · [Agent](../agents.html) · [Skill](../skills.html) · [Tích hợp](../integrations.html) · [Demo](../../DEMO.md) · [Hướng dẫn OpenClaw](../openclaw-integration.md)

OMX là lớp workflow mở rộng cho [OpenAI Codex CLI](https://github.com/openai/codex).

Codex vẫn là engine chính, OMX giúp bạn:
- cấu hình Codex tốt hơn ngay từ phiên đầu tiên
- chạy workflow nhất quán từ làm rõ yêu cầu đến hoàn thành
- gọi các skill chính bằng `$deep-interview`, `$ralplan`, `$team` và `$ralph`
- lưu trữ hướng dẫn dự án, kế hoạch, log và trạng thái trong `.omx/`

## Workflow mặc định

Nếu bạn muốn trải nghiệm OMX nhanh nhất, bắt đầu từ đây:

```bash
npm install -g @openai/codex oh-my-codex
omx setup
omx --madmax --high
```

Sau đó làm việc bình thường trong Codex:

```text
$deep-interview "clarify the authentication change"
$ralplan "approve the auth plan and review tradeoffs"
$ralph "carry the approved plan to completion"
$team 3:executor "execute the approved plan in parallel"
```

Đó là flow chính.
Khởi động OMX, làm rõ yêu cầu khi cần, duyệt kế hoạch, rồi chọn `$team` để chạy song song hoặc `$ralph` để một agent lo đến khi xong.

## OMX dùng để làm gì

Dùng OMX nếu bạn đã quen Codex và muốn trải nghiệm tốt hơn:
- workflow chuẩn xoay quanh `$deep-interview`, `$ralplan`, `$team` và `$ralph`
- các role chuyên biệt và skill hỗ trợ cho từng loại task
- hướng dẫn dự án qua `AGENTS.md` theo scope
- lưu trạng thái lâu dài trong `.omx/` — kế hoạch, log, memory và theo dõi mode

Nếu bạn chỉ muốn dùng Codex thuần mà không cần thêm workflow, thì có lẽ không cần OMX.

## Bắt đầu nhanh

### Yêu cầu

- Node.js 20+
- Codex CLI đã cài: `npm install -g @openai/codex`
- Codex đã xác thực (auth)
- `tmux` trên macOS/Linux nếu muốn dùng team runtime
- `psmux` trên Windows nếu muốn dùng team mode

### Phiên đầu tiên

Khởi chạy OMX:

```bash
omx --madmax --high
```

Rồi thử workflow chính:

```text
$deep-interview "clarify the authentication change"
$ralplan "approve the safest implementation path"
$ralph "carry the approved plan to completion"
$team 3:executor "execute the approved plan in parallel"
```

Dùng `$team` khi cần nhiều worker chạy song song, hoặc `$ralph` khi muốn một agent lo từ đầu đến cuối.

## Mô hình đơn giản

OMX **không** thay thế Codex.

OMX bổ sung một lớp hỗ trợ phía trên Codex:
- **Codex** vẫn làm toàn bộ việc thực thi
- **Role của OMX** giúp gọi nhanh các vai trò chuyên biệt
- **Skill của OMX** đóng gói các workflow phổ biến thành lệnh
- **`.omx/`** lưu kế hoạch, log, memory và trạng thái runtime

Nói đơn giản: OMX giúp **phân task đúng chỗ + workflow rõ ràng + runtime ổn định hơn** — không phải một bảng điều khiển để gõ lệnh cả ngày.

## Hướng dẫn cho người mới

1. Chạy `omx setup`
2. Khởi động với `omx --madmax --high`
3. Dùng `$deep-interview "..."` khi yêu cầu còn mơ hồ
4. Dùng `$ralplan "..."` để duyệt kế hoạch và cân nhắc trade-off
5. Chọn `$team` để chạy song song hoặc `$ralph` để một agent lo đến khi xong

## Workflow khuyến nghị

1. `$deep-interview` — làm rõ scope khi yêu cầu còn mơ hồ.
2. `$ralplan` — chuyển scope đã rõ thành kế hoạch triển khai được duyệt.
3. `$team` hoặc `$ralph` — dùng `$team` khi cần nhiều worker song song, hoặc `$ralph` khi muốn một agent chạy liên tục đến khi xong.

## Các lệnh thường dùng trong phiên

| Lệnh | Dùng khi |
| --- | --- |
| `$deep-interview "..."` | Làm rõ ý định, scope và non-goal |
| `$ralplan "..."` | Duyệt kế hoạch triển khai và trade-off |
| `$ralph "..."` | Chạy liên tục đến khi hoàn thành và verify |
| `$team "..."` | Chạy song song khi task đủ lớn |
| `/skills` | Xem danh sách skill và helper đã cài |

## Nâng cao

Các phần dưới đây hữu ích nhưng không phải là bước bắt đầu chính.

### Team runtime

Dùng team runtime khi cần phối hợp nhiều worker qua tmux/worktree — đây không phải bước bắt đầu mặc định.

```bash
omx team 3:executor "fix the failing tests with verification"
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

### Setup, doctor và HUD

Đây là các công cụ vận hành/hỗ trợ:
- `omx setup` cài prompt, skill, config và scaffold AGENTS
- `omx doctor` kiểm tra cài đặt khi có vấn đề
- `omx hud --watch` theo dõi trạng thái, không phải workflow chính

### Explore và sparkshell

- `omx explore --prompt "..."` tìm kiếm chỉ đọc trong repository
- `omx sparkshell <command>` chạy lệnh shell có kiểm soát output

Ví dụ:

```bash
omx explore --prompt "find where team state is written"
omx sparkshell git status
omx sparkshell --tmux-pane %12 --tail-lines 400
```

### Cài tmux theo nền tảng

`omx team` cần backend tương thích tmux:

| Nền tảng | Cài đặt |
| --- | --- |
| macOS | `brew install tmux` |
| Ubuntu/Debian | `sudo apt install tmux` |
| Fedora | `sudo dnf install tmux` |
| Arch | `sudo pacman -S tmux` |
| Windows | `winget install psmux` |
| Windows (WSL2) | `sudo apt install tmux` |

## Vấn đề đã biết

### Intel Mac: CPU `syspolicyd` / `trustd` cao khi khởi động

Trên một số máy Intel Mac, khi khởi động OMX — đặc biệt với `--madmax --high` — CPU có thể tăng đột biến do macOS Gatekeeper xác thực nhiều tiến trình đồng thời.

Nếu gặp tình trạng này, thử:
- `xattr -dr com.apple.quarantine $(which omx)`
- Thêm ứng dụng terminal vào danh sách Developer Tools trong cài đặt Security của macOS
- Dùng cấu hình nhẹ hơn (bỏ `--madmax --high`)

## Tài liệu

- [Bắt đầu](../getting-started.html)
- [Hướng dẫn demo](../../DEMO.md)
- [Danh mục agent](../agents.html)
- [Tham chiếu skill](../skills.html)
- [Tích hợp](../integrations.html)
- [Hướng dẫn OpenClaw / notification gateway](../openclaw-integration.md)
- [Đóng góp](../../CONTRIBUTING.md)
- [Nhật ký thay đổi](../../CHANGELOG.md)

## Ngôn ngữ

- [English](../../README.md)
- [한국어](./README.ko.md)
- [日本語](./README.ja.md)
- [简体中文](./README.zh.md)
- [繁體中文](./README.zh-TW.md)
- [Tiếng Việt](./README.vi.md)
- [Español](./README.es.md)
- [Português](./README.pt.md)
- [Русский](./README.ru.md)
- [Türkçe](./README.tr.md)
- [Deutsch](./README.de.md)
- [Français](./README.fr.md)
- [Italiano](./README.it.md)
- [Ελληνικά](./README.el.md)
- [Polski](./README.pl.md)

## Đóng góp

| Vai trò | Tên | GitHub |
| --- | --- | --- |
| Tác giả & Lead | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Maintainer | HaD0Yun | [@HaD0Yun](https://github.com/HaD0Yun) |

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-codex&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-codex&type=date&legend=top-left)

## Giấy phép

MIT
