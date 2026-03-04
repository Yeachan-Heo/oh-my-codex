# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex character" width="280">
  <br>
  <em>Codex của bạn không đơn độc.</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

> **[Website](https://yeachan-heo.github.io/oh-my-codex-website/)** | **[Documentation](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** | **[CLI Reference](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** | **[Workflows](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** | **[GitHub](https://github.com/Yeachan-Heo/oh-my-codex)** | **[npm](https://www.npmjs.com/package/oh-my-codex)**

Lớp điều phối đa tác nhân cho [OpenAI Codex CLI](https://github.com/openai/codex).

## Ngôn ngữ

- [English](./README.md)
- [한국어 (Korean)](./README.ko.md)
- [日本語 (Japanese)](./README.ja.md)
- [简体中文 (Chinese Simplified)](./README.zh.md)
- [繁體中文 (Chinese Traditional)](./README.zh-TW.md)
- [Tiếng Việt (Vietnamese)](./README.vi.md)
- [Español (Spanish)](./README.es.md)
- [Português (Portuguese)](./README.pt.md)
- [Русский (Russian)](./README.ru.md)
- [Türkçe (Turkish)](./README.tr.md)
- [Deutsch (German)](./README.de.md)
- [Français (French)](./README.fr.md)
- [Italiano (Italian)](./README.it.md)


OMX biến Codex từ một tác nhân phiên đơn thành một hệ thống phối hợp với:
- Role prompts (`/prompts:name`) cho các tác nhân chuyên biệt
- Workflow skills (`$name`) cho các chế độ thực thi lặp lại
- Điều phối đội ngũ trong tmux (`omx team`, `$team`)
- Trạng thái bền vững và bộ nhớ qua máy chủ MCP

## Tại sao chọn OMX

Codex CLI mạnh mẽ cho các tác vụ trực tiếp. OMX thêm cấu trúc cho công việc lớn hơn:
- Phân tách và thực thi theo giai đoạn (`team-plan -> team-prd -> team-exec -> team-verify -> team-fix`)
- Trạng thái vòng đời chế độ bền vững (`.omx/state/`)
- Bề mặt bộ nhớ và sổ ghi chú cho phiên làm việc dài
- Điều khiển vận hành cho khởi chạy, xác minh và hủy bỏ

OMX là một tiện ích bổ sung, không phải fork. Nó sử dụng các điểm mở rộng gốc của Codex.

## Yêu cầu hệ thống

- macOS hoặc Linux (Windows qua WSL2)
- Node.js >= 20
- Codex CLI đã cài đặt (`npm install -g @openai/codex`)
- Xác thực Codex đã cấu hình

## Bắt đầu nhanh (3 phút)

```bash
npm install -g oh-my-codex
omx setup
omx doctor
```

Cấu hình khởi chạy khuyến nghị cho môi trường tin cậy:

```bash
omx --xhigh --madmax
```

## Mới trong v0.5.0

- **Thiết lập nhận biết phạm vi** qua `omx setup --scope user|project` cho các chế độ cài đặt linh hoạt.
- **Định tuyến Spark worker** qua `--spark` / `--madmax-spark` — worker của đội có thể sử dụng `gpt-5.3-codex-spark` mà không ép buộc model lãnh đạo.
- **Hợp nhất danh mục** — loại bỏ các prompt không dùng nữa (`deep-executor`, `scientist`) và 9 skill không dùng nữa để có bề mặt gọn hơn.
- **Mức độ chi tiết thông báo** cho kiểm soát chi tiết đầu ra CCNotifier.

## Phiên đầu tiên

Trong Codex:

```text
/prompts:architect "analyze current auth boundaries"
/prompts:executor "implement input validation in login"
$plan "ship OAuth callback safely"
$team 3:executor "fix all TypeScript errors"
```

Từ terminal:

```bash
omx team 4:executor "parallelize a multi-module refactor"
omx team status <team-name>
omx team shutdown <team-name>
```

## Mô hình cốt lõi

OMX cài đặt và kết nối các lớp sau:

```text
User
  -> Codex CLI
    -> AGENTS.md (bộ não điều phối)
    -> ~/.codex/prompts/*.md (danh mục prompt tác nhân)
    -> ~/.agents/skills/*/SKILL.md (danh mục skill)
    -> ~/.codex/config.toml (tính năng, thông báo, MCP)
    -> .omx/ (trạng thái runtime, bộ nhớ, kế hoạch, nhật ký)
```

## Các lệnh chính

```bash
omx                # Khởi chạy Codex (+ HUD trong tmux khi có sẵn)
omx setup          # Cài đặt prompt/skill/config theo phạm vi + dự án AGENTS.md/.omx
omx doctor         # Chẩn đoán cài đặt/runtime
omx doctor --team  # Chẩn đoán Team/swarm
omx team ...       # Khởi động/trạng thái/tiếp tục/tắt worker tmux của đội
omx status         # Hiển thị các chế độ đang hoạt động
omx cancel         # Hủy các chế độ thực thi đang hoạt động
omx reasoning <mode> # low|medium|high|xhigh
omx tmux-hook ...  # init|status|validate|test
omx hooks ...      # init|status|validate|test (quy trình mở rộng plugin)
omx hud ...        # --watch|--json|--preset
omx help
```

## Mở rộng Hooks (Bề mặt bổ sung)

OMX hiện bao gồm `omx hooks` cho scaffolding và xác thực plugin.

- `omx tmux-hook` vẫn được hỗ trợ và không thay đổi.
- `omx hooks` là bổ sung và không thay thế quy trình tmux-hook.
- Tệp plugin nằm tại `.omx/hooks/*.mjs`.
- Plugin tắt theo mặc định; kích hoạt bằng `OMX_HOOK_PLUGINS=1`.

Xem `docs/hooks-extension.md` cho quy trình mở rộng đầy đủ và mô hình sự kiện.

## Cờ khởi chạy

```bash
--yolo
--high
--xhigh
--madmax
--force
--dry-run
--verbose
--scope <user|project>  # chỉ dành cho setup
```

`--madmax` ánh xạ đến Codex `--dangerously-bypass-approvals-and-sandbox`.
Chỉ sử dụng trong môi trường sandbox tin cậy hoặc bên ngoài.

### Chính sách workingDirectory MCP (tăng cường tùy chọn)

Theo mặc định, các công cụ MCP state/memory/trace chấp nhận `workingDirectory` do người gọi cung cấp.
Để hạn chế điều này, đặt danh sách gốc được phép:

```bash
export OMX_MCP_WORKDIR_ROOTS="/path/to/project:/path/to/another-root"
```

Khi được đặt, các giá trị `workingDirectory` ngoài các gốc này sẽ bị từ chối.

## Kiểm soát Prompt Codex-First

Theo mặc định, OMX tiêm:

```text
-c model_instructions_file="<cwd>/AGENTS.md"
```

Điều này thêm hướng dẫn `AGENTS.md` của dự án vào lệnh khởi chạy Codex.
Mở rộng hành vi Codex, nhưng không thay thế/bỏ qua các chính sách hệ thống cốt lõi của Codex.

Điều khiển:

```bash
OMX_BYPASS_DEFAULT_SYSTEM_PROMPT=0 omx     # tắt tiêm AGENTS.md
OMX_MODEL_INSTRUCTIONS_FILE=/path/to/instructions.md omx
```

## Chế độ đội

Sử dụng chế độ đội cho công việc lớn được hưởng lợi từ worker song song.

Vòng đời:

```text
start -> assign scoped lanes -> monitor -> verify terminal tasks -> shutdown
```

Các lệnh vận hành:

```bash
omx team <args>
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

Quy tắc quan trọng: không tắt khi các tác vụ vẫn đang ở trạng thái `in_progress` trừ khi đang hủy bỏ.

### Chính sách dọn dẹp Ralph

Khi đội chạy trong chế độ ralph (`omx team ralph ...`), việc dọn dẹp khi tắt
áp dụng chính sách chuyên dụng khác với đường dẫn thông thường:

| Hành vi | Đội thông thường | Đội Ralph |
|---|---|---|
| Tắt cưỡng bức khi lỗi | Ném `shutdown_gate_blocked` | Bỏ qua cổng, ghi nhật ký sự kiện `ralph_cleanup_policy` |
| Xóa nhánh tự động | Xóa nhánh worktree khi rollback | Giữ lại nhánh (`skipBranchDeletion`) |
| Ghi nhật ký hoàn thành | Sự kiện `shutdown_gate` tiêu chuẩn | Sự kiện `ralph_cleanup_summary` bổ sung với phân tích tác vụ |

Chính sách Ralph được phát hiện tự động từ trạng thái chế độ đội (`linked_ralph`) hoặc
có thể được truyền rõ ràng qua `omx team shutdown <name> --ralph`.

Chọn Worker CLI cho worker của đội:

```bash
OMX_TEAM_WORKER_CLI=auto    # mặc định; sử dụng claude khi worker --model chứa "claude"
OMX_TEAM_WORKER_CLI=codex   # ép buộc worker Codex CLI
OMX_TEAM_WORKER_CLI=claude  # ép buộc worker Claude CLI
OMX_TEAM_WORKER_CLI_MAP=codex,codex,claude,claude  # hỗn hợp CLI theo worker (độ dài=1 hoặc số worker)
OMX_TEAM_AUTO_INTERRUPT_RETRY=0  # tùy chọn: tắt fallback thích ứng queue->resend
```

Lưu ý:
- Tham số khởi chạy worker vẫn được chia sẻ qua `OMX_TEAM_WORKER_LAUNCH_ARGS`.
- `OMX_TEAM_WORKER_CLI_MAP` ghi đè `OMX_TEAM_WORKER_CLI` cho lựa chọn theo worker.
- Gửi trigger sử dụng thử lại thích ứng theo mặc định (queue/submit, sau đó fallback an toàn clear-line+resend khi cần).
- Trong chế độ Claude worker, OMX khởi chạy worker dưới dạng `claude` thuần túy (không có tham số khởi chạy thêm) và bỏ qua các ghi đè rõ ràng `--model` / `--config` / `--effort` để Claude sử dụng `settings.json` mặc định.

## `omx setup` ghi những gì

- `.omx/setup-scope.json` (phạm vi cài đặt được lưu trữ)
- Cài đặt phụ thuộc phạm vi:
  - `user`: `~/.codex/prompts/`, `~/.agents/skills/`, `~/.codex/config.toml`, `~/.omx/agents/`
  - `project`: `./.codex/prompts/`, `./.agents/skills/`, `./.codex/config.toml`, `./.omx/agents/`
- Hành vi khởi chạy: nếu phạm vi được lưu trữ là `project`, khởi chạy `omx` tự động sử dụng `CODEX_HOME=./.codex` (trừ khi `CODEX_HOME` đã được đặt).
- `AGENTS.md` hiện có được giữ nguyên theo mặc định. Trong các lần chạy TTY tương tác, setup hỏi trước khi ghi đè; `--force` ghi đè không hỏi (kiểm tra an toàn phiên hoạt động vẫn áp dụng).
- Cập nhật `config.toml` (cho cả hai phạm vi):
  - `notify = ["node", "..."]`
  - `model_reasoning_effort = "high"`
  - `developer_instructions = "..."`
  - `[features] multi_agent = true, child_agents_md = true`
  - Mục máy chủ MCP (`omx_state`, `omx_memory`, `omx_code_intel`, `omx_trace`)
  - `[tui] status_line`
- `AGENTS.md` của dự án
- Thư mục `.omx/` runtime và cấu hình HUD

## Tác nhân và skill

- Prompt: `prompts/*.md` (cài vào `~/.codex/prompts/` cho `user`, `./.codex/prompts/` cho `project`)
- Skill: `skills/*/SKILL.md` (cài vào `~/.agents/skills/` cho `user`, `./.agents/skills/` cho `project`)

Ví dụ:
- Tác nhân: `architect`, `planner`, `executor`, `debugger`, `verifier`, `security-reviewer`
- Skill: `autopilot`, `plan`, `team`, `ralph`, `ultrawork`, `cancel`

## Cấu trúc dự án

```text
oh-my-codex/
  bin/omx.js
  src/
    cli/
    team/
    mcp/
    hooks/
    hud/
    config/
    modes/
    notifications/
    verification/
  prompts/
  skills/
  templates/
  scripts/
```

## Phát triển

```bash
git clone https://github.com/Yeachan-Heo/oh-my-codex.git
cd oh-my-codex
npm install
npm run build
npm test
```

## Tài liệu

- **[Tài liệu đầy đủ](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** — Hướng dẫn hoàn chỉnh
- **[Tham chiếu CLI](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** — Tất cả lệnh `omx`, cờ và công cụ
- **[Hướng dẫn thông báo](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#notifications)** — Cài đặt Discord, Telegram, Slack và webhook
- **[Quy trình công việc khuyến nghị](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** — Chuỗi skill đã thử nghiệm thực chiến cho các tác vụ phổ biến
- **[Ghi chú phát hành](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#release-notes)** — Tính năng mới trong mỗi phiên bản

## Ghi chú

- Nhật ký thay đổi đầy đủ: `CHANGELOG.md`
- Hướng dẫn di chuyển (sau v0.4.4 mainline): `docs/migration-mainline-post-v0.4.4.md`
- Ghi chú về độ bao phủ và tương đương: `COVERAGE.md`
- Quy trình mở rộng hook: `docs/hooks-extension.md`
- Chi tiết cài đặt và đóng góp: `CONTRIBUTING.md`

## Lời cảm ơn

Lấy cảm hứng từ [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode), được điều chỉnh cho Codex CLI.

## Giấy phép

MIT
