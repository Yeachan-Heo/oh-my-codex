# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex character" width="280">
  <br>
  <em>Codex'iniz yalnız değil.</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

> **[Website](https://yeachan-heo.github.io/oh-my-codex-website/)** | **[Documentation](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** | **[CLI Reference](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** | **[Workflows](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** | **[GitHub](https://github.com/Yeachan-Heo/oh-my-codex)** | **[npm](https://www.npmjs.com/package/oh-my-codex)**

[OpenAI Codex CLI](https://github.com/openai/codex) için çok ajanlı orkestrasyon katmanı.

## Diller

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


OMX, Codex'i tek oturumlu bir ajandan koordineli bir sisteme dönüştürür:
- Uzmanlaşmış ajanlar için role prompts (`/prompts:name`)
- Tekrarlanabilir çalışma modları için workflow skills (`$name`)
- tmux'ta takım orkestrasyonu (`omx team`, `$team`)
- MCP sunucuları aracılığıyla kalıcı durum ve bellek

## Neden OMX

Codex CLI doğrudan görevler için güçlüdür. OMX daha büyük işler için yapı ekler:
- Ayrıştırma ve aşamalı yürütme (`team-plan -> team-prd -> team-exec -> team-verify -> team-fix`)
- Kalıcı mod yaşam döngüsü durumu (`.omx/state/`)
- Uzun süreli oturumlar için bellek ve notepad yüzeyleri
- Başlatma, doğrulama ve iptal için operasyonel kontroller

OMX bir eklentidir, fork değil. Codex'in yerel uzantı noktalarını kullanır.

## Gereksinimler

- macOS veya Linux (Windows WSL2 ile)
- Node.js >= 20
- Codex CLI kurulu (`npm install -g @openai/codex`)
- Codex kimlik doğrulaması yapılandırılmış

## Hızlı Başlangıç (3 dakika)

```bash
npm install -g oh-my-codex
omx setup
omx doctor
```

Güvenilir ortam için önerilen başlatma profili:

```bash
omx --xhigh --madmax
```

## v0.5.0'daki Yenilikler

- `omx setup --scope user|project` ile **kapsam duyarlı kurulum** — esnek kurulum modları.
- `--spark` / `--madmax-spark` ile **Spark worker yönlendirmesi** — takım çalışanlarının lider modelini zorlamadan `gpt-5.3-codex-spark` kullanabilmesi.
- **Katalog birleştirme** — kullanımdan kaldırılmış prompt'lar (`deep-executor`, `scientist`) ve 9 kullanımdan kaldırılmış skill kaldırıldı.
- **Bildirim ayrıntı seviyeleri** — CCNotifier çıktısı için ince taneli kontrol.

## İlk Oturum

Codex içinde:

```text
/prompts:architect "analyze current auth boundaries"
/prompts:executor "implement input validation in login"
$plan "ship OAuth callback safely"
$team 3:executor "fix all TypeScript errors"
```

Terminalden:

```bash
omx team 4:executor "parallelize a multi-module refactor"
omx team status <team-name>
omx team shutdown <team-name>
```

## Temel Model

OMX şu katmanları kurar ve bağlar:

```text
User
  -> Codex CLI
    -> AGENTS.md (orkestrasyon beyni)
    -> ~/.codex/prompts/*.md (ajan prompt kataloğu)
    -> ~/.agents/skills/*/SKILL.md (skill kataloğu)
    -> ~/.codex/config.toml (özellikler, bildirimler, MCP)
    -> .omx/ (çalışma zamanı durumu, bellek, planlar, günlükler)
```

## Ana Komutlar

```bash
omx                # Codex'i başlat (tmux'ta HUD ile birlikte)
omx setup          # Prompt/skill/config'i kapsama göre kur + proje AGENTS.md/.omx
omx doctor         # Kurulum/çalışma zamanı tanılamaları
omx doctor --team  # Team/swarm tanılamaları
omx team ...       # tmux takım çalışanlarını başlat/durum/devam et/kapat
omx status         # Aktif modları göster
omx cancel         # Aktif çalışma modlarını iptal et
omx reasoning <mode> # low|medium|high|xhigh
omx tmux-hook ...  # init|status|validate|test
omx hooks ...      # init|status|validate|test (eklenti uzantı iş akışı)
omx hud ...        # --watch|--json|--preset
omx help
```

## Hooks Uzantısı (Ek Yüzey)

OMX artık eklenti iskelesi ve doğrulaması için `omx hooks` içerir.

- `omx tmux-hook` desteklenmeye devam eder ve değişmemiştir.
- `omx hooks` ek niteliktedir ve tmux-hook iş akışlarını değiştirmez.
- Eklenti dosyaları `.omx/hooks/*.mjs` konumunda bulunur.
- Eklentiler varsayılan olarak kapalıdır; `OMX_HOOK_PLUGINS=1` ile etkinleştirin.

Tam uzantı iş akışı ve olay modeli için `docs/hooks-extension.md` dosyasına bakın.

## Başlatma Bayrakları

```bash
--yolo
--high
--xhigh
--madmax
--force
--dry-run
--verbose
--scope <user|project>  # yalnızca setup
```

`--madmax`, Codex `--dangerously-bypass-approvals-and-sandbox` ile eşlenir.
Yalnızca güvenilir/harici sandbox ortamlarında kullanın.

### MCP workingDirectory politikası (isteğe bağlı sertleştirme)

Varsayılan olarak, MCP durum/bellek/trace araçları çağıranın sağladığı `workingDirectory` değerini kabul eder.
Bunu kısıtlamak için bir izin listesi belirleyin:

```bash
export OMX_MCP_WORKDIR_ROOTS="/path/to/project:/path/to/another-root"
```

Ayarlandığında, bu kökler dışındaki `workingDirectory` değerleri reddedilir.

## Codex-First Prompt Kontrolü

Varsayılan olarak, OMX şunu enjekte eder:

```text
-c model_instructions_file="<cwd>/AGENTS.md"
```

Bu, proje `AGENTS.md` yönlendirmesini Codex başlatma talimatlarına katmanlar.
Codex davranışını genişletir, ancak Codex çekirdek sistem politikalarını değiştirmez/atlamaz.

Kontroller:

```bash
OMX_BYPASS_DEFAULT_SYSTEM_PROMPT=0 omx     # AGENTS.md enjeksiyonunu devre dışı bırak
OMX_MODEL_INSTRUCTIONS_FILE=/path/to/instructions.md omx
```

## Takım Modu

Paralel çalışanlardan fayda sağlayan geniş kapsamlı işler için takım modunu kullanın.

Yaşam döngüsü:

```text
start -> assign scoped lanes -> monitor -> verify terminal tasks -> shutdown
```

Operasyonel komutlar:

```bash
omx team <args>
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

Önemli kural: İptal etmiyorsanız, görevler hâlâ `in_progress` durumundayken kapatmayın.

### Ralph Temizlik Politikası

Bir takım ralph modunda çalıştığında (`omx team ralph ...`), kapatma temizliği
normal yoldan farklı özel bir politika uygular:

| Davranış | Normal takım | Ralph takımı |
|---|---|---|
| Başarısızlıkta zorla kapatma | `shutdown_gate_blocked` hatası verir | Kapıyı atlar, `ralph_cleanup_policy` olayını günlükler |
| Otomatik dal silme | Geri almada worktree dallarını siler | Dalları korur (`skipBranchDeletion`) |
| Tamamlanma günlükleme | Standart `shutdown_gate` olayı | Görev dökümü ile ek `ralph_cleanup_summary` olayı |

Ralph politikası takım modu durumundan (`linked_ralph`) otomatik algılanır veya
`omx team shutdown <name> --ralph` ile açıkça belirtilebilir.

Takım çalışanları için Worker CLI seçimi:

```bash
OMX_TEAM_WORKER_CLI=auto    # varsayılan; worker --model "claude" içeriyorsa claude kullanır
OMX_TEAM_WORKER_CLI=codex   # Codex CLI çalışanlarını zorla
OMX_TEAM_WORKER_CLI=claude  # Claude CLI çalışanlarını zorla
OMX_TEAM_WORKER_CLI_MAP=codex,codex,claude,claude  # çalışan başına CLI karışımı (uzunluk=1 veya çalışan sayısı)
OMX_TEAM_AUTO_INTERRUPT_RETRY=0  # isteğe bağlı: adaptif queue->resend geri dönüşünü devre dışı bırak
```

Notlar:
- Worker başlatma argümanları hâlâ `OMX_TEAM_WORKER_LAUNCH_ARGS` aracılığıyla paylaşılır.
- `OMX_TEAM_WORKER_CLI_MAP`, çalışan başına seçim için `OMX_TEAM_WORKER_CLI`'yi geçersiz kılar.
- Tetikleyici gönderimi varsayılan olarak adaptif yeniden denemeler kullanır (queue/submit, ardından gerektiğinde güvenli clear-line+resend geri dönüşü).
- Claude worker modunda, OMX çalışanları düz `claude` olarak başlatır (ekstra başlatma argümanı yok) ve açık `--model` / `--config` / `--effort` geçersiz kılmalarını yok sayar, böylece Claude varsayılan `settings.json` kullanır.

## `omx setup` Ne Yazar

- `.omx/setup-scope.json` (kalıcı kurulum kapsamı)
- Kapsama bağlı kurulumlar:
  - `user`: `~/.codex/prompts/`, `~/.agents/skills/`, `~/.codex/config.toml`, `~/.omx/agents/`
  - `project`: `./.codex/prompts/`, `./.agents/skills/`, `./.codex/config.toml`, `./.omx/agents/`
- Başlatma davranışı: kalıcı kapsam `project` ise, `omx` başlatma otomatik olarak `CODEX_HOME=./.codex` kullanır (`CODEX_HOME` zaten ayarlanmadıysa).
- Mevcut `AGENTS.md` varsayılan olarak korunur. Etkileşimli TTY çalıştırmalarında, üzerine yazmadan önce setup sorar; `--force` sormadan üzerine yazar (aktif oturum güvenlik kontrolleri hâlâ geçerlidir).
- `config.toml` güncellemeleri (her iki kapsam için):
  - `notify = ["node", "..."]`
  - `model_reasoning_effort = "high"`
  - `developer_instructions = "..."`
  - `[features] multi_agent = true, child_agents_md = true`
  - MCP sunucu girişleri (`omx_state`, `omx_memory`, `omx_code_intel`, `omx_trace`)
  - `[tui] status_line`
- Proje `AGENTS.md`
- `.omx/` çalışma zamanı dizinleri ve HUD yapılandırması

## Ajanlar ve Skill'ler

- Prompt'lar: `prompts/*.md` (`user` için `~/.codex/prompts/`'a, `project` için `./.codex/prompts/`'a kurulur)
- Skill'ler: `skills/*/SKILL.md` (`user` için `~/.agents/skills/`'a, `project` için `./.agents/skills/`'a kurulur)

Örnekler:
- Ajanlar: `architect`, `planner`, `executor`, `debugger`, `verifier`, `security-reviewer`
- Skill'ler: `autopilot`, `plan`, `team`, `ralph`, `ultrawork`, `cancel`

## Proje Yapısı

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

## Geliştirme

```bash
git clone https://github.com/Yeachan-Heo/oh-my-codex.git
cd oh-my-codex
npm install
npm run build
npm test
```

## Dokümantasyon

- **[Tam Dokümantasyon](https://yeachan-heo.github.io/oh-my-codex-website/docs.html)** — Eksiksiz kılavuz
- **[CLI Referansı](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#cli-reference)** — Tüm `omx` komutları, bayraklar ve araçlar
- **[Bildirim Kılavuzu](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#notifications)** — Discord, Telegram, Slack ve webhook kurulumu
- **[Önerilen İş Akışları](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#workflows)** — Yaygın görevler için savaşta test edilmiş skill zincirleri
- **[Sürüm Notları](https://yeachan-heo.github.io/oh-my-codex-website/docs.html#release-notes)** — Her sürümdeki yenilikler

## Notlar

- Tam değişiklik günlüğü: `CHANGELOG.md`
- Geçiş rehberi (v0.4.4 sonrası mainline): `docs/migration-mainline-post-v0.4.4.md`
- Kapsam ve eşitlik notları: `COVERAGE.md`
- Hook uzantı iş akışı: `docs/hooks-extension.md`
- Kurulum ve katkı detayları: `CONTRIBUTING.md`

## Teşekkürler

[oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode)'dan ilham alınmıştır, Codex CLI için uyarlanmıştır.

## Lisans

MIT
