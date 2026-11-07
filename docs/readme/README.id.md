# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex character" width="280">
  <br>
  <em>Mulai dengan Codex yang lebih kuat; saat pekerjaan berkembang, OMX menambahkan prompt, alur kerja, dan dukungan runtime yang lebih baik.</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/wSyUQYfhAw)

**Situs web:** https://yeachan-heo.github.io/oh-my-codex-website/  
**Dokumentasi:** [Memulai](../../docs/getting-started.html) · [Agen](../../docs/agents.html) · [Skill](../../docs/skills.html) · [Integrasi](../../docs/integrations.html) · [Demo](../../DEMO.md) · [Panduan OpenClaw](../openclaw-integration.md)  
**Komunitas:** [Discord](https://discord.gg/wSyUQYfhAw) — server komunitas Gajae bersama untuk oh-my-codex, [gajae-code](https://github.com/Yeachan-Heo/gajae-code), dan alat terkait.

## Proyek dan paket resmi

Proyek OMX resmi adalah repositori ini, [Yeachan-Heo/oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex), dan paket npm resminya adalah [oh-my-codex](https://www.npmjs.com/package/oh-my-codex). Instal dengan `npm install -g oh-my-codex`. Proyek atau fork pihak ketiga yang memakai nama seperti “OMX v2” bukan penerus, pengganti, atau lini rilis resmi kecuali README atau dokumentasi ini menyatakannya. Jika ragu, gunakan repositori ini dan paket npm tersebut sebagai target instalasi resmi.

OMX adalah lapisan alur kerja untuk [OpenAI Codex CLI](https://github.com/openai/codex). Codex tetap menjadi mesin eksekusi; OMX membantu memulai sesi standar yang lebih kuat, menjalankan alur kerja konsisten, memanggil alur kerja secara mandiri seperti `$plan`, `$ultragoal`, `$team`, `$code-review`, dan `$ultraqa`, serta menyimpan panduan proyek dan status persisten di `.omx/`.

> ⚠️ **Lingkungan default yang disarankan: macOS atau Linux dengan Codex CLI.** OMX terutama dirancang dan disetel untuk jalur ini. Windows native dan Codex App bukan pengalaman default, dapat bermasalah atau berperilaku tidak konsisten, dan saat ini mendapat dukungan lebih terbatas.

## Pemelihara inti

| Peran | Nama | GitHub |
| --- | --- | --- |
| Pembuat & Lead | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Pemelihara | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Pemelihara | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## Duta dan kontributor utama

- Duta: Sigrid Jin ([@sigridjineth](https://github.com/sigridjineth))
- Kontributor utama: Doyun Ha, Junho Yeo, JiHongKim98, Lor, dan HyunjunJeon. Lihat daftar lengkap di [GitHub](https://github.com/Yeachan-Heo/oh-my-codex/graphs/contributors).

## Alur default yang direkomendasikan

Jika Codex CLI sudah terpasang:

```bash
codex --version
npm install -g oh-my-codex
# Jalankan dari proyek Git yang ingin diedit Codex; gunakan nama khusus untuk tugas.
omx --worktree=feat/task --madmax --xhigh
```

Jika Codex CLI belum ada dan ingin dikelola oleh npm:

```bash
npm install -g @openai/codex
npm install -g oh-my-codex
```

Jangan pasang Codex melalui npm di atas binary `codex` yang sudah dikelola Homebrew (misalnya `/opt/homebrew/bin/codex`); hal ini dapat menyebabkan `EEXIST`. OMX hanya memerlukan perintah `codex` yang berfungsi dan sudah terautentikasi di PATH, bukan Codex yang dipasang melalui npm. Setelah peningkatan versi OMX yang sebenarnya, setup tidak berjalan otomatis; jalankan `omx setup --scope project --merge-agents` atau `omx update`. Pemeriksaan pembaruan npm saat peluncuran dibatasi frekuensinya dan meminta konfirmasi. Gunakan `OMX_AUTO_UPDATE=0` untuk menonaktifkannya, atau `OMX_AUTO_UPDATE=defer` untuk menjadwalkan pembaruan setelah sesi selesai tanpa prompt.

Pilih cakupan setup dengan sengaja: jalankan `omx setup --scope project --merge-agents` dari proyek Git target bila proyek harus memiliki panduan persisten `AGENTS.md`; gunakan `omx setup --scope user` untuk setup Codex tingkat pengguna. Hindari setup proyek dari direktori home yang luas kecuali direktori tersebut memang proyek target. Kebijakan merge disimpan per root kerja, bukan kebijakan force/default. Bagian yang dikelola OMX berada di antara `<!-- OMX:AGENTS:START -->` dan `<!-- OMX:AGENTS:END -->`.

Repositori ini juga menyediakan tata letak plugin Codex resmi di `plugins/oh-my-codex`. Mode plugin tetap menjalankan CLI `omx` yang terpasang dan memerlukan `AGENTS.md` persisten untuk panduan orkestrasi. `omx setup --disable-hooks` menonaktifkan hook milik OMX lalu berhenti sebelum instalasi aset dan konfigurasi normal.

Setelah instalasi, periksa:

```bash
omx doctor
codex login status
omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"
```

`omx doctor` memeriksa file OMX, hook, dan prasyarat runtime. Smoke test eksekusi nyata memverifikasi autentikasi, profil, dan endpoint Codex di shell yang sedang digunakan.

## Sesi pertama dan keamanan peluncuran

Di terminal interaktif macOS/Linux dengan tmux, OMX secara default menjalankan leader dalam detached tmux yang dikelola OMX sehingga pane HUD/runtime dapat dibuat dan dipulihkan. `--worktree` memindahkan peluncuran ke Git checkout terpisah dan merupakan pilihan lebih aman saat memakai `--madmax`. Gunakan worktree bernama untuk pekerjaan berulang atau bersamaan.

`--madmax` adalah singkatan Codex untuk `--dangerously-bypass-approvals-and-sandbox`; ini menghapus perlindungan persetujuan dan sandbox normal, jadi hanya gunakan pada repositori dan lingkungan tepercaya. `--high` dan `--xhigh` adalah singkatan pengaturan reasoning effort. Gunakan nama seperti `--worktree=feature/auth` untuk worktree berulang. `--worktree` tanpa nama membuat worktree detached sekali pakai; jika HEAD checkout sumber berubah setelahnya, peluncuran berikutnya dapat gagal dengan `worktree_target_mismatch`. Worktree target yang kotor hanya diberi peringatan lalu dijalankan, jadi bersihkan, commit, atau stash terlebih dahulu bila isolasi penting. Worker Team secara default mendapat worktree khusus.

Peluncuran biasa memiliki satu pointer sesi yang dapat ditulis di `OMX_ROOT` terpilih. Peluncuran biasa kedua dari checkout yang sama gagal agar root tidak dibagi atau berubah diam-diam. Berikan root unik untuk percakapan tambahan:

```bash
omx
OMX_ROOT="$HOME/.omx/instances/second-conversation" omx
```

PowerShell: `$env:OMX_ROOT = "$HOME/.omx/instances/second-conversation"`  
Command Prompt: `set "OMX_ROOT=%USERPROFILE%\.omx\instances\second-conversation"`

Menjalankan dua kali dengan `OMX_ROOT` eksplisit yang sama menyebabkan konflik pemilik. Checkout berbeda memiliki root default sendiri. Alat repo-aware menerima konteks `OMX_*` untuk root repo/worktree, Git common dir, dan mode CodeGraph. Mode auto memilih database lokal worktree, lalu database leader/repo, atau off. OMX tidak memasang, mengindeks otomatis, menyalin, atau membuat symlink CodeGraph; indeks bersama berguna untuk navigasi baseline tetapi mungkin tidak akurat untuk perubahan khusus worktree.

Untuk peluncuran sekali tanpa pengelolaan tmux/HUD OMX, gunakan `omx --direct --yolo`; preferensi shell persisten dapat menggunakan `OMX_LAUNCH_POLICY=direct omx --yolo`. Pilihan kebijakan: `direct|tmux|detached-tmux|auto`; flag CLI mengalahkan environment. Di dalam pane tmux yang sudah ada, `--direct` tidak membuat split HUD baru tetapi proses tetap berjalan di pane tersebut.

## Untuk apa OMX digunakan

OMX tidak menggantikan Codex. Codex melakukan pekerjaan agen; keyword role OMX membuat peran dapat digunakan kembali, skill membuat alur kerja umum dapat digunakan kembali, dan `.omx/` menyimpan rencana, log, memori, serta status runtime. Anggap OMX sebagai lapisan untuk routing tugas, alur kerja, dan runtime yang lebih baik—bukan permukaan perintah untuk dioperasikan manual sepanjang hari. Jika Codex biasa sudah memenuhi kebutuhan, Anda mungkin tidak memerlukan OMX.

## Mulai di sini jika Anda baru menggunakan OMX

1. Pastikan Codex CLI dengan `codex --version`, lalu instal/perbarui OMX memakai `npm install -g oh-my-codex`. Jika npm akan mengelola Codex, pasang `@openai/codex` secara terpisah terlebih dahulu.
2. Setelah peningkatan OMX, jalankan `omx setup --scope project --merge-agents` di proyek target atau `omx setup --scope user` untuk setup pengguna. Gunakan `omx update` bila npm juga perlu memeriksa dan memasang build terbaru.
3. Jalankan `omx doctor`.
4. Jalankan `codex login status` dan smoke test `omx exec` di atas.
5. Di repo Git, mulai dengan worktree bernama; setiap sesi `--madmax` bersamaan harus menggunakan worktree berbeda.
6. Gunakan `$deep-interview` bila permintaan atau batasannya masih belum jelas.
7. Gunakan `$ralplan` untuk menyetujui rencana dan meninjau trade-off.
8. Gunakan `/goal` untuk tujuan/checkpoint persisten, `$ultragoal` untuk eksekusi beberapa tujuan yang persisten, dan `$team` untuk koordinasi paralel.

## Alur kerja yang direkomendasikan

`$autopilot` adalah orkestrator bertahap utama dengan alur default `$deep-interview -> $ralplan -> $ultragoal`. Setiap tahap dapat dipanggil secara mandiri jika kontrak input sebelumnya sudah terpenuhi.

1. `$deep-interview` — klarifikasi iteratif untuk mengatasi ambiguitas dan menghasilkan persyaratan siap eksekusi.
2. `$ralplan` — meninjau arsitektur, kelayakan, dan konsensus berdasarkan hasil wawancara.
3. `$ultragoal` — eksekusi multi-tujuan persisten dengan checkpoint ledger `.omx/ultragoal`.
4. `$team` — eksekusi paralel terkoordinasi bila pekerjaan mendapat manfaat dari beberapa lane.

`$deep-interview` adalah tahap persyaratan mandiri, bukan alias `$plan --interview`, dan tidak melakukan implementasi. Skill perencanaan berhenti pada artefak rencana; perubahan kode memerlukan lane eksekusi eksplisit (`$ultragoal` atau `$team`). Di dalam story Ultragoal, gunakan Team hanya bila koordinasi paralel bermanfaat.

### Permukaan umum dalam sesi

| Permukaan | Kegunaan |
| --- | --- |
| `$plan "..."` | Perencanaan dan klarifikasi opsional |
| `$ultragoal "..."` | Penyelesaian multi-tujuan persisten setelah rencana disetujui |
| `$team "..."` | Eksekusi paralel terkoordinasi untuk pekerjaan cukup besar |
| `/skills` | Menjelajahi skill terpasang dan bantuan pendukung |
| `/goal ...` | Tujuan/checkpoint persisten yang harus diselaraskan lintas giliran |
| `omx mission <file>` | Batch prompt/checklist berurutan melalui `omx exec` |

## Permukaan lanjutan/operator

### Runner antrean Mission

Gunakan `omx mission plan ./mission.md` atau `omx mission ./mission.md --dry-run` untuk memvalidasi input, lalu `omx mission run ./mission.md -- --model gpt-5` untuk menjalankannya. Run yang terhenti dapat diperiksa dengan `status`, dilanjutkan dengan `resume`, ditandai dengan `mark --status blocked`, atau diperbaiki per tugas dengan `rerun --task`. Ringkasan dan ledger operator disimpan di `.omx/missions/<slug>/`. Lihat [dokumentasi Mission](../../docs/mission.md).

### Ekspor percakapan sebelumnya

Temukan ID dengan `omx session search "frasa yang diingat"`, lalu ekspor dengan `omx session export <session-id> --output conversation.md`. Mendukung ID persis atau prefix unik dan transcript aktif/arsip dari Codex home yang sama. Gunakan `--format json`, `--include-tools`, atau `--codex-home <path>`. Tanpa `--output`, hasil dikirim ke stdout; file yang sudah ada tidak ditimpa. Secara default hanya pesan user dan assistant yang disertakan; instruksi system/developer dan catatan reasoning dikecualikan, tetapi teks pesan tidak disamarkan. Lihat [session export](../../docs/session-export.md).

### Penggunaan token dan timeline eksekusi

`omx session usage --since 7d --sort tokens` memeriksa total penggunaan token tercatat pada sesi lokal aktif dan arsip. Gunakan `--project current`, `--session`, `--json`, `--codex-home`, atau `--limit` untuk mempersempit tampilan. Rentang memilih sesi berdasarkan aktivitas terakhir yang tercatat, sehingga hitungan dapat mencakup pekerjaan sebelumnya dan bukan laporan tagihan/pemakaian dalam periode itu. Mirror sesi dihitung sekali; data yang hilang ditandai unknown. Lihat [session usage](../../docs/session-usage.md).

`omx session timeline <session-id>` menampilkan tool call, batas giliran, compaction konteks, error, durasi tanpa mengekspor teks percakapan. Contoh filter: `--kind tools --sort duration --limit 10`, `--status failed`, `--tool <name>`, `--json --output timeline.json`. Filter/paginasi hanya mengubah daftar event; ringkasan tetap mencakup seluruh sesi. Durasi tak diketahui tetap unknown, dan hasil tanpa error eksplisit bukan bukti bahwa operasi berhasil. Lihat [session timeline](../../docs/session-timeline.md).

### Runtime Team

Gunakan runtime Team hanya bila membutuhkan koordinasi tmux/worktree yang persisten, bukan sebagai cara default memulai OMX. Di Codex App atau sesi tanpa tmux, perlakukan `omx team` sebagai antarmuka runtime shell, bukan workflow in-app; jalankan OMX CLI dari shell terlebih dahulu bila ingin Team. Pada story Ultragoal, status tujuan tetap dimiliki leader dan worker melaporkan bukti checkpoint ke atas. Konteks preflight disimpan agar run besar dapat dilanjutkan. Untuk pekerjaan atomik kecil, fanout implisit dapat dibatasi ke satu worker disertai peringatan orkestrasi berlebih.

```bash
omx team 3:executor "fix the failing tests with verification"
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

`omx team status` dan `omx tmux-hook status` hanya mengamati status yang ada; keduanya tidak mengambil claim kedaluwarsa, mengirim pesan mailbox, mengintegrasikan commit worker, atau mengubah runtime. Jika konfigurasi hook tidak ada, status hanya melaporkan kondisi tersebut; gunakan `omx tmux-hook init` untuk menginisialisasi secara eksplisit.

### Setup, doctor, dan HUD

Codex plugin marketplace dapat menyimpan plugin di `${CODEX_HOME:-~/.codex}/plugins/cache/$MARKETPLACE_NAME/oh-my-codex/$VERSION/`. Bundle menyertakan metadata hook lifecycle resmi Codex, server kompatibilitas MCP opsional, dan apps (MCP/apps nonaktif secara default), tetapi eksekusi runtime tetap memakai CLI `omx` yang terpasang. Bergantung cakupan, setup mengelola prompt, skill, scaffolding AGENTS, konfigurasi, dan hook native untuk instalasi lama/Codex versi lama. Refresh mempertahankan hook non-OMX dan hanya menulis ulang wrapper OMX; uninstall tetap menyimpan file bila hook pengguna masih ada.

`omx update` segera memeriksa npm, memasang build global OMX terbaru, lalu mengulang refresh setup interaktif yang sama. Setup baru menggunakan `gpt-6-astra` sebagai default untuk agent frontier/standard/spark dan mempertahankan konfigurasi pengguna serta override eksplisit. Lihat [referensi model/env routing](../../docs/reference/omx-config-schema-routing.md) dan hanya ubah key yang didukung versi terpasang. `omx doctor` memvalidasi instalasi lokal, bukan keberhasilan panggilan model terautentikasi. `omx hud --watch` adalah permukaan status/monitor.

HUD menampilkan nama Team dan jumlah worker aktif, serta status, task ID, role, pane tmux, dan umur pembaruan setiap agent. Data yang hilang ditampilkan sebagai unknown; status working bukan pemeriksaan proses hidup. File Team dibaca tanpa diubah. Progress GitGuardex hanya muncul bila `"guardex": { "enabled": true }` diaktifkan pada `.omx/hud-config.json` proyek. Worker yang tidak muat di layar diringkas sebagai `+N workers`.

Untuk sesi non-Team, hook native Codex adalah permukaan lifecycle utama: registrasi plugin ada di `plugins/oh-my-codex/hooks/hooks.json`; fallback legacy/versi Codex lama di `.codex/hooks.json`; hook plugin OMX di `.omx/hooks/*.mjs`; tmux/notify/watcher adalah jalur fallback runtime. Lihat [pemetaan Codex native hooks](../../docs/codex-native-hooks.md).

### Diagnosis kesiapan yang tampak baik tetapi eksekusi gagal

`omx doctor` hijau berarti instalasi dan wiring runtime lokal terlihat normal. Jika eksekusi nyata tetap gagal, jalankan `codex login status` dan tes `omx exec` dari shell/profile yang sama dengan yang akan menjalankan OMX. Dalam HOME, profile, container, atau service shell khusus, pastikan `CODEX_HOME` yang aktif berisi auth/config yang diharapkan. Jika memakai proxy lokal kompatibel OpenAI, pastikan `openai_base_url` di `config.toml` aktif benar. Jika resume Team melaporkan team usang atau tmux session hilang, paksa shutdown hanya setelah memastikan team memang mati/ditinggalkan; lalu jalankan `omx cancel` dan `omx doctor --team`.

Jika Shift+Enter di sesi tmux masih mengirim pesan alih-alih membuat baris baru, lihat [pemecahan masalah kesiapan eksekusi](../../docs/troubleshooting.md#shiftenter-submits-instead-of-inserting-a-newline-in-tmux-backed-omx-sessions). Masalah yang menetap biasanya terkait kapabilitas/penemuan terminal tmux, bukan gap fitur OMX.

### Sparkshell dan Wiki

- `omx sparkshell <command>` untuk inspeksi native shell dan verifikasi terbatas. Untuk pencarian repo read-only, gunakan tool/child agent repository standar Codex; perintah lama `omx explore` sudah dihapus.
- Model ringkasan utama dan fallback Sparkshell default-nya `gpt-6-astra`. `OMX_SPARKSHELL_FALLBACK_MODEL` mengatur fallback berbeda; variabel `OMX_SPARKSHELL_*` lain memilih binary, model, file instruksi, dan batas waktu ringkasan.
- `omx wiki` adalah antarmuka JSON CLI-first; MCP `omx_wiki` hanya untuk kompatibilitas. Data wiki ada di `omx_wiki/` sebagai pengetahuan proyek Markdown, berorientasi pencarian, bukan vektor.

```bash
omx sparkshell git status
omx wiki list --json
omx wiki query --input '{"query":"session-start lifecycle"}' --json
omx wiki lint --json
omx wiki refresh --json
```

### Catatan platform untuk Team

Team paling baik digunakan di macOS/Linux dengan tmux. Windows native adalah jalur sekunder; WSL2 umumnya lebih disarankan. Di Windows native, `psmux` dapat digunakan sebagai binary kompatibel tmux untuk jalur yang sudah didukung.

| Platform | Instalasi |
| --- | --- |
| macOS | `brew install tmux` |
| Ubuntu/Debian | `sudo apt install tmux` |
| Fedora | `sudo dnf install tmux` |
| Arch | `sudo pacman -S tmux` |
| Windows | `winget install psmux` |
| Windows (WSL2) | `sudo apt install tmux` |

## Masalah yang diketahui

Pada sebagian Intel Mac, startup OMX—terutama dengan `--madmax --high`—dapat menaikkan penggunaan CPU `syspolicyd`/`trustd` saat Gatekeeper memvalidasi banyak proses bersamaan. Coba:

- `xattr -dr com.apple.quarantine $(which omx)`
- Tambahkan aplikasi terminal ke daftar Developer Tools di pengaturan Security macOS
- Kurangi konkurensi, misalnya hindari `--madmax --high`

## Dokumentasi

- [Memulai](../../docs/getting-started.html) · [Panduan demo](../../DEMO.md) · [Fitur Wiki](../../docs/wiki-feature.md) · [Katalog agen](../../docs/agents.html) · [Referensi skill](../../docs/skills.html)
- [Pemetaan Codex native hook](../../docs/codex-native-hooks.md) · [Pipeline identitas GitHub/PR/package](../../docs/pipeline/github-pr-package-identity.md) · [Integrasi](../../docs/integrations.html)
- [Pemecahan masalah](../../docs/troubleshooting.md) · [Panduan gateway OpenClaw/notifikasi](../openclaw-integration.md) · [Kontribusi](../../CONTRIBUTING.md) · [Changelog](../../CHANGELOG.md)

## Bahasa

- [English](../../README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [简体中文](README.zh.md) · [繁體中文](README.zh-TW.md) · [Tiếng Việt](README.vi.md) · [Español](README.es.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [Türkçe](README.tr.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Italiano](README.it.md) · [Ελληνικά](README.el.md) · [Polski](README.pl.md) · [Українська](README.uk.md) · [Bahasa Indonesia](README.id.md)

## Kontributor

| Peran | Nama | GitHub |
| --- | --- | --- |
| Pembuat & Lead | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Pemelihara | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Pemelihara | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## Riwayat Star

[![Star History Chart](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-codex&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-codex&type=date&legend=top-left)

## Lisensi

MIT

## Benchmark visibilitas GEO

OMX menyertakan spesifikasi produk [`geobench`](https://github.com/NomaDamas/geobench) untuk mengukur hit rate LLM, MRR, share of voice, dan sitasi.

- Spesifikasi: [`geobench/oh-my-codex.yaml`](../../geobench/oh-my-codex.yaml)
- Runbook: [`docs/geobench.md`](../../docs/geobench.md)
