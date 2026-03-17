# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex character" width="280">
  <br>
  <em>Codex của bạn không đơn độc.</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/discord/1466022107199574193?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/qRJw62Gvh7)

> **[Website](https://yeachan-heo.github.io/oh-my-codex-website/)** | **[Documentation](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** | **[CLI Reference](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** | **[Workflows](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** | **[Hướng dẫn tích hợp OpenClaw](./docs/openclaw-integration.vi.md)** | **[GitHub](https://github.com/Yeachan-Heo/oh-my-codex)** | **[npm](https://www.npmjs.com/package/oh-my-codex)**

Lớp điều phối đa tác nhân cho [OpenAI Codex CLI](https://github.com/openai/codex).

## Điểm mới trong v0.9.0 — Spark Initiative

Spark Initiative là bản phát hành tăng cường đường đi native cho khám phá và kiểm tra trong OMX.

- **Native harness cho `omx explore`** — chạy khám phá kho mã chỉ đọc nhanh hơn và chặt chẽ hơn bằng harness Rust.
- **`omx sparkshell`** — bề mặt kiểm tra native cho operator, hỗ trợ tóm tắt đầu ra dài và chụp tmux pane.
- **Tài sản phát hành native đa nền tảng** — đường hydration cho `omx-explore-harness`, `omx-sparkshell` và `native-release-manifest.json` nay đã nằm trong pipeline phát hành.
- **CI/CD được tăng cường** — thêm thiết lập Rust toolchain tường minh cho `build` job cùng với `cargo fmt --check` và `cargo clippy -- -D warnings`.

Xem thêm tại [ghi chú phát hành v0.9.0](./docs/release-notes-0.9.0.md) và [release body](./docs/release-body-0.9.0.md).

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
    -> ~/.codex/skills/*/SKILL.md (danh mục skill)
    -> ~/.codex/config.toml (tính năng, thông báo, MCP)
    -> .omx/ (trạng thái runtime, bộ nhớ, kế hoạch, nhật ký)
```

## Các lệnh chính

```bash
omx                # Khởi chạy Codex (+ HUD trong tmux khi có sẵn)
omx setup          # Cài đặt prompt/skill/config theo phạm vi + .omx của dự án + AGENTS.md theo phạm vi
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

Điều này kết hợp `AGENTS.md` trong `CODEX_HOME` với `AGENTS.md` của dự án (nếu có), rồi thêm lớp phủ runtime.
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
  - `user`: `~/.codex/prompts/`, `~/.codex/skills/`, `~/.codex/config.toml`, `~/.omx/agents/`, `~/.codex/AGENTS.md`
  - `project`: `./.codex/prompts/`, `./.codex/skills/`, `./.codex/config.toml`, `./.omx/agents/`, `./AGENTS.md`
- Hành vi khởi chạy: nếu phạm vi được lưu trữ là `project`, khởi chạy `omx` tự động sử dụng `CODEX_HOME=./.codex` (trừ khi `CODEX_HOME` đã được đặt).
- Hướng dẫn khởi chạy sẽ kết hợp `~/.codex/AGENTS.md` (hoặc `CODEX_HOME/AGENTS.md` nếu đã ghi đè) với `./AGENTS.md` của dự án, rồi thêm lớp phủ runtime.
- Các tệp `AGENTS.md` hiện có sẽ không bao giờ bị ghi đè âm thầm: ở TTY tương tác, setup hỏi trước khi thay thế; ở chế độ không tương tác, việc thay thế sẽ bị bỏ qua trừ khi dùng `--force` (kiểm tra an toàn phiên hoạt động vẫn áp dụng).
- Cập nhật `config.toml` (cho cả hai phạm vi):
  - `notify = ["node", "..."]`
  - `model_reasoning_effort = "high"`
  - `developer_instructions = "..."`
  - `[features] multi_agent = true, child_agents_md = true`
  - Mục máy chủ MCP (`omx_state`, `omx_memory`, `omx_code_intel`, `omx_trace`)
  - `[tui] status_line`
- `AGENTS.md` theo phạm vi
- Thư mục `.omx/` runtime và cấu hình HUD

## Tác nhân và skill

- Prompt: `prompts/*.md` (cài vào `~/.codex/prompts/` cho `user`, `./.codex/prompts/` cho `project`)
- Skill: `skills/*/SKILL.md` (cài vào `~/.codex/skills/` cho `user`, `./.codex/skills/` cho `project`)

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
