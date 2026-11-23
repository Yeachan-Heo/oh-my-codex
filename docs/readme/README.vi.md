# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="Nhân vật oh-my-codex" width="280">
  <br>
  <em>Bắt đầu Codex với nền tảng tốt hơn; khi công việc mở rộng, OMX bổ sung prompt, workflow và hỗ trợ runtime hữu ích.</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/wSyUQYfhAw)

**Trang web:** https://yeachan-heo.github.io/oh-my-codex-website/  
**Tài liệu:** [Bắt đầu](../getting-started.html) · [Agent](../agents.html) · [Skill](../skills.html) · [Tích hợp](../integrations.html) · [Demo](../../DEMO.md) · [Hướng dẫn OpenClaw](../openclaw-integration.md)  
**Cộng đồng:** [Discord](https://discord.gg/wSyUQYfhAw) — máy chủ Gajae dùng chung cho oh-my-codex, [gajae-code](https://github.com/Yeachan-Heo/gajae-code) và các công cụ liên quan.

## Dự án và gói chính thức

Dự án OMX chính thức là repository này, [Yeachan-Heo/oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex), với gói npm chính thức [oh-my-codex](https://www.npmjs.com/package/oh-my-codex). Cài bằng `npm install -g oh-my-codex`. Các dự án/fork bên thứ ba mang tên như “OMX v2” không phải bản tiếp nối, thay thế hay nhánh phát hành chính thức trừ khi README hoặc tài liệu nói rõ.

OMX là lớp workflow cho [OpenAI Codex CLI](https://github.com/openai/codex): Codex vẫn thực thi công việc, còn OMX giúp mở phiên làm việc mạnh hơn, duy trì quy trình từ làm rõ yêu cầu tới hoàn tất, tái sử dụng vai trò/skill và lưu hướng dẫn, kế hoạch, nhật ký, trạng thái trong `.omx/`. Đường dùng được tối ưu chủ yếu là macOS/Linux với Codex CLI; Windows native và Codex App là lựa chọn phụ, ít được hỗ trợ hơn.

Nếu OMX có vẻ quá phức tạp, hãy thử [gajae-code](https://github.com/Yeachan-Heo/gajae-code), một hướng nhẹ hơn dựa trên SDK, vẫn dùng Codex OAuth cho OpenClaw, Hermes, Grokbot và tích hợp khác.

## Maintainer chính

| Vai trò | Tên | GitHub |
| --- | --- | --- |
| Người tạo & lãnh đạo | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Maintainer | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Maintainer | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## Đại sứ

| Tên | GitHub |
| --- | --- |
| Sigrid Jin | [@sigridjineth](https://github.com/sigridjineth) |

## Cộng tác viên nổi bật

| Tên | GitHub |
| --- | --- |
| Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Junho Yeo | [@junhoyeo](https://github.com/junhoyeo) |
| JiHongKim98 | [@JiHongKim98](https://github.com/JiHongKim98) |
| Lor | [@gobylor](https://github.com/gobylor) |
| HyunjunJeon | [@HyunjunJeon](https://github.com/HyunjunJeon) |

## Quy trình mặc định khuyến nghị

Chọn một cách cài đặt. Nếu Codex CLI đã có sẵn:

```bash
codex --version
npm install -g oh-my-codex
# chạy từ dự án git cần Codex chỉnh sửa; chọn tên riêng cho task
omx --worktree=feat/task --madmax --xhigh
```

Nếu chưa có Codex CLI và muốn npm quản lý:

```bash
npm install -g @openai/codex
npm install -g oh-my-codex
```

Không cài đồng thời `@openai/codex` và OMX lên binary `codex` đang do Homebrew quản lý, vì npm có thể lỗi `EEXIST`. OMX chỉ cần lệnh `codex` đã xác thực trên `PATH`. Khi nâng phiên bản OMX thật sự, cài đặt npm toàn cục sẽ nhắc chạy setup thay vì tự động mở setup; dùng `omx setup` hoặc `omx update` khi sẵn sàng. Kiểm tra cập nhật lúc khởi động được giới hạn theo thời gian và hỏi trước khi lên lịch; đặt `OMX_AUTO_UPDATE=0` để tắt hoặc `OMX_AUTO_UPDATE=defer` để lên lịch cập nhật trì hoãn.

Chọn phạm vi setup cẩn thận:
- Chạy `omx setup --scope project --merge-agents` trong dự án git nếu repo đó nên sở hữu hướng dẫn `AGENTS.md` lâu dài.
- Dùng `omx setup --scope user` cho cấu hình Codex cấp người dùng.
- Không chạy setup project từ thư mục home rộng, trừ khi đó thực sự là dự án cần quản lý.

### Lưu chính sách merge AGENTS

Các tùy chọn duy nhất là `--merge-agents`, `--no-merge-agents` và `--clear-merge-agents-policy`; dùng dạng cờ, không dùng `=value`. Lựa chọn được lưu trong `./.omx/setup-scope.json` của root hiện tại (kể cả khi setup scope=user), không phải tùy chọn toàn cục. `true` giữ nhánh merge hiện có; `false` chỉ tắt nhánh đó, không hứa bảo toàn hay thay thế nội dung. Clear luôn xóa chính sách và không đi cùng lựa chọn set. `--force` độc lập, tạm thời và không ghi đè chính sách tường minh. Chính sách chỉ được ghi sau khi setup hoàn tất; OMX cũ có thể bỏ qua hoặc xóa trường này khi ghi lại tùy chọn.

**Cài plugin Codex:** repository cũng đóng gói plugin chính thức tại `plugins/oh-my-codex` với skill, metadata bổ trợ và lifecycle hooks cho Codex. Plugin vẫn cần CLI `omx` toàn cục để chạy runtime; cả hai chế độ setup thường cài TOML cho native agents. Chế độ plugin vẫn cần `AGENTS.md` bền vững ở `~/.codex/AGENTS.md` hoặc `./AGENTS.md`. Xem [Plugin bundle SSOT](../plugin-bundle-ssot.md) để hiểu quyền sở hữu asset. `omx setup --disable-hooks` tắt đăng ký hook của OMX.

Với tác vụ dài, tạo mục tiêu và checkpoint bền vững:

```text
/goal Lập kế hoạch refactor xác thực an toàn, triển khai và kiểm tra login, logout, refresh-token.

$deep-interview "làm rõ thay đổi xác thực"
$ralplan "duyệt kế hoạch và xem xét đánh đổi"
$ultragoal "chuyển kế hoạch đã duyệt thành mục tiêu Codex bền vững"
```

Trước khi coi runtime đã sẵn sàng, chạy `omx doctor` và smoke test thực sự: `codex login status` cùng `omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"`. Chỉ dùng `$team` trong tiến trình Ultragoal khi một story cụ thể cần phối hợp.

## OMX dùng để làm gì

Dùng OMX nếu bạn đã thích Codex nhưng muốn runtime hàng ngày tốt hơn:
- workflow chuẩn `$deep-interview` → `$ralplan` → `$ultragoal`;
- nghiên cứu upstream có giới hạn bằng `$best-practice-research` hoặc nghiên cứu có validator bằng `$autoresearch`;
- bàn giao nhiều mục tiêu bền vững với checkpoint `.omx/ultragoal`;
- vai trò chuyên môn, skill tái sử dụng, và hướng dẫn dự án trong `AGENTS.md`;
- kế hoạch, log, bộ nhớ và trạng thái trong `.omx/`.

Nếu muốn Codex thuần không có lớp workflow bổ sung, có thể bạn không cần OMX.

## Bắt đầu nhanh

### Yêu cầu
- Node.js 20+
- Codex CLI đã cài, xác thực và kiểm tra bằng `codex --version`.
- Thông tin xác thực Codex có trong cùng shell/profile chạy OMX.
- `tmux` trên macOS/Linux cho Team runtime bền vững được khuyến nghị; `psmux` chỉ dành cho đường Team ít hỗ trợ trên Windows native.

### Phiên đầu tiên

```bash
omx doctor
codex login status
omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"
```
omx --worktree=feat/task --madmax --xhigh
```
```

`omx doctor` kiểm tra cài đặt, hooks và điều kiện runtime; smoke test thực hiện lệnh thật để phát hiện lỗi auth, profile hoặc provider.

### Nhiều hội thoại tiêu chuẩn cùng lúc

Một lần khởi chạy thông thường sở hữu một session pointer có quyền ghi dưới `OMX_ROOT`. Khởi chạy `omx` lần hai từ cùng checkout sẽ fail-closed thay vì dùng chung root. Gán root riêng cho từng hội thoại:

```bash
omx
OMX_ROOT="$HOME/.omx/instances/second-conversation" omx
OMX_ROOT="$HOME/.omx/instances/third-conversation" omx
```

PowerShell dùng `$env:OMX_ROOT`, Command Prompt dùng `%USERPROFILE%`. Root tường minh trùng nhau gây xung đột; checkout khác nhau có root mặc định riêng.

### Đặt OMX_ROOT trong PowerShell và Command Prompt

PowerShell:
```powershell
$env:OMX_ROOT = "$HOME/.omx/instances/second-conversation"
omx
```

Command Prompt:
```bat
set "OMX_ROOT=%USERPROFILE%\.omx\instances\second-conversation"
omx
```

### An toàn khi dùng Madmax và worktree

`--madmax` là viết tắt của `--dangerously-bypass-approvals-and-sandbox`, loại bỏ bảo vệ phê duyệt và sandbox. Chỉ dùng trong môi trường tin cậy. Trong repo git, ưu tiên worktree có tên:

```bash
Worktree có tên cho một task:
```bash
omx --worktree=feature/auth --madmax --xhigh
```

omx --worktree=feature/auth --madmax --xhigh
omx --worktree=fix/flaky-tests --madmax --xhigh
```

`--worktree` chuyển sang checkout git riêng; dạng không tên tạo worktree detached dùng một lần. Worktree bẩn sẽ có cảnh báo nhưng vẫn khởi chạy. Dùng `--direct` nếu không muốn OMX quản lý tmux/HUD. `OMX_LAUNCH_POLICY=direct|tmux|detached-tmux|auto` đặt lựa chọn môi trường; cờ CLI ưu tiên hơn. Không có thiết lập config file mới trong thay đổi này.

Ví dụ khởi chạy trực tiếp:
```bash
omx --direct --yolo
```

Đặt lựa chọn profile lâu dài:
```bash
OMX_LAUNCH_POLICY=direct omx --yolo
```

Quay lại chế độ tự động:
```bash
unset OMX_LAUNCH_POLICY
```

Cờ CLI ưu tiên hơn biến môi trường; giữa các cờ CLI, cờ cuối cùng có hiệu lực:
```bash
OMX_LAUNCH_POLICY=direct omx --tmux --yolo
```

### /goal và lựa chọn skill

Dùng `/goal` khi cần mục tiêu/checkpoint lâu dài; `$plan` để lập kế hoạch, `$team` để làm song song, `$ultragoal` để hoàn thành nhiều mục tiêu bền vững. Mặc định chỉ nạp 2–5 skill liên quan; nạp cả catalog thường làm giảm tập trung.

Ví dụ mục tiêu bền vững:
```text
/goal Phát hành bản sửa lỗi checkout với checkpoint cho tái hiện, triển khai, kiểm thử hồi quy và xác minh cuối cùng.

$plan "duyệt kế hoạch sửa lỗi checkout và xem xét đánh đổi"
$ultragoal "thực hiện bản sửa đã duyệt với bằng chứng checkpoint"
```

Phản mẫu: đừng tải hàng loạt skill “cho chắc” trước khi nêu task:
```text
omx --madmax --xhigh
# Đừng tải ngay 20 skill "cho chắc" trước khi mô tả task.
# Việc đó làm phình context và khiến mô hình chú ý workflow không liên quan.
```

## Mô hình đơn giản

OMX không thay thế Codex:
- **Codex** thực hiện công việc.
- **Từ khóa vai trò OMX** tái sử dụng vai trò chuyên môn.
- **Skill OMX** tái sử dụng workflow.
- **`.omx/`** lưu kế hoạch, log, bộ nhớ và runtime state.

Hãy xem OMX là lớp định tuyến task, workflow và runtime tốt hơn—not một bộ lệnh phải điều khiển cả ngày.

## Dành cho người mới

1. Kiểm tra/cài Codex CLI, rồi cài `oh-my-codex`.
2. Sau khi cài hoặc nâng phiên bản OMX, chạy setup theo scope; `omx update` cũng có thể cập nhật npm trước.
3. Chạy `omx doctor`.
4. Xác minh `codex login status` và `omx exec` bằng yêu cầu thực.
5. Dùng worktree có tên; tách biệt các phiên Madmax chạy đồng thời.
6. Dùng `$deep-interview` để làm rõ yêu cầu chưa rõ.
7. Dùng `$ralplan` để duyệt kế hoạch và đánh đổi.
8. Dùng `$ultragoal` hoặc `$team` khi cần công việc bền vững/song song; thêm `/goal` cho checkpoint tường minh.

## Workflow khuyến nghị

`$autopilot` là bộ điều phối chính thức theo chuỗi `$deep-interview` → `$ralplan` → `$ultragoal`. Các giai đoạn vẫn gọi riêng được khi đầu vào đã đủ.

1. `$deep-interview` — làm rõ yêu cầu và tạo tài liệu sẵn sàng thực thi.
2. `$ralplan` — tổng hợp kiến trúc, tính khả thi và đồng thuận.
3. `$ultragoal` — thực thi nhiều mục tiêu, ghi checkpoint trong `.omx/ultragoal`.
4. `$team` — phối hợp khi câu chuyện cụ thể cần nhiều lane.

Skill lập kế hoạch chỉ tạo kế hoạch, không tự thực thi code; triển khai cần lane thực thi như `$ultragoal` hoặc `$team`.

## Các bề mặt thường dùng trong phiên

| Bề mặt | Dùng để |
| --- | --- |
| `$plan` | lập kế hoạch/làm rõ tùy chọn |
| `$ultragoal` | hoàn tất lâu dài sau khi duyệt kế hoạch |
| `$team` | phối hợp thực thi song song |
| `/skills` | duyệt skill đã cài |
| `/goal` | mục tiêu/checkpoint cần đối soát qua các lượt |
| `omx mission <file>` | chạy tuần tự prompt/checklist và lưu artifact tại `.omx/missions/` |

## Nâng cao và vận hành

- `omx mission plan ./mission.md` kiểm tra cú pháp; `--dry-run` xem trước; `run`, `status`, `resume`, `mark`, `rerun` điều khiển từng task. [Hướng dẫn Mission](../mission.md).
- `omx session search` / `export` tìm và xuất hội thoại cũ; hỗ trợ ID/prefix duy nhất, JSON, công cụ và `--codex-home`. Mặc định chỉ xuất tin nhắn user/assistant; không bao gồm system/developer và reasoning; văn bản không được redaction.
- `omx session usage --since 7d --sort tokens` xem mức sử dụng tích lũy đã ghi nhận, không phải báo cáo thanh toán theo kỳ; bản sao session được đếm một lần và dữ liệu thiếu hiện là unknown.
- `omx session timeline <id>` hiển thị tool call, kết quả, thời lượng và compaction mà không xuất hội thoại; kết quả không có lỗi rõ ràng không chứng minh thành công.
- `omx team` dùng tmux/worktree để phối hợp bền vững, không phải cách mặc định để bắt đầu. Trong Codex App/ngoài tmux đây chỉ là bề mặt shell. `team status` chỉ quan sát, không thay đổi state.
- `omx setup` cài asset/config theo scope; `omx update` kiểm tra npm và làm mới setup. `omx doctor` không chứng minh hồ sơ hiện tại có thể gọi model; `omx hud --watch` là công cụ giám sát.
- Plugin có thể cache dưới `${CODEX_HOME:-~/.codex}/plugins/cache/...` và mang theo lifecycle hooks/companion metadata, nhưng vẫn cần CLI `omx`. `omx setup --disable-hooks` tắt hook OMX. Xem [bản đồ hook Codex](../codex-native-hooks.md).
- `.omx-config.json` cấu hình model/env routing; chỉ dùng khóa phiên bản đã cài hỗ trợ: [schema](../reference/omx-config-schema-routing.md). Guardex opt-in dùng `"guardex": { "enabled": true }` trong `.omx/hud-config.json`.
- Khi doctor báo xanh nhưng thực thi thất bại, kiểm tra auth, `CODEX_HOME` và `openai_base_url` trong đúng shell/profile. Chỉ ép shutdown team đã xác nhận chết hoặc bỏ dở.
- `omx sparkshell` dùng để kiểm tra shell và xác minh giới hạn; tìm kiếm repo chỉ đọc thì ưu tiên công cụ Codex thông thường. `omx wiki` là giao diện CLI JSON cho knowledge base Markdown trong `omx_wiki/`.

```bash
omx sparkshell git status
omx sparkshell --tmux-pane %12 --tail-lines 400
```
```bash
omx wiki list --json
omx wiki query --input '{"query":"session-start lifecycle"}' --json
omx wiki lint --json
omx wiki refresh --json
```

Lệnh vận hành Team:
```bash
omx team 3:executor "fix the failing tests with verification"
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

Chỉ dọn dẹp cưỡng bức khi đã xác nhận team chết hoặc bị bỏ dở có chủ ý:
```bash
omx team shutdown <team-name> --force --confirm-issues
omx cancel
omx doctor --team
```

### Ghi chú nền tảng cho Team

Team hoạt động tốt nhất trên macOS/Linux với `tmux`. Windows native là đường thứ cấp; thường nên dùng WSL2. Windows chấp nhận `psmux` cho các luồng tmux hiện có.

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

Trên một số Intel Mac, Gatekeeper có thể làm CPU tăng cao khi OMX khởi chạy nhiều tiến trình, đặc biệt với `--madmax --high`. Thử `xattr -dr com.apple.quarantine $(which omx)`, cho phép ứng dụng terminal trong Developer Tools hoặc giảm concurrency.

Nếu Shift+Enter gửi lệnh thay vì xuống dòng trong tmux của OMX, xem [Troubleshooting](../troubleshooting.md#shiftenter-submits-instead-of-inserting-a-newline-in-tmux-backed-omx-sessions).

## Tài liệu

- [Bắt đầu](../getting-started.html)
- [Hướng dẫn demo](../../DEMO.md)
- [Tính năng Wiki](../wiki-feature.md)
- [Danh mục agent](../agents.html)
- [Tài liệu skill](../skills.html)
- [Ánh xạ native hook Codex](../codex-native-hooks.md)
- [Pipeline nhận diện GitHub/PR/package](../pipeline/github-pr-package-identity.md)
- [Tích hợp](../integrations.html)
- [Khắc phục sự cố](../troubleshooting.md)
- [OpenClaw/gateway thông báo](../openclaw-integration.md)
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
- [Українська](./README.uk.md)
- [Bahasa Indonesia](./README.id.md)

## Đóng góp

| Vai trò | Tên | GitHub |
| --- | --- | --- |
| Người tạo & lãnh đạo | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Maintainer | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Maintainer | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## Lịch sử star

[![Star History Chart](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-codex&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-codex&type=date)

## Giấy phép

MIT

## Đo lường khả năng hiển thị GEO

OMX có đặc tả sản phẩm [geobench](https://github.com/NomaDamas/geobench) để đo tỷ lệ LLM truy xuất, MRR, share of voice và trích dẫn.

- Đặc tả: [geobench/oh-my-codex.yaml](../../geobench/oh-my-codex.yaml)
- Hướng dẫn chạy: [geobench.md](../geobench.md)
