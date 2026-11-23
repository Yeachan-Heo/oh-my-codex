# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="oh-my-codex karakteri" width="280">
  <br>
  <em>Codex'i güçlü bir başlangıçla açın; iş büyüdükçe daha iyi promptlar, workflow'lar ve runtime yardımı OMX eklesin.</em>
</p>

[![npm version](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/wSyUQYfhAw)

**Web sitesi:** https://yeachan-heo.github.io/oh-my-codex-website/  
**Belgeler:** [Başlangıç](../getting-started.html) · [Ajanlar](../agents.html) · [Skill'ler](../skills.html) · [Entegrasyonlar](../integrations.html) · [Demo](../../DEMO.md) · [OpenClaw rehberi](../openclaw-integration.tr.md)  
**Topluluk:** [Discord](https://discord.gg/wSyUQYfhAw) — oh-my-codex, [gajae-code](https://github.com/Yeachan-Heo/gajae-code) ve ilgili araçlar için ortak Gajae sunucusu.

## Resmî proje ve paket

Resmî/orijinal OMX projesi bu depodur: [Yeachan-Heo/oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex). Resmî npm paketi [oh-my-codex](https://www.npmjs.com/package/oh-my-codex); kurulum için `npm install -g oh-my-codex` kullanın. README veya belgeler açıkça belirtmedikçe “OMX v2” gibi adlar taşıyan üçüncü taraf projeler resmî devam, değiştirme veya sürüm hattı değildir.

OMX, [OpenAI Codex CLI](https://github.com/openai/codex) için bir workflow katmanıdır. Codex yürütme motoru olarak kalır; OMX daha güçlü bir oturum başlatır, gereksinim netleştirmeden tamamlamaya tutarlı akış sağlar, beceri/rol yönlendirmesini tekrar kullanılabilir kılar ve proje talimatları ile durumu `.omx/` altında tutar. Öncelikli ve aktif olarak iyileştirilen yol macOS/Linux + Codex CLI'dır; yerel Windows ve Codex App daha az desteklenen ikincil seçeneklerdir.

OMX fazla kapsamlı geliyorsa [gajae-code](https://github.com/Yeachan-Heo/gajae-code) SDK tabanlı, daha hafif bir alternatif sunar ve Codex OAuth'ı OpenClaw, Hermes, Grokbot ve başka entegrasyonlar için kullanır.

## Ana Maintainer'lar

| Rol | İsim | GitHub |
| --- | --- | --- |
| Oluşturan ve lider | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Maintainer | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Maintainer | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## Elçiler

| İsim | GitHub |
| --- | --- |
| Sigrid Jin | [@sigridjineth](https://github.com/sigridjineth) |

## Öne çıkan katkıcılar

| İsim | GitHub |
| --- | --- |
| Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Junho Yeo | [@junhoyeo](https://github.com/junhoyeo) |
| JiHongKim98 | [@JiHongKim98](https://github.com/JiHongKim98) |
| Lor | [@gobylor](https://github.com/gobylor) |
| HyunjunJeon | [@HyunjunJeon](https://github.com/HyunjunJeon) |

## Önerilen varsayılan akış

Tek bir kurulum yolu seçin. Codex CLI zaten yüklüyse:

```bash
codex --version
npm install -g oh-my-codex
# Codex'in düzenleyeceği git projesinde, göreve özel bir ad seçin
omx --worktree=feat/task --madmax --xhigh
```

Codex CLI yoksa ve npm'in yönetmesini istiyorsanız:

```bash
npm install -g @openai/codex
npm install -g oh-my-codex
```

Homebrew tarafından yönetilen mevcut `codex` ikilisinin üzerine `@openai/codex` ve OMX'i birlikte kurmayın; npm aynı ikiliyi oluşturmaya çalışırken `EEXIST` verebilir. OMX'in ihtiyacı, `PATH` üzerinde çalışan ve kimlik doğrulaması yapılmış bir `codex` komutudur. Gerçek OMX sürüm yükseltmesinden sonra global npm kurulumu otomatik setup çalıştırmak yerine hatırlatma gösterir; hazır olduğunuzda `omx setup` veya `omx update` kullanın. Başlangıçtaki npm güncelleme denetimi aralıklıdır ve oturum sonrasında güncelleme planlamadan önce sorar. `OMX_AUTO_UPDATE=0` denetimi kapatır; `OMX_AUTO_UPDATE=defer` onaysız olarak ertelenmiş güncelleme planlar.

Setup kapsamını bilinçli seçin:
- Proje repo'sunda `omx setup --scope project --merge-agents`, kalıcı `AGENTS.md` rehberliğini o proje yönetsin diye kullanılır.
- Kullanıcı düzeyinde kurulum için `omx setup --scope user` seçin.
- Home gibi geniş bir dizini gerçekten proje olarak incelemiyorsanız proje setup'ını oradan çalıştırmayın.

### AGENTS merge politikasını kaydetme

`--merge-agents`, `--no-merge-agents` ve `--clear-merge-agents-policy` tek geçerli politika seçicileridir; `=value` yazımı kullanmayın. Açık seçim, geçerli işlem kökündeki `./.omx/setup-scope.json` içine kaydedilir; global kullanıcı tercihi değildir. `true` mevcut merge dalını, `false` yalnızca o dalın bastırılmasını seçer; yeni koruma veya değiştirme garantisi vermez. Clear seçimi her zaman kaydedilmiş politikayı kaldırır ve set seçimiyle birleştirilemez. `--force` geçicidir, kaydedilmez ve açık politikayı geçersiz kılmaz. Başarılı setup tamamlanmadan seçim yazılmaz. Eski OMX sürümleri bu alanı güvenle yok sayabilir, ancak bilinen ayarları yeniden yazarken silebilir.

**Codex plugin kurulumu:** depoda `plugins/oh-my-codex` altında resmî Codex plugin paketi de bulunur. Paketli skill'ler, companion metadata ve resmi Codex yaşam döngüsü hook'ları sağlar; global `omx` CLI'ın yerine geçmez. Her iki setup modu da normalde native agent TOML dosyaları kurar. Plugin modu için kullanıcı veya proje scope'unda kalıcı `AGENTS.md` gerekir. Sahiplik kuralları için [Plugin bundle SSOT](../plugin-bundle-ssot.md) belgesine bakın. `omx setup --disable-hooks` OMX hook kayıtlarını kapatır.

Uzun görevlerde kalıcı hedef ve checkpoint kullanabilirsiniz:

```text
/goal Kimlik doğrulama refactor'ünü planla, uygula ve login, logout, token yenilemeyi doğrula.

$deep-interview "kimlik doğrulama değişikliğini netleştir"
$ralplan "planı ve ödünleşimleri onayla"
$ultragoal "planı kalıcı Codex hedeflerine dönüştür"
```

Çalışma ortamını hazır saymadan önce `omx doctor` ve gerçek istek yapan smoke testi çalıştırın: `codex login status` ve `omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"`. Team'i yalnızca Ultragoal içindeki belirli bir iş koordinasyondan yararlanacaksa kullanın.

## OMX ne işe yarar

Codex'i seviyorsanız ama günlük runtime'ı güçlendirmek istiyorsanız OMX'i kullanın:
- standart `$deep-interview` → `$ralplan` → `$ultragoal` akışı;
- sıradan resmi/upstream araştırma için `$best-practice-research`, doğrulayıcıyla sınırlı araştırma çıktıları için `$autoresearch`;
- `.omx/ultragoal` checkpoint'leriyle kalıcı çok hedefli görev aktarımı;
- uzman roller, yeniden kullanılabilir skill'ler ve scope'lu `AGENTS.md`;
- `.omx/` altında plan, log, bellek ve çalışma durumu.

Ek workflow katmanı istemiyorsanız OMX'e ihtiyacınız olmayabilir.

## Hızlı başlangıç

### Gereksinimler
- Node.js 20+
- Yüklü, doğrulanmış ve kimliği açılmış Codex CLI (`codex --version`)
- OMX'i başlatan shell profilinde görünür Codex kimlik doğrulaması
- Önerilen kalıcı Team runtime'ı için macOS/Linux'ta `tmux`; yerel Windows Team yolu için `psmux`

### İyi bir ilk oturum

```bash
omx doctor
codex login status
omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"
```
omx --worktree=feat/task --madmax --xhigh
```
```

`omx doctor` dosyaları, hook'ları ve önkoşulları kontrol eder. Gerçek smoke testi auth, profil ve sağlayıcı ayarlarını gerçek bir Codex isteğiyle doğrular.

### Birden çok standart konuşma

Standart başlatma seçilen `OMX_ROOT` altında tek bir yazılabilir session pointer'a sahiptir; aynı checkout'tan ikinci sıradan `omx` başlatması fail-closed olur. Her ek konuşmaya ayrı kök verin:

```bash
omx
OMX_ROOT="$HOME/.omx/instances/second-conversation" omx
```

PowerShell'de `$env:OMX_ROOT`, cmd'de `%USERPROFILE%` kullanın. Aynı açık root ile iki çalıştırma sahiplik çakışmasıdır; farklı checkout'lar varsayılan root'larını ayırır.

### PowerShell ve Komut İstemi'nde OMX_ROOT

PowerShell:
```powershell
$env:OMX_ROOT = "$HOME/.omx/instances/second-conversation"
omx
```

Komut İstemi:
```bat
set "OMX_ROOT=%USERPROFILE%\.omx\instances\second-conversation"
omx
```

### Madmax ve worktree güvenliği

`--madmax`, `--dangerously-bypass-approvals-and-sandbox` seçeneğinin kısa yazımıdır; normal onay ve sandbox korumalarını kaldırır. Yalnızca güvenilir repo ve ortamlarda kullanın. Git repo'sunda özellikle eşzamanlı işler için isimli worktree tercih edin:

```bash
Tek görev için adlandırılmış worktree:
```bash
omx --worktree=feature/auth --madmax --xhigh
```

omx --worktree=feature/auth --madmax --xhigh
omx --worktree=fix/flaky-tests --madmax --xhigh
```

`--worktree` ayrı git checkout açar; isimsiz biçim detached geçici worktree oluşturur. Kirli worktree'de uyarı verir ama başlatır. `--direct`, tmux/HUD yönetimi olmadan tek seferlik başlatır; `OMX_LAUNCH_POLICY=direct|tmux|detached-tmux|auto` kalıcı tercih belirler, CLI bayrakları önce gelir. Bu iterasyon config dosyasına yeni ayar eklemez.

Doğrudan başlatma:
```bash
omx --direct --yolo
```

Profil tercihi:
```bash
OMX_LAUNCH_POLICY=direct omx --yolo
```

Otomatik davranışa dönme:
```bash
unset OMX_LAUNCH_POLICY
```

CLI bayrakları ortam değişkeninden önce gelir; son CLI politika bayrağı geçerlidir:
```bash
OMX_LAUNCH_POLICY=direct omx --tmux --yolo
```

### /goal ve skill seçimi

`omx --madmax --xhigh` ile başlatın; git içinde `--worktree=<task>` ekleyin. Kalıcı hedef/checkpoint için `/goal`, plan için `$plan`, paralel koordinasyon için `$team`, çok aşamalı kalıcı yürütme için `$ultragoal` kullanın. Varsayılan olarak yalnızca ilgili 2–5 skill'i yükleyin.

Kalıcı checkout hedefi örneği:
```text
/goal Checkout düzeltmesini yeniden üretim, uygulama, regresyon testleri ve son doğrulama checkpoint'leriyle tamamla.

$plan "checkout düzeltme planını ve ödünleşimleri onayla"
$ultragoal "onaylanan düzeltmeyi checkpoint kanıtıyla yürüt"
```

Anti-pattern: görevi belirtmeden önce çok sayıda skill yüklemeyin:
```text
omx --madmax --xhigh
# Görevi anlatmadan önce "ne olur ne olmaz" diye 20 skill yüklemeyin.
# Bu bağlamı şişirir ve ilgisiz workflow'lara dikkati harcar.
```

## Basit zihinsel model

OMX, Codex'in yerini almaz:
- **Codex** gerçek işi yürütür.
- **OMX rol keyword'leri** tekrar kullanılabilir uzman rolleri sağlar.
- **OMX skill'leri** workflow'ları tekrar kullanılabilir kılar.
- **`.omx/`** planları, logları, belleği ve runtime durumunu saklar.

OMX'i komut yüzeyi yerine daha iyi yönlendirme, workflow ve runtime katmanı olarak düşünün.

## Yeni başlayanlar için

1. Codex CLI'ı doğrulayın veya kurun, ardından `oh-my-codex` yükleyin.
2. Kurulum veya gerçek OMX sürüm yükseltmesi sonrası scope'a göre `omx setup --scope project --merge-agents` ya da `omx setup --scope user` çalıştırın; `omx update` npm'i de güncelleyebilir.
3. `omx doctor` çalıştırın.
4. `codex login status` ve gerçek `omx exec` smoke testiyle doğrulayın.
5. Git repo'sunda isimli worktree kullanın; paralel Madmax oturumlarını ayırın.
6. Belirsizliği `$deep-interview` ile giderin.
7. Planı `$ralplan` ile değerlendirin.
8. Kalıcı veya paralel işte `$ultragoal`/`$team`, açık checkpoint için `/goal` kullanın.

## Önerilen workflow

`$autopilot` aşamalı resmi orkestratördür: `$deep-interview` → `$ralplan` → `$ultragoal`. Gereksinimler önceden hazırsa her aşama bağımsız da çağrılabilir.

1. `$deep-interview` — belirsizliği çözer, uygulanabilir gereksinim çıkarır.
2. `$ralplan` — mimari, yapılabilirlik ve ortak kararı değerlendirir.
3. `$ultragoal` — `.omx/ultragoal` kayıtlarıyla çok hedefli yürütme sağlar.
4. `$team` — yalnızca gerçekten paralel koordinasyon gerekirse.

Planlama skill'leri plan üretir, uygulama yapmaz. Task'e göre `$plan`, `$code-review` ve `$ultraqa` da bağımsız kullanılabilir.

## Oturum içi yaygın yüzeyler

| Yüzey | Kullanım |
| --- | --- |
| `$plan` | isteğe bağlı planlama ve netleştirme |
| `$ultragoal` | onaylı plandan sonra kalıcı çok hedefli tamamlama |
| `$team` | koordineli paralel uygulama |
| `/skills` | kurulu skill kataloğunu görme |
| `/goal` | tur geçişleri boyunca uzlaşılması gereken kalıcı hedef |
| `omx mission <file>` | sırayla çalışan prompt/checklist ve `.omx/missions/` artefaktları |

## Gelişmiş ve operatör yüzeyleri

- `omx mission plan ./mission.md` ve `--dry-run` planı doğrular; `run`, `status`, `resume`, `mark` ve `rerun` işleri yönetir. [Mission rehberi](../mission.md).
- `omx session search` / `export` önceki konuşmaları bulur ve dışa aktarır; `--format json`, `--include-tools` ve `--codex-home` desteklenir. Varsayılan dışa aktarım yalnızca user/assistant mesajlarını içerir; sistem talimatları ve akıl yürütme dışarıda kalır, metin redakte edilmez.
- `omx session usage --since 7d --sort tokens` yerel oturumların kayıtlı kümülatif kullanımını gösterir; dönem faturası değildir. Aynı oturum aynaları bir kez sayılır; eksik ölçüm bilinmiyor kalır.
- `omx session timeline <id>` tool çağrılarını, sonuçları, süreleri ve compaction'ları gösterir; hata belirtilmemesi başarılı olduğu anlamına gelmez.
- `omx team` tmux/worktree koordinasyon runtime'ıdır. Codex App veya tmux dışındaki oturumlarda uygulama içi workflow değil, shell yüzeyidir. `team status` salt okunur; durumu değiştirmez.
- `omx setup` scoped varlık/config kurar; `omx update` npm'i kontrol edip aynı refresh yolunu çalıştırır. `omx doctor` gerçek model auth çağrısını kanıtlamaz; `omx hud --watch` izleme yüzeyidir.
- Plugin cache `${CODEX_HOME:-~/.codex}/plugins/cache/...` altına kurulabilir; plugin lifecycle hook'ları taşır ama runtime için `omx` CLI gerekir. `omx setup --disable-hooks` OMX hook kurulumunu kapatır. [Hook eşlemesi](../codex-native-hooks.md).
- `.omx-config.json` model/env routing ayarları için kullanılır; yalnızca kurulu sürümün desteklediği anahtarları yazın: [şema](../reference/omx-config-schema-routing.md). Guardex HUD için proje yerel `.omx/hud-config.json` dosyasına `"guardex": { "enabled": true }` ekleyin.
- «Yeşil ama çalışmıyor» durumunda aynı shell'de `codex login status`, `CODEX_HOME` ve varsa `openai_base_url` değerlerini kontrol edin. Zorla Team kapatmayı yalnızca doğrulanmış ölü/terk edilmiş ekip için kullanın.
- `omx sparkshell` shell inceleme ve sınırlı doğrulama içindir; repo aramasında normal Codex araçları tercih edilir. `omx wiki`, `omx_wiki/` içindeki Markdown bilgi tabanı için CLI-first JSON yüzeyidir.

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

Team komutları:
```bash
omx team 3:executor "fix the failing tests with verification"
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

Zorla temizliği yalnızca team'in öldüğünü ya da bilerek terk edildiğini doğruladıktan sonra kullanın:
```bash
omx team shutdown <team-name> --force --confirm-issues
omx cancel
omx doctor --team
```

### Team için platform notları

Team, macOS/Linux + `tmux` ile en iyi çalışır. Yerel Windows ikinci plandadır; çoğunlukla WSL2 daha uygundur. Windows'ta mevcut tmux uyumlu yollar `psmux` kabul eder.

| Platform | Kurulum |
| --- | --- |
| macOS | `brew install tmux` |
| Ubuntu/Debian | `sudo apt install tmux` |
| Fedora | `sudo dnf install tmux` |
| Arch | `sudo pacman -S tmux` |
| Windows | `winget install psmux` |
| Windows (WSL2) | `sudo apt install tmux` |

## Bilinen sorunlar

### Intel Mac'te başlangıç sırasında yüksek `syspolicyd` / `trustd` CPU kullanımı

Bazı Intel Mac'lerde Gatekeeper, özellikle `--madmax --high` ile çok sayıda süreç açılırken CPU kullanımını yükseltebilir. `xattr -dr com.apple.quarantine $(which omx)`, Terminal uygulamasını Developer Tools izin listesine ekleme veya eşzamanlılığı azaltma seçeneklerini deneyin.

tmux oturumunda Shift+Enter davranışıyla ilgili sorunlar için [Troubleshooting](../troubleshooting.md#shiftenter-submits-instead-of-inserting-a-newline-in-tmux-backed-omx-sessions) sayfasına bakın.

## Belgeler

- [Başlangıç](../getting-started.html)
- [Demo](../../DEMO.md)
- [Wiki özelliği](../wiki-feature.md)
- [Ajan kataloğu](../agents.html)
- [Skill başvurusu](../skills.html)
- [Codex native hook eşlemesi](../codex-native-hooks.md)
- [GitHub/PR/paket kimlik hattı](../pipeline/github-pr-package-identity.md)
- [Entegrasyonlar](../integrations.html)
- [Troubleshooting](../troubleshooting.md)
- [OpenClaw/bildirim rehberi](../openclaw-integration.tr.md)
- [Katkıda bulunma](../../CONTRIBUTING.md)
- [Değişiklik günlüğü](../../CHANGELOG.md)

## Diller

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

## Katkıda bulunanlar

| Rol | İsim | GitHub |
| --- | --- | --- |
| Oluşturan ve lider | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Maintainer | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Maintainer | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## Yıldız geçmişi

[![Star History](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-codex&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-codex&type=date)

## Lisans

MIT

## GEO görünürlük kıyaslaması

OMX, LLM hit rate, MRR, share of voice ve alıntıları ölçmek için [geobench](https://github.com/NomaDamas/geobench) ürün spesifikasyonu içerir.

- Spesifikasyon: [geobench/oh-my-codex.yaml](../../geobench/oh-my-codex.yaml)
- Çalıştırma rehberi: [geobench.md](../geobench.md)
