# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex character" width="280">
  <br>
  <em>Mulai sesi Codex dengan lebih mantap, lalu biarkan OMX menambahkan prompt, workflow, dan bantuan runtime yang lebih baik saat pekerjaan makin besar.</em>
  <br><br>
  <strong>Suka OmX tetapi terasa agak berlebihan? <a href="https://github.com/Yeachan-Heo/gajae-code">Coba gajae-code</a>.</strong><br>
  <sub>Pertahankan Codex OAuth dengan jalur berbasis SDK yang lebih cepat, lebih murah, lebih sederhana, dan lebih powerful untuk OpenClaw, Hermes, Grokbot, serta integrasi lainnya.</sub>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/wSyUQYfhAw)

**Website:** https://yeachan-heo.github.io/oh-my-codex-website/

**Dokumentasi:** [Memulai](../getting-started.html) · [Agent](../agents.html) · [Skill](../skills.html) · [Integrasi](../integrations.html) · [Demo](../../DEMO.md) · [Panduan OpenClaw](../openclaw-integration.md)

**Komunitas:** [Discord](https://discord.gg/wSyUQYfhAw) — server komunitas Gajae bersama untuk oh-my-codex, [gajae-code](https://github.com/Yeachan-Heo/gajae-code), dan tooling terkait.

## Proyek dan package resmi

Proyek OMX resmi/orisinal adalah repository ini, [`Yeachan-Heo/oh-my-codex`](https://github.com/Yeachan-Heo/oh-my-codex), dan package npm resmi untuk proyek ini adalah [`oh-my-codex`](https://www.npmjs.com/package/oh-my-codex). Instal proyek ini dengan `npm install -g oh-my-codex` (atau bersama Codex CLI seperti ditunjukkan di bawah).

Proyek pihak ketiga atau fork yang menggunakan nama seperti “OMX v2” bukan kelanjutan, pengganti, atau jalur release resmi repository ini kecuali README atau dokumentasi ini menyatakannya secara eksplisit. Jika ragu, percayai repository ini dan package `oh-my-codex` sebagai target instalasi resmi.

OMX adalah layer workflow untuk [OpenAI Codex CLI](https://github.com/openai/codex).

<table>
<tr>
<td><strong>🚨 PERHATIAN — DEFAULT YANG DIREKOMENDASIKAN HANYALAH macOS atau Linux dengan Codex CLI.</strong><br><br><strong>OMX terutama dirancang dan secara aktif dioptimalkan untuk jalur tersebut.</strong><br><strong>Windows native dan Codex App bukan pengalaman default, dapat bermasalah atau berperilaku tidak konsisten, dan saat ini mendapat dukungan yang lebih terbatas.</strong></td>
</tr>
</table>

OMX mempertahankan Codex sebagai execution engine dan mempermudah Anda untuk:
- memulai sesi Codex yang lebih kuat secara default
- menjalankan satu workflow yang konsisten dari klarifikasi hingga selesai
- menjalankan workflow kanonis dengan `$plan`, `$ultragoal`, `$team`, `$code-review`, dan `$ultraqa` — masing-masing dapat dipakai secara independen, tanpa urutan tetap
- menyimpan panduan proyek, rencana, log, dan state di `.omx/`

## Maintainer Utama

| Peran | Nama | GitHub |
| --- | --- | --- |
| Kreator & Lead | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Maintainer | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Maintainer | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## Duta

| Nama | GitHub |
| --- | --- |
| Sigrid Jin | [@sigridjineth](https://github.com/sigridjineth) |

## Kolaborator Utama

| Nama | GitHub |
| --- | --- |
| Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Junho Yeo | [@junhoyeo](https://github.com/junhoyeo) |
| JiHongKim98 | [@JiHongKim98](https://github.com/JiHongKim98) |
| Lor | [@gobylor](https://github.com/gobylor) |
| HyunjunJeon | [@HyunjunJeon](https://github.com/HyunjunJeon) |

## Alur default yang direkomendasikan

Jika Anda menginginkan pengalaman OMX default, mulai dari sini:

Pilih satu jalur instalasi. Jika Codex CLI sudah terinstal (Homebrew, npm, atau metode lain yang didukung):

```bash
codex --version
npm install -g oh-my-codex
# from the git project you want Codex to edit; choose a task-specific name
omx --worktree=feat/task --madmax --xhigh
```

Jika Anda belum memiliki Codex CLI dan ingin npm yang mengelolanya:

```bash
npm install -g @openai/codex
npm install -g oh-my-codex
```

Jangan menjalankan gabungan `npm install -g @openai/codex oh-my-codex` di atas binary `codex` yang sudah dimiliki Homebrew seperti `/opt/homebrew/bin/codex`; npm dapat gagal dengan `EEXIST` saat `@openai/codex` mencoba membuat binary yang sama. OMX hanya membutuhkan perintah `codex` yang berfungsi dan sudah terautentikasi di `PATH`; Codex tidak harus diinstal melalui npm.

Pada bump versi `oh-my-codex` yang sebenarnya, instalasi npm global sekarang mencetak pengingat eksplisit alih-alih menjalankan setup secara otomatis. Saat siap, jalankan perintah setup dengan scope di bawah atau gunakan `omx update` untuk memeriksa npm lalu menjalankan jalur refresh setup yang sama.

OMX juga memeriksa update npm saat launch dengan frekuensi yang dibatasi dan meminta konfirmasi sebelum menjadwalkan update setelah sesi saat ini selesai. Set `OMX_AUTO_UPDATE=0` untuk menonaktifkan pemeriksaan saat launch, atau set `OMX_AUTO_UPDATE=defer` untuk menjadwalkan update tertunda yang sama tanpa prompt konfirmasi.

Pilih scope setup dengan sengaja:
- Gunakan `omx setup --scope project --merge-agents` dari proyek git tempat OMX akan bekerja ketika repository tersebut seharusnya memiliki panduan `AGENTS.md` yang persisten.
- Gunakan `omx setup --scope user` untuk setup Codex tingkat user saat Anda tidak sedang menyiapkan direktori saat ini sebagai proyek OMX.
- Hindari menjalankan setup dengan scope project dari direktori home yang luas atau hub operasional, kecuali direktori tersebut memang sengaja menjadi proyek yang sedang ditinjau. `AGENTS.md` tingkat home sering berisi aturan keselamatan dan routing global; simpan panduan runtime OMX yang spesifik proyek di repository yang sebenarnya.

### Mempertahankan kebijakan merge AGENTS secara eksplisit

`omx setup --merge-agents`, `omx setup --no-merge-agents`, dan `omx setup --clear-merge-agents-policy` adalah satu-satunya selector kebijakan; gunakan bentuk polosnya (bukan bentuk `=value`). Mengulang selector yang sama tidak masalah, tetapi mencampur pilihan set dan clear akan gagal sebelum setup mengubah apa pun. Set eksplisit akan mengesampingkan kebijakan yang tersimpan.

Set eksplisit yang berhasil mencatat `mergeAgents: true` atau `false` di `./.omx/setup-scope.json` pada working root saat ini, bahkan ketika scope setup adalah `user`; kebijakan ini tidak pernah menjadi preferensi user global atau bocor ke root lain. `omx update` berikutnya akan memutar ulang kebijakan valid yang cocok untuk refresh langsung maupun tertunda.

`true` menggunakan branch merge yang sudah ada. `false` hanya menekan branch tersebut: nilai ini tidak menjanjikan preservasi, penggantian, atau mode keselamatan baru, sehingga perilaku prompt, skip, managed-refresh, plugin-default, dan force yang sudah ada tetap berlaku. Review dengan scope yang cocok mempertahankan kebijakan saat pengaturan lain berubah. Reset atau perubahan scope menghapus kebijakan warisan kecuali run setup yang sama secara eksplisit menetapkan `true` atau `false`; clear selalu menghapus kebijakan dan tidak dapat digabungkan dengan selector set.
Data tersimpan yang malformed, tidak dikenal, bukan boolean, atau memiliki scope yang salah akan diabaikan dengan aman.

`--force` bersifat independen dan sementara: flag ini tidak dicatat maupun diputar ulang, dan tidak mengesampingkan kebijakan merge eksplisit. Setup menyimpan intent set atau clear eksplisit secara atomik hanya setelah seluruh pekerjaan setup berhasil, termasuk ketika safeguard sesi aktif atau symlink plugin melewati penulisan `AGENTS.md` saat ini, sehingga refresh berikutnya dapat menghormati kebijakan yang diminta. Hal ini tidak menjadikan merge sebagai default atau menghidupkan kembali pendekatan merge-by-default #2892 yang ditolak.
Versi OMX yang lebih lama akan mengabaikan field tersebut dengan aman, tetapi mungkin menghapusnya saat menulis ulang preferensi setup yang dikenalnya.


**Catatan instalasi plugin Codex:** repo ini juga menyediakan layout plugin Codex resmi di `plugins/oh-my-codex` dengan metadata marketplace di `.agents/plugins/marketplace.json`. Plugin tersebut membundel permukaan skill yang dicerminkan beserta metadata pendamping dengan scope plugin untuk lifecycle hook resmi Codex, server kompatibilitas MCP opsional, dan app.
Plugin ini tetap **bukan** pengganti CLI global `oh-my-codex` plus setup dengan scope: hook dengan scope plugin menjalankan CLI `omx` yang terinstal, mode setup legacy menginstal agent dan prompt native, sedangkan mode setup plugin mengandalkan discovery plugin untuk skill yang dibundel sambil mengarsipkan/menghapus prompt dan TOML native-agent lama yang dikelola OMX agar file role usang tidak membayangi perilaku plugin.
Mode plugin tetap membutuhkan `AGENTS.md` dengan scope persisten (`~/.codex/AGENTS.md` untuk setup user atau `./AGENTS.md` untuk setup project) sebagai layer panduan orkestrasi yang persisten; file AGENTS dengan scope sesi hanya menggabungkan panduan persisten tersebut dengan overlay runtime dan bukan penggantinya.

Kemudian bekerja seperti biasa di dalam Codex:

```text
# Durable objective/checkpoints for a long task:
/goal Create a safe authentication refactor plan, implement it, and verify login, logout, and refresh-token behavior.

$deep-interview "clarify the authentication change"
$ralplan "approve the auth plan and review tradeoffs"
$ultragoal "turn the approved plan into durable Codex goals"
```

Itulah jalur utamanya.
Sebelum menganggap runtime siap, jalankan smoke test quick-start di bawah: `omx doctor` memverifikasi bentuk instalasi, sementara `omx exec` membuktikan bahwa runtime Codex aktif benar-benar dapat melakukan autentikasi dan menyelesaikan model call dari environment saat ini.
Mulai OMX dengan konfigurasi yang kuat, lakukan klarifikasi lebih dulu bila diperlukan, setujui rencana, lalu gunakan `$ultragoal` sebagai wrapper penyelesaian persisten default. Gunakan `$team` di dalam jalur eksekusi tersebut hanya ketika story Ultragoal tertentu membutuhkan pekerjaan paralel yang terkoordinasi; lanjutkan dengan `$ultragoal` untuk menjaga objective dan checkpoint tetap berjalan sampai selesai.

## Untuk apa OMX digunakan

Gunakan OMX jika Anda sudah menyukai Codex dan menginginkan runtime harian yang lebih baik di sekitarnya:
- workflow standar yang dibangun di sekitar `$deep-interview` -> `$ralplan` -> `$ultragoal`
- batasan research: gunakan `$best-practice-research` untuk evidence resmi/upstream biasa sebelum planning, `$autoresearch` untuk artifact research yang dibatasi dan melewati validator gate, `$autoresearch-goal` untuk mission research dalam goal mode, lalu masukkan temuan research ke `$ralplan` untuk sintesis arsitektur
- handoff multi-goal persisten dengan `$ultragoal` dan artifact `.omx/ultragoal` sebagai jalur penyelesaian default setelah planning
- role spesialis dan skill pendukung saat tugas membutuhkannya
- panduan proyek melalui `AGENTS.md` dengan scope
- state persisten di `.omx/` untuk rencana, log, memory, dan pelacakan mode

Jika Anda menginginkan Codex polos tanpa layer workflow tambahan, kemungkinan Anda tidak memerlukan OMX.

## Mulai cepat

### Persyaratan

- Node.js 20+
- Codex CLI terinstal, diverifikasi dengan `codex --version`, dan terautentikasi (Homebrew maupun npm sama-sama boleh; jangan instal ulang `@openai/codex` dengan npm jika Homebrew sudah memiliki `codex`)
- autentikasi Codex terkonfigurasi dan terlihat di shell/profile yang sama yang akan menjalankan OMX
- `tmux` di macOS/Linux jika Anda menginginkan runtime team persisten yang direkomendasikan
- `psmux` di Windows native hanya jika Anda memang menginginkan jalur team Windows yang dukungannya lebih terbatas

### Sesi pertama yang baik

Setelah instalasi, periksa kedua batas ini:

```bash
omx doctor
codex login status
omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"
```

`omx doctor` mendeteksi file OMX, hook, dan prerequisite runtime yang hilang. Smoke test sebenarnya mendeteksi masalah auth, profile, serta provider/base-URL yang baru muncul ketika Codex benar-benar melakukan request.

Launch OMX dengan cara yang direkomendasikan dari proyek git:

```bash
omx --worktree=feat/task --madmax --xhigh
```

Pada terminal interaktif macOS/Linux dengan `tmux` tersedia, ini memulai
leader di tmux detached yang dikelola OMX secara default agar pane HUD/runtime dapat
dibuat dan dipulihkan. `--worktree` juga memindahkan launch ke checkout git
terpisah, yang merupakan default lebih aman saat menggunakan `--madmax`. Ganti
`feat/task` dengan nama seperti branch untuk tugas tersebut.

### Percakapan standar secara bersamaan

Launch standar memiliki satu pointer sesi yang dapat ditulis di bawah `OMX_ROOT` yang dipilih. Karena itu, launch `omx` biasa kedua dari checkout yang sama akan fail-closed alih-alih berbagi atau diam-diam mengubah root tersebut. Berikan root eksplisit yang berbeda untuk setiap percakapan tambahan:

```bash
omx
OMX_ROOT="$HOME/.omx/instances/second-conversation" omx
OMX_ROOT="$HOME/.omx/instances/third-conversation" omx
```

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

Root yang ditentukan user bersifat literal: menjalankan dua kali dengan `OMX_ROOT` eksplisit yang sama tetap menghasilkan konflik owner fatal. Checkout terpisah memiliki root default terpisah, sementara `--worktree` dan `--madmax` mempertahankan perilaku isolasi yang sudah ada.

### Keamanan launch Madmax dan worktree

`--madmax` adalah shorthand OMX untuk Codex
`--dangerously-bypass-approvals-and-sandbox`. Flag ini menghapus guardrail approval dan
sandbox normal, jadi gunakan hanya di repository dan environment tepercaya.
`--high` dan `--xhigh` adalah shorthand untuk `-c model_reasoning_effort="high|xhigh"`; sesi kuat normal adalah `omx --madmax --xhigh` (atau `omx --worktree=feat/task --madmax --xhigh` dari proyek git).

Saat menggunakan `--madmax` dari repository git, pilih launch worktree alih-alih
menjalankannya langsung di checkout saat ini. Untuk pekerjaan yang dapat diulang atau berjalan bersamaan,
gunakan worktree bernama:

```bash
omx --worktree=feature/auth --madmax --xhigh
```

Jika Anda berada di luar repository git, hilangkan `--worktree`; launch worktree
memerlukan Git.

Untuk beberapa sesi `--madmax` yang berjalan bersamaan, **jangan** jalankan semuanya di
direktori yang sama. Berikan masing-masing sesi worktree bernama sendiri:

```bash
omx --worktree=feature/auth --madmax --xhigh
omx --worktree=fix/flaky-tests --madmax --xhigh
```

`--worktree` / `-w` tanpa nama membuat atau menggunakan kembali worktree launch detached di
`../<repo>.omx-worktrees/launch-detached`. `--worktree=<name>`,
`--worktree <name>`, atau `-w <name>` membuat atau menggunakan kembali worktree launch bernama
di bawah `../<repo>.omx-worktrees/` dan checkout nama branch tersebut. OMX mengonsumsi
flag worktree sebelum memulai Codex; flag ini tidak diteruskan ke Codex.
Perlakukan bentuk detached tanpa nama sebagai kemudahan sekali pakai: jika source checkout
maju setelah worktree tersebut dibuat, launch tanpa nama berikutnya dapat gagal dengan
`worktree_target_mismatch` karena `launch-detached` masih menunjuk ke HEAD
lama. Gunakan worktree bernama untuk pekerjaan berulang, atau hapus worktree detached
lama sebelum mencoba lagi.
Jika target worktree launch sudah dirty, OMX memperingatkan dan menjalankannya apa adanya, jadi
bersihkan, commit, atau stash worktree tersebut sebelum mengandalkannya untuk isolasi.

Untuk `omx team`, worker sudah menggunakan worktree khusus secara otomatis secara
default; `--worktree` pada `omx team` hanya merupakan override yang kompatibel dengan legacy.

Tool yang sadar repository menerima konteks kanonis yang sama pada runtime launch, team-worker, dan autoresearch: `OMX_REPO_ROOT`, `OMX_WORKTREE_ROOT`, `OMX_GIT_COMMON_DIR`, `OMX_WORKTREE_SCOPE`, `OMX_CODEGRAPH_MODE`, dan `OMX_CODEGRAPH_PROJECT_PATH`. `OMX_CODEGRAPH_MODE=auto` memilih `.codegraph/codegraph.db` lokal-worktree terlebih dahulu, lalu `.codegraph/codegraph.db` milik leader/repo, dan jika tidak ada akan menjadi `off`. Nilai eksplisit `shared`, `local`, dan `off` dihormati.
OMX tidak menginstal CodeGraph, melakukan auto-index worktree, atau menyalin/membuat symlink `.codegraph`; index leader bersama berguna untuk navigasi baseline tetapi tidak akurat terhadap branch untuk perubahan yang hanya ada di worktree.

Jika Anda menginginkan launch sekali pakai tanpa pengelolaan tmux/HUD OMX, gunakan `--direct`:

```bash
omx --direct --yolo
```

Untuk preferensi shell/profile yang persisten, set kebijakan environment:

```bash
OMX_LAUNCH_POLICY=direct omx --yolo
```

Kembali ke perilaku auto/default dengan:

```bash
unset OMX_LAUNCH_POLICY
```

Flag kebijakan CLI mengalahkan environment, dan flag kebijakan CLI terakhir sebelum
`--` yang berlaku:

```bash
OMX_LAUNCH_POLICY=direct omx --tmux --yolo
```

Gunakan `OMX_LAUNCH_POLICY=direct|tmux|detached-tmux|auto`. Iterasi ini hanya
menambahkan kontrol CLI dan environment; secara sengaja tidak menambahkan pengaturan config-file.
Jika Anda menjalankan `--direct` dari dalam pane tmux yang sudah ada, OMX tidak akan
membuat split HUD, mengaktifkan mouse mode, atau membungkus handling extended-key, tetapi
proses tetap berjalan di dalam pane terminal yang sudah terbuka tersebut.

Kemudian coba workflow kanonis:

```text
# Copy/pasteable durable-goal example:
/goal Ship the checkout bug fix with a durable objective, checkpoints for reproduction, implementation, regression tests, and final verification.

$plan "approve the checkout bug-fix plan and review tradeoffs"
$ultragoal "execute the approved checkout fix with checkpoint evidence"
```

Gunakan `$team` ketika story Ultragoal aktif membutuhkan pekerjaan paralel yang terkoordinasi.

### `/goal` dan pemilihan skill

Mulai sesi kuat normal dengan `omx --madmax --xhigh` (atau tambahkan `--worktree=<task>` di repo git). Di dalam sesi tersebut, lakukan eksekusi langsung atau gunakan `$ultragoal` untuk run multi-goal persisten, `$team` untuk pekerjaan paralel terkoordinasi, atau `$plan` saat tugas membutuhkan planning eksplisit terlebih dahulu. Gunakan `/goal` ketika tugas itu sendiri memerlukan struktur objektif/checkpoint persisten yang harus terus direkonsiliasi Codex lintas turn.

Tambahkan hanya 2-5 skill yang relevan secara default. Lebih banyak skill boleh digunakan jika scope tugas memang membutuhkannya, tetapi memuat katalog besar biasanya menjadi masalah context budget dan kualitas perhatian, bukan hard blocker parser/runtime. Perlakukan ini sebagai blocker runtime konkret hanya ketika sebuah perintah benar-benar error.

Pola yang perlu dihindari:

```text
omx --madmax --xhigh
# Then immediately load 20 skills "just in case" before stating the task.
# This bloats session context and makes the model spend attention on irrelevant workflows.
```

## Model mental sederhana

OMX **tidak** menggantikan Codex.

OMX menambahkan layer kerja yang lebih baik di sekitarnya:
- **Codex** melakukan pekerjaan agent yang sebenarnya
- **keyword role OMX** membuat role yang berguna dapat digunakan kembali
- **skill OMX** membuat workflow umum dapat digunakan kembali
- **`.omx/`** menyimpan rencana, log, memory, dan state runtime

Sebagian besar user sebaiknya memandang OMX sebagai **routing tugas yang lebih baik + workflow yang lebih baik + runtime yang lebih baik**, bukan sebagai antarmuka command yang harus dioperasikan manual sepanjang hari.

## Mulai dari sini jika Anda baru menggunakan OMX

1. Jika Codex CLI sudah ada, verifikasi dengan `codex --version` lalu instal atau update OMX dengan `npm install -g oh-my-codex`; jika belum, instal `@openai/codex` secara terpisah terlebih dahulu jika Anda ingin npm mengelola Codex
2. Setelah instalasi atau bump versi OMX yang sebenarnya, jalankan `omx setup --scope project --merge-agents` dari proyek git target atau `omx setup --scope user` untuk setup Codex tingkat user, atau gunakan `omx update` ketika Anda juga ingin npm memeriksa dan menginstal build terbaru sebelum me-refresh setup
3. Jalankan `omx doctor`
4. Jalankan smoke test eksekusi nyata: `codex login status` dan `omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"`
5. Launch dengan worktree bernama dari repo git, misalnya `omx --worktree=feat/task --madmax --xhigh`; jika Anda menjalankan beberapa sesi `--madmax` bersamaan, gunakan worktree bernama berbeda seperti `--worktree=feature/auth`
6. Gunakan `$deep-interview "..."` ketika request atau batasan masih belum jelas
7. Gunakan `$ralplan "..."` untuk menyetujui rencana dan meninjau tradeoff
8. Gunakan `$ultragoal` atau `$team` ketika tugas membutuhkan eksekusi persisten atau paralel; tambahkan `/goal` ketika struktur objektif/checkpoint persisten perlu dibuat eksplisit

## Workflow yang direkomendasikan

`$autopilot` adalah orchestrator kanonis kelas utama untuk workflow bertahap `$deep-interview -> $ralplan -> $ultragoal`. Rangkaian ini adalah default yang mendefinisikannya, sementara setiap tahap tetap dapat dijalankan secara independen ketika kontrak input dari tahap sebelumnya sudah terpenuhi.

1. `$deep-interview` — klarifikasi ambiguitas secara Sokratik dan iteratif, state yang dapat dilanjutkan, serta artifact requirement yang siap dieksekusi.
2. `$ralplan` — planning arsitektur, feasibility, dan konsensus berdasarkan artifact deep-interview.
3. `$ultragoal` — eksekusi multi-goal persisten dengan checkpoint ledger `.omx/ultragoal`.
4. `$team` — eksekusi paralel terkoordinasi ketika sebuah story mendapat manfaat dari beberapa lane.

`$deep-interview` adalah tahap requirement independen, bukan alias untuk `$plan --interview`, dan tidak pernah langsung mengimplementasikan. Skill planning berhenti pada artifact planning; perubahan kode membutuhkan lane eksekusi eksplisit (`$ultragoal` atau `$team`).

Di dalam story Ultragoal, gunakan `$team` hanya ketika story tersebut mendapat manfaat dari eksekusi paralel yang terkoordinasi.

## Antarmuka umum dalam sesi

| Permukaan | Gunakan untuk |
| --- | --- |
| `$plan "..."` | planning dan klarifikasi opsional (mode `--interview`) |
| `$ultragoal "..."` | penyelesaian multi-goal persisten setelah rencana disetujui |
| `$team "..."` | eksekusi paralel terkoordinasi ketika pekerjaan cukup besar |
| `/skills` | menjelajahi skill terinstal dan helper pendukung |
| `/goal ...` | struktur objektif/checkpoint persisten untuk tugas yang harus merekonsiliasi progress lintas turn |
| `omx mission <file>` | run batch prompt/checklist berurutan melalui `omx exec`, dengan artifact operator `.omx/missions/<slug>/summary.json` dan `ledger.jsonl` |

## Antarmuka advanced / operator

Ini berguna, tetapi bukan jalur onboarding utama.

### Runner mission queue

Gunakan `omx mission` ketika Anda memiliki checklist singkat prompt OmX/Codex yang harus dijalankan satu per satu alih-alih membuka perintah shell terpisah untuk setiap prompt. Mulai dengan `omx mission plan ./mission.md` atau `omx mission ./mission.md --dry-run` untuk memvalidasi parsing dan memeriksa summary persisten, lalu jalankan `omx mission run ./mission.md -- --model gpt-5` ketika prompt sudah siap.
Run yang terinterupsi dapat diperiksa dengan `omx mission status ./mission.md`, dilanjutkan dengan `omx mission resume ./mission.md`, diblokir operator dengan `omx mission mark ./mission.md --task task-002 --status blocked`, dan diperbaiki per task dengan `omx mission rerun ./mission.md --task task-002`. Lihat [`docs/mission.md`](../mission.md) untuk format input, output status, dan detail artifact.

### Runtime team

Gunakan runtime team ketika Anda memang membutuhkan koordinasi tmux/worktree yang persisten, bukan sebagai cara default untuk mulai menggunakan OMX. Di Codex App atau sesi biasa di luar tmux, perlakukan `omx team` sebagai antarmuka shell runtime tmux, bukan workflow yang langsung tersedia di dalam app; launch OMX CLI dari shell terlebih dahulu jika Anda memang ingin menjalankan team.

Ketika Team berjalan di dalam story Ultragoal, Ultragoal tetap menjadi state milik leader: worker melaporkan evidence yang siap menjadi checkpoint ke atas alih-alih memutasi `.omx/ultragoal` secara langsung. Startup Team menoleransi artifact Ultragoal yang stale atau malformed untuk pekerjaan yang tidak terkait, tetapi launch Team yang secara eksplisit terhubung ke Ultragoal tetap fail-closed.
Startup Team juga menulis `.omx/state/team/<team-name>/preflight-context.json` sehingga run Team besar dapat dilanjutkan setelah compaction dengan task awal, pembagian worker, konteks Ultragoal, dan checklist verifikasi.

Untuk pekerjaan atomik yang sangat kecil, Team dapat membatasi fanout implisit menjadi satu worker dan mencetak peringatan over-orchestration; berikan jumlah worker eksplisit hanya ketika biaya koordinasi tambahan memang disengaja.

```bash
omx team 3:executor "fix the failing tests with verification"
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

### Setup, doctor, dan HUD

Ini adalah antarmuka operator/dukungan:
- discovery/instalasi marketplace plugin Codex dapat menyimpan cache plugin di `${CODEX_HOME:-~/.codex}/plugins/cache/$MARKETPLACE_NAME/oh-my-codex/$VERSION/` (instalasi lokal dapat menggunakan `local` sebagai identifier versi); plugin terpaket tersebut menyertakan metadata pendamping dengan scope plugin untuk lifecycle hook resmi Codex, server kompatibilitas MCP opsional, dan app (MCP/app dinonaktifkan secara default), sehingga tetap dipasangkan dengan CLI `omx` yang terinstal untuk eksekusi runtime
- Setup dengan scope menginstal prompt, skill, scaffolding AGENTS, `.codex/config.toml`, dan (untuk instalasi legacy atau Codex lama tanpa `plugin_hooks`) hook native Codex yang dikelola OMX di `.codex/hooks.json`
  - refresh setup mempertahankan entry hook non-OMX di `.codex/hooks.json` dan hanya menulis ulang wrapper yang dikelola OMX
  - setup plugin mempertahankan `AGENTS.md` sebagai panduan persisten walaupun skill/hook yang dibundel berasal dari cache plugin; `omx doctor` menganggap hilangnya `AGENTS.md` dengan scope persisten dalam mode plugin sebagai check yang gagal karena file AGENTS dengan scope sesi jika tidak demikian hanya akan berisi panduan overlay runtime
  - `omx setup --merge-agents` mempertahankan panduan `AGENTS.md` proyek yang sudah ada sambil menyisipkan atau me-refresh bagian OMX yang dihasilkan di antara `<!-- OMX:AGENTS:START -->` / `<!-- OMX:AGENTS:END -->`; `--no-merge-agents` mencatat pilihan contextual non-merge secara eksplisit, dan `--clear-merge-agents-policy` selalu menghapus pilihan yang tercatat serta tidak dapat digabungkan dengan selector set.
Kebijakan disimpan per working root (bahkan untuk scope user), diputar ulang oleh update langsung maupun tertunda hanya ketika scope tersimpannya valid dan cocok, dan tidak pernah menjadi kebijakan force/default.
  - `omx uninstall` menghapus wrapper yang dikelola OMX dari `.codex/hooks.json` tetapi mempertahankan file tersebut ketika hook user masih ada
- `omx update` langsung memeriksa npm, menginstal build OMX global terbaru, lalu menjalankan kembali jalur refresh setup interaktif yang sama
- pemeriksaan update saat launch dibatasi frekuensinya dan meminta konfirmasi secara default; gunakan `OMX_AUTO_UPDATE=0` untuk menonaktifkannya atau `OMX_AUTO_UPDATE=defer` untuk menjadwalkan update tertunda tanpa prompt
- seeding config baru yang dikelola OMX untuk `gpt-5.6-sol` sekarang merekomendasikan `model_context_window = 250000` dan `model_auto_compact_token_limit = 200000`, tetapi hanya ketika key tersebut belum ada
- routing model/env `.omx-config.json` didokumentasikan di [referensi routing model/env](../reference/omx-config-schema-routing.md); hanya edit key yang didukung oleh versi OMX terinstal Anda
- `omx doctor` memverifikasi instalasi ketika ada sesuatu yang tampak salah; ini tidak membuktikan bahwa profile Codex aktif dapat melakukan model call yang terautentikasi
- `omx hud --watch` adalah antarmuka monitoring/status, bukan workflow utama user

Untuk sesi non-team, hook native Codex sekarang menjadi antarmuka lifecycle kanonis:
- `plugins/oh-my-codex/hooks/hooks.json` = registrasi hook resmi dengan scope plugin untuk instalasi plugin
- `.codex/hooks.json` = registrasi hook native Codex legacy/fallback yang dipertahankan untuk instalasi legacy dan versi Codex lama
- `.omx/hooks/*.mjs` = hook plugin OMX
- `omx tmux-hook` / notify-hook / derived watcher = jalur fallback tmux + runtime

Lihat [pemetaan hook native Codex](../codex-native-hooks.md) untuk matriks native / fallback saat ini.


### Troubleshooting readiness yang terlihat hijau padahal gagal

`omx doctor` yang hijau berarti instalasi dan wiring runtime lokal terlihat sehat. Jika eksekusi nyata masih gagal, periksa environment yang benar-benar digunakan Codex:

- Jalankan `codex login status` dan `omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"` dari shell/profile yang sama yang akan menjalankan OMX.
- Di shell dengan HOME, profile, container, atau service kustom, pastikan `~/.codex` aktif (atau `CODEX_HOME`) adalah yang memiliki auth dan config yang diharapkan. Jangan berasumsi `~/.codex` user normal Anda terlihat di sana.
- Jika Anda bergantung pada proxy lokal yang kompatibel dengan OpenAI, pastikan `~/.codex/config.toml` aktif menyertakan `openai_base_url` yang diharapkan; jika tidak, key yang diterbitkan proxy dapat dikirim ke endpoint default dan gagal dengan `401 Unauthorized`, `Missing bearer or basic authentication in header`, atau `Incorrect API key provided`.
- Jika `omx doctor --team` atau resume melaporkan team stale seperti `resume_blocker` atau sesi tmux yang hilang, bersihkan state runtime mati sebelum mencoba lagi:

```bash
omx team shutdown <team-name> --force --confirm-issues
omx cancel
omx doctor --team
```

Gunakan forced team shutdown hanya untuk team yang sudah Anda pastikan mati atau sengaja ditinggalkan.

Jika `Shift+Enter` masih mengirim alih-alih memasukkan newline di dalam sesi tmux yang dikelola OMX, lihat [Troubleshooting kesiapan eksekusi](../troubleshooting.md#shiftenter-submits-instead-of-inserting-a-newline-in-tmux-backed-omx-sessions). OMX saat ini sudah mengaktifkan forwarding extended-key tmux di sekitar jalur launch Codex miliknya, jadi kegagalan persisten biasanya merupakan masalah capability/discovery terminal tmux, bukan kekurangan fitur OMX baru.

### Sparkshell

- `omx sparkshell <command>` digunakan untuk inspeksi shell-native dan verifikasi berbatas
- untuk lookup repository read-only, gunakan tool/subagent inspeksi repository Codex biasa (perintah `omx explore` yang deprecated telah dihapus)
- override env sparkshell sengaja dibatasi: `OMX_SPARKSHELL_BIN` memilih path sidecar native, `OMX_SPARKSHELL_MODEL` memilih model summary utama, `OMX_SPARKSHELL_FALLBACK_MODEL` memilih model retry, `OMX_SPARKSHELL_MODEL_INSTRUCTIONS_FILE` memilih instruksi summary, dan `OMX_SPARKSHELL_SUMMARY_TIMEOUT_MS` mengontrol timeout summary API lokal

Contoh:

```bash
omx sparkshell git status
omx sparkshell --tmux-pane %12 --tail-lines 400
```
- Entri server MCP: `omx_state`, `omx_memory`, `omx_code_intel`, `omx_trace`, `omx_wiki` (server wiki repository), `omx_hermes` (jembatan terbatas untuk status dan koordinasi sesi)

### Wiki

- `omx wiki` adalah antarmuka JSON berbasis CLI untuk operasi wiki; MCP `omx_wiki` hanya untuk kompatibilitas eksplisit
- data wiki tersimpan sebagai knowledge proyek repository di bawah `omx_wiki/`
- wiki bersifat markdown-first dan search-first, bukan vector-first

Contoh:

```bash
omx wiki list --json
omx wiki query --input '{"query":"session-start lifecycle"}' --json
omx wiki lint --json
omx wiki refresh --json
```

### Catatan platform untuk mode team

`omx team` bekerja paling baik di macOS/Linux dengan `tmux`.
Windows native tetap menjadi jalur sekunder, dan WSL2 umumnya merupakan pilihan yang lebih baik jika Anda menginginkan setup yang di-host Windows.
Di Windows native, OMX menerima `psmux` sebagai binary yang kompatibel dengan tmux untuk jalur berbasis tmux yang sudah digunakannya.

| Platform | Instalasi |
| --- | --- |
| macOS | `brew install tmux` |
| Ubuntu/Debian | `sudo apt install tmux` |
| Fedora | `sudo dnf install tmux` |
| Arch | `sudo pacman -S tmux` |
| Windows | `winget install psmux` |
| Windows (WSL2) | `sudo apt install tmux` |

## Masalah yang diketahui

### Intel Mac: CPU `syspolicyd` / `trustd` tinggi saat startup

Di beberapa Intel Mac, startup OMX — terutama dengan `--madmax --high` — dapat menyebabkan penggunaan CPU `syspolicyd` / `trustd` melonjak ketika macOS Gatekeeper memvalidasi banyak process launch secara bersamaan.

Jika ini terjadi, coba:
- `xattr -dr com.apple.quarantine $(which omx)`
- tambahkan aplikasi terminal Anda ke allowlist Developer Tools di pengaturan Security macOS
- gunakan concurrency yang lebih rendah (misalnya, hindari `--madmax --high`)

## Dokumentasi

- [Memulai](../getting-started.html)
- [Panduan demo](../../DEMO.md)
- [Fitur wiki](../wiki-feature.md)
- [Katalog agent](../agents.html)
- [Referensi skill](../skills.html)
- [Pemetaan hook native Codex](../codex-native-hooks.md)
- [Pipeline identitas GitHub / PR / package](../pipeline/github-pr-package-identity.md)
- [Integrasi](../integrations.html)
- [Troubleshooting kesiapan eksekusi](../troubleshooting.md)
- [Panduan OpenClaw / notification gateway](../openclaw-integration.md)
- [Kontribusi](../../CONTRIBUTING.md)
- [Changelog](../../CHANGELOG.md)

## Bahasa

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

## Kontributor

| Peran | Nama | GitHub |
| --- | --- | --- |
| Kreator & Lead | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Maintainer | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Maintainer | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## Riwayat Star

[![Star History Chart](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-codex&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-codex&type=date&legend=top-left)

## Lisensi

MIT

## Benchmark visibilitas GEO

OmX menyertakan spec produk [`geobench`](https://github.com/NomaDamas/geobench) untuk mengukur hit rate LLM, MRR, share of voice, dan citation.

- Spec: [`geobench/oh-my-codex.yaml`](../../geobench/oh-my-codex.yaml)
- Runbook: [`docs/geobench.md`](../geobench.md)
