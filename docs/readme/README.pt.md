# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="Personagem do oh-my-codex" width="280">
  <br>
  <em>Comece com um Codex mais forte e deixe o OMX acrescentar melhores prompts, fluxos de trabalho e suporte de runtime conforme a tarefa crescer.</em>
  <br><br>
  <strong>Gosta do OMX, mas acha-o excessivo? <a href="https://github.com/Yeachan-Heo/gajae-code">Experimente o gajae-code</a>.</strong><br>
  <sub>Mantenha o OAuth do Codex com um caminho baseado em SDK mais rápido, barato, simples e poderoso para OpenClaw, Hermes, Grokbot e outras integrações.</sub>
</p>

[![versão npm](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![Licença: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/wSyUQYfhAw)

**Site:** https://yeachan-heo.github.io/oh-my-codex-website/

**Documentação:** [Primeiros passos](../getting-started.html) · [Agentes](../agents.html) · [Skills](../skills.html) · [Integrações](../integrations.html) · [Demonstração](../../DEMO.md) · [Guia do OpenClaw](../../docs/openclaw-integration.md)

**Comunidade:** [Discord](https://discord.gg/wSyUQYfhAw), servidor compartilhado da comunidade Gajae para oh-my-codex, [gajae-code](https://github.com/Yeachan-Heo/gajae-code) e ferramentas relacionadas.

## Projeto e pacote oficiais

O projeto OMX oficial/original é este repositório, [`Yeachan-Heo/oh-my-codex`](https://github.com/Yeachan-Heo/oh-my-codex), e o pacote npm oficial é [`oh-my-codex`](https://www.npmjs.com/package/oh-my-codex). Instale-o com `npm install -g oh-my-codex` (ou junto ao Codex CLI, como mostrado abaixo).

Projetos de terceiros ou forks que usem nomes como “OMX v2” não são continuações, substituições ou linhas de lançamento oficiais deste repositório, a menos que este README ou a documentação digam explicitamente o contrário. Em caso de dúvida, considere este repositório e o pacote `oh-my-codex` como destino oficial de instalação.

OMX é uma camada de fluxo de trabalho para o [OpenAI Codex CLI](https://github.com/openai/codex).

<table>
<tr>
<td><strong>🚨 AVISO — EXPERIÊNCIA PADRÃO RECOMENDADA: macOS ou Linux com Codex CLI.</strong><br><br><strong>O OMX foi projetado principalmente e é otimizado ativamente para esse caminho.</strong><br><strong>Windows nativo e Codex App não são a experiência padrão, podem falhar ou se comportar de forma inconsistente e recebem menos suporte atualmente.</strong></td>
</tr>
</table>

O OMX mantém o Codex como mecanismo de execução e facilita:
- iniciar por padrão uma sessão Codex mais robusta
- seguir um fluxo coerente, do esclarecimento até a conclusão
- invocar fluxos canônicos de forma independente com `$plan`, `$ultragoal`, `$team`, `$code-review` e `$ultraqa`, sem uma cadeia fixa
- manter orientações, planos, registros e estado do projeto em `.omx/`

## Mantenedores principais

| Papel | Nome | GitHub |
| --- | --- | --- |
| Criador e líder | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Mantenedor | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Mantenedor | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## Embaixadores

| Nome | GitHub |
| --- | --- |
| Sigrid Jin | [@sigridjineth](https://github.com/sigridjineth) |

## Principais colaboradores

| Nome | GitHub |
| --- | --- |
| Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Junho Yeo | [@junhoyeo](https://github.com/junhoyeo) |
| JiHongKim98 | [@JiHongKim98](https://github.com/JiHongKim98) |
| Lor | [@gobylor](https://github.com/gobylor) |
| HyunjunJeon | [@HyunjunJeon](https://github.com/HyunjunJeon) |

## Fluxo padrão recomendado

Para a experiência padrão do OMX, comece aqui. Escolha um caminho de instalação.

Se o Codex CLI já estiver instalado (Homebrew, npm ou outro método compatível):

```bash
codex --version
npm install -g oh-my-codex
# no repositório Git que você quer editar com Codex; escolha um nome específico para a tarefa
omx --worktree=feat/task --madmax --xhigh
```

Se ainda não tem o Codex CLI e quer que o npm o gerencie:

```bash
npm install -g @openai/codex
npm install -g oh-my-codex
```

Não execute `npm install -g @openai/codex oh-my-codex` sobre um binário `codex` existente gerenciado pelo Homebrew, como `/opt/homebrew/bin/codex`: o npm pode falhar com `EEXIST` ao tentar criar o mesmo binário. O OMX só precisa de um comando `codex` funcional e autenticado no `PATH`; não exige que o Codex tenha sido instalado via npm.

Ao instalar uma nova versão do `oh-my-codex`, o npm agora mostra um lembrete explícito em vez de iniciar o setup automaticamente. Quando estiver pronto, execute o comando de setup com o escopo apropriado ou use `omx update` para verificar o npm e então atualizar o setup.

O OMX também verifica atualizações do npm na inicialização, com frequência limitada, e pede confirmação antes de agendá-las para depois da sessão atual. Use `OMX_AUTO_UPDATE=0` para desativar a verificação, ou `OMX_AUTO_UPDATE=defer` para agendar a atualização sem pedir confirmação.

Escolha o escopo do setup deliberadamente:
- Use `omx setup --scope project --merge-agents` no projeto Git em que o OMX trabalhará quando o repositório deve ser responsável pelas orientações duráveis `AGENTS.md`.
- Use `omx setup --scope user` para configurar o Codex no nível do usuário quando o diretório atual não for um projeto OMX.
- Evite setup de projeto em um diretório pessoal amplo ou hub operacional, a menos que ele seja o projeto em questão. O `AGENTS.md` do usuário costuma conter regras globais de segurança e roteamento; mantenha as orientações de runtime específicas do projeto no repositório correto.

### Política explícita de mesclagem de AGENTS

`omx setup --merge-agents`, `omx setup --no-merge-agents` e `omx setup --clear-merge-agents-policy` são os únicos seletores de política; use essas formas sem `=valor`. Repetir o mesmo seletor é inofensivo, mas combinar opções de definir e limpar faz o setup falhar antes de qualquer alteração. Uma definição explícita prevalece sobre a política salva. Se bem-sucedida, grava `mergeAgents: true` ou `false` em `./.omx/setup-scope.json` da raiz de trabalho atual, mesmo quando o escopo for `user`; não é uma preferência global nem se propaga a outra raiz. O `omx update` reproduz uma política válida e correspondente tanto em atualizações imediatas como adiadas.

`true` usa a mesclagem existente. `false` apenas suprime esse caminho; não promete preservar, substituir ou criar um novo modo de segurança. Continuam valendo os comportamentos existentes de prompts, omissões, atualização gerenciada, padrões de plugin e `--force`. Uma revisão com o mesmo escopo conserva a política enquanto outras configurações mudam. Redefinir ou trocar o escopo remove a política herdada, salvo se a mesma execução definir `true` ou `false`; limpar sempre remove a política e não pode ser combinado com um seletor de definição. Dados salvos malformados, desconhecidos, não booleanos ou de escopo incorreto são ignorados com segurança.

`--force` é independente e temporário: não é salvo nem reproduzido, e não substitui uma política explícita. O setup registra atomicamente a intenção explícita de definir ou limpar apenas depois que todo o trabalho é concluído, mesmo quando proteções de sessão ativa ou de link simbólico do plugin impedem a gravação do `AGENTS.md` atual. Isso não torna a mesclagem padrão nem recupera a abordagem rejeitada de mesclar sempre (#2892). Versões antigas do OMX ignoram o campo com segurança, mas podem apagá-lo ao regravar as preferências conhecidas.

**Nota sobre a instalação do plugin Codex:** este repositório também fornece um layout oficial de plugin em `plugins/oh-my-codex`, com metadados de marketplace em `.agents/plugins/marketplace.json`. O plugin inclui skills espelhadas e metadados complementares para hooks oficiais do ciclo de vida do Codex, servidores MCP opcionais e apps. Ele não substitui o CLI global `oh-my-codex` nem o setup por escopo: os hooks do plugin iniciam o CLI instalado `omx`, e ambos os modos de setup normalmente instalam TOMLs de agentes nativos para roteamento `agent_type`. Em qualquer modo, `omx setup --disable-hooks` desativa os registros de hooks mantidos pelo OMX e termina antes da instalação normal de recursos, configuração, `AGENTS.md`, HUD e estado. O modo legado também instala cópias de prompts e skills. O modo plugin descobre as skills empacotadas, arquiva/remove cópias legadas de prompts gerenciadas pelo OMX e remove arquivos de agentes nativos gerados que estejam obsoletos ou não possam ser instalados. Sem `--force`, preserva arquivos de papel escritos pelo usuário ou ambíguos; desativar Team com `--disable-team` ou `teamMode: "disabled"` salva cópia e remove `team-executor.toml`, independentemente da origem. Consulte [Plugin bundle SSOT](../../docs/plugin-bundle-ssot.md). O modo plugin ainda precisa de um `AGENTS.md` persistente do escopo (`~/.codex/AGENTS.md` para setup do usuário ou `./AGENTS.md` para setup do projeto) como camada de orientação durável; arquivos de sessão apenas combinam essa orientação com overlays de runtime e não a substituem.

Depois, trabalhe normalmente dentro do Codex:

```text
# Objetivo/checkpoints duráveis para uma tarefa longa:
/goal Criar um plano seguro de refatoração da autenticação, implementá-lo e verificar login, logout e renovação de tokens.

$deep-interview "esclarecer a alteração de autenticação"
$ralplan "aprovar o plano de autenticação e revisar as alternativas"
$ultragoal "transformar o plano aprovado em objetivos duráveis do Codex"
```

Essa é a rota principal. Antes de considerar o runtime pronto, faça o teste rápido abaixo: `omx doctor` verifica a instalação; `omx exec` confirma que o Codex ativo consegue se autenticar e concluir uma chamada ao modelo. Inicie o OMX a partir de um projeto Git como recomendado, esclareça quando necessário, aprove o plano e use `$ultragoal` como padrão para conclusão durável. Use `$team` dentro dessa execução apenas quando uma história específica precisar de coordenação paralela.

## Para que serve o OMX

Use OMX se você já gosta do Codex e quer um runtime melhor para o dia a dia:
- fluxo padrão `$deep-interview` → `$ralplan` → `$ultragoal`
- limites de pesquisa: `$best-practice-research` para evidências oficiais/upstream antes do planejamento; `$autoresearch` para artefatos de pesquisa delimitados e validados (`$deep-interview --autoresearch` na entrada e depois `$autoresearch` com o modo de validação escolhido); leve os resultados ao `$ralplan`
- transferências duráveis de múltiplos objetivos com `$ultragoal` e artefatos em `.omx/ultragoal`
- papéis especializados e skills de apoio quando necessários
- orientações do projeto via `AGENTS.md`
- estado durável em `.omx/` para planos, registros, memória e modos

Se prefere o Codex puro, sem camadas adicionais de fluxo de trabalho, provavelmente não precisa do OMX.

## Início rápido

### Requisitos

- Node.js 20+
- Codex CLI instalado, verificado com `codex --version`, e autenticado (Homebrew ou npm servem; não reinstale `@openai/codex` via npm se o Homebrew já gerencia `codex`)
- autenticação do Codex configurada e visível no mesmo shell/perfil que executará o OMX
- `tmux` no macOS/Linux para o runtime Team durável recomendado
- apenas no Windows nativo, `psmux` se escolher deliberadamente o caminho Team com menos suporte

### Uma boa primeira sessão

Após instalar, verifique os dois limites:

```bash
omx doctor
codex login status
omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"
```

`omx doctor` encontra arquivos, hooks e requisitos ausentes. O teste real detecta problemas de autenticação, perfil e URL base do provedor que só aparecem quando o Codex faz uma requisição.

Inicie o OMX do modo recomendado em um projeto Git:

```bash
omx --worktree=feat/task --madmax --xhigh
```

Em terminais interativos macOS/Linux com `tmux`, o líder é iniciado por padrão em tmux destacado gerenciado pelo OMX, permitindo criar/recuperar painéis HUD/runtime. `--worktree` também usa outro checkout Git, opção mais segura com `--madmax`. Substitua `feat/task` por um nome semelhante a branch.

### Conversas padrão simultâneas

Uma inicialização padrão possui um ponteiro de sessão gravável no `OMX_ROOT` escolhido. Uma segunda inicialização normal no mesmo checkout falha de forma segura em vez de compartilhar ou mudar essa raiz. Dê a cada conversa adicional uma raiz distinta:

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

Prompt de comando:

```bat
set "OMX_ROOT=%USERPROFILE%\.omx\instances\second-conversation"
omx
```

Raízes especificadas pelo usuário são literais: iniciar duas vezes com o mesmo `OMX_ROOT` explícito causa conflito de proprietário. Checkouts separados têm raízes padrão independentes; `--worktree` e `--madmax` mantêm o isolamento existente.

### Segurança de inicialização Madmax e worktree

`--madmax` é o atalho OMX para `--dangerously-bypass-approvals-and-sandbox` do Codex. Ele remove as proteções normais de aprovação e sandbox; use-o somente em repositórios e ambientes confiáveis. `--high` e `--xhigh` são atalhos para `-c model_reasoning_effort="high|xhigh"`. Uma sessão forte normal é `omx --madmax --xhigh` (ou `omx --worktree=feat/task --madmax --xhigh`).

Ao usar `--madmax` em um repositório Git, prefira um worktree em vez do checkout atual. Para trabalho repetível ou simultâneo, use worktrees nomeados:

```bash
omx --worktree=feature/auth --madmax --xhigh
omx --worktree=fix/flaky-tests --madmax --xhigh
```

Fora de um repositório Git, omita `--worktree`; worktrees exigem Git. Não execute sessões `--madmax` simultâneas no mesmo diretório. `--worktree` / `-w` sem nome cria/reutiliza `../<repo>.omx-worktrees/launch-detached`; com nome, cria/reutiliza `../<repo>.omx-worktrees/` e usa esse nome de branch. O OMX consome a opção antes de iniciar o Codex. Se o worktree estiver sujo, o OMX avisa e o inicia como está; limpe, confirme ou guarde as alterações antes de confiar no isolamento.

Ferramentas conscientes do repositório recebem o mesmo contexto em launch, team-worker e autoresearch: `OMX_REPO_ROOT`, `OMX_WORKTREE_ROOT`, `OMX_GIT_COMMON_DIR`, `OMX_WORKTREE_SCOPE`, `OMX_CODEGRAPH_MODE` e `OMX_CODEGRAPH_PROJECT_PATH`. `auto` no CodeGraph prefere um índice local do worktree, depois o do líder/repositório e, se nenhum existir, desativa. `shared`, `local` e `off` explícitos são respeitados. O OMX não instala CodeGraph, indexa worktrees nem copia/simbolicamente liga `.codegraph`; um índice compartilhado ajuda na navegação, mas não representa exatamente mudanças exclusivas do worktree.

Para uma inicialização pontual sem gerenciamento tmux/HUD do OMX:

```bash
omx --direct --yolo
```

Para preferência persistente de shell/perfil:

```bash
OMX_LAUNCH_POLICY=direct omx --yolo
```

Volte ao padrão com `unset OMX_LAUNCH_POLICY`. Flags CLI têm prioridade sobre o ambiente; antes de `--`, vale a última flag de política. Use `direct|tmux|detached-tmux|auto`; esta versão não adiciona configuração em arquivo. Com `--direct` em um painel tmux já aberto, o OMX não cria divisões HUD, ativa mouse nem envolve teclas estendidas, embora o processo continue nesse terminal.

Experimente o fluxo canônico:

```text
# Exemplo de objetivo durável:
/goal Entregar a correção do checkout com checkpoints para reprodução, implementação, testes de regressão e verificação final.

$plan "aprovar o plano de correção do checkout e revisar as alternativas"
$ultragoal "executar a correção aprovada com evidências em checkpoints"
```

Use `$team` quando uma história Ultragoal ativa precisar de coordenação.

### `/goal` e seleção de skills

Comece uma sessão forte com `omx --madmax --xhigh` (ou adicione `--worktree=<task>` em um repositório Git). Execute diretamente ou use `$ultragoal` para execuções duráveis com múltiplos objetivos, `$team` para trabalho paralelo ou `$plan` quando precisar planejar primeiro. Use `/goal` quando a tarefa exigir objetivo e checkpoints que o Codex deve reconciliar entre turnos.

Se respostas nativas de `get_goal` não estiverem disponíveis ou forem encapsuladas pelo transporte, Ultragoal mantém status baseado em artefatos sem afirmar falsamente que terminou; veja [diagnóstico e recuperação do Ultragoal](../../docs/ultragoal.md).

Carregue apenas 2–5 skills relevantes por padrão. Mais são aceitáveis quando justificadas pelo escopo, mas carregar um catálogo grande costuma desperdiçar contexto e atenção, não atingir um limite rígido do parser/runtime. Só trate isso como bloqueio se um comando realmente falhar.

Antipadrão:

```text
omx --madmax --xhigh
# Depois carregue 20 skills “por precaução” antes de explicar a tarefa.
# Isso incha o contexto e distrai o modelo com fluxos irrelevantes.
```

## Modelo mental simples

O OMX não substitui o Codex. Acrescenta uma camada de trabalho:
- **Codex** executa o trabalho do agente
- **palavras-chave de papel** do OMX tornam papéis reutilizáveis
- **skills** tornam fluxos comuns reutilizáveis
- `.omx/` guarda planos, registros, memória e estado de runtime

Pense no OMX como roteamento melhor, fluxo de trabalho e runtime — não como uma superfície de comandos para operar manualmente o dia inteiro.

## Comece aqui se for iniciante

1. Se já possui Codex CLI, verifique `codex --version` e instale/atualize OMX com `npm install -g oh-my-codex`; caso contrário, instale `@openai/codex` separadamente se quiser que o npm gerencie o Codex.
2. Depois de instalar ou atualizar a versão do OMX, rode `omx setup --scope project --merge-agents` no projeto Git alvo ou `omx setup --scope user`; use `omx update` se também quiser buscar/instalar a versão mais recente antes de atualizar o setup.
3. Execute `omx doctor`.
4. Faça um teste real: `codex login status` e `omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"`.
5. Em um repositório Git, inicie com worktree nomeado, por exemplo `omx --worktree=feat/task --madmax --xhigh`; sessões `--madmax` simultâneas precisam de worktrees diferentes.
6. Use `$deep-interview "..."` quando o pedido ou seus limites não estiverem claros.
7. Use `$ralplan "..."` para aprovar o plano e revisar alternativas.
8. Use `$ultragoal` ou `$team` quando a tarefa exigir execução durável ou paralela; adicione `/goal` se a estrutura do objetivo/checkpoints deve ser explícita.

## Fluxo de trabalho recomendado

`$autopilot` é o orquestrador canônico de primeira classe para `$deep-interview -> $ralplan -> $ultragoal`. Essa cadeia define o padrão, mas cada etapa também pode ser invocada separadamente quando seus requisitos já estão atendidos.

1. `$deep-interview` — esclarecimento socrático iterativo e requisitos prontos para execução.
2. `$ralplan` — síntese de arquitetura, viabilidade e consenso sobre a entrevista.
3. `$ultragoal` — execução de vários objetivos com checkpoints no ledger `.omx/ultragoal`.
4. `$team` — execução coordenada quando uma história se beneficia disso.

`$deep-interview` é uma etapa independente de requisitos, não um alias de `$plan --interview`, e não implementa mudanças. Planejamento produz artefatos; mudanças de código exigem uma etapa explícita de execução, como `$ultragoal` ou `$team`. Dentro de uma história Ultragoal, use `$team` só quando houver benefício.

## Superfícies comuns durante a sessão

| Superfície | Uso |
| --- | --- |
| `$plan "..."` | Planejamento e esclarecimento opcionais |
| `$ultragoal "..."` | Execução durável de múltiplos objetivos após aprovação |
| `$team "..."` | Execução coordenada em paralelo |
| `/skills` | Consultar skills instaladas |
| `/goal ...` | Estrutura durável de objetivo/checkpoints |
| `omx mission <file>` | Executar checklists/prompts sequencialmente via `omx exec`, com `.omx/missions/<slug>/summary.json` e `ledger.jsonl` |

## Superfícies avançadas / de operador

Úteis para operadores, mas não são a principal forma de começar.

### Executor de missões

Use `omx mission plan ./mission.md` ou `omx mission ./mission.md --dry-run` para validar o formato; rode com `omx mission run ./mission.md -- --model gpt-5`. Consulte `status`, continue com `resume`, marque tarefas bloqueadas com `mark` e refaça tarefas específicas com `rerun`. Veja [docs/mission.md](../../docs/mission.md).

### Exportar conversas anteriores

Encontre o ID com `omx session search "frase lembrada"` e exporte com `omx session export <session-id> --output conversation.md`. Aceita ID exato ou prefixo único e inclui transcrições ativas/arquivadas dos Codex homes descobertos. Use `--format json`, `--include-tools` ou `--codex-home <path>`; sem `--output`, escreve em stdout e nunca sobrescreve um arquivo existente. Por padrão, inclui mensagens do usuário e assistente, exclui instruções de sistema/desenvolvedor e registros de raciocínio, mas não remove dados sensíveis do texto. Veja [exportação de sessões](../../docs/session-export.md).

### Consultar uso de tokens

`omx session usage --since 7d --sort tokens` inspeciona o uso acumulado registrado em sessões locais ativas/arquivadas. Adicione `--project current`, `--session <trecho>`, `--json` ou `--codex-home <path>`. `--limit` limita a lista, não os totais; espelhos de uma sessão são contados uma vez e métricas ausentes aparecem como desconhecidas. `--since` usa a última atividade; os contadores podem incluir trabalho anterior e não são relatório de consumo/cobrança do período. Input em cache e raciocínio são subconjuntos de input/output. Veja [uso de sessão](../../docs/session-usage.md).

### Diagnosticar a linha do tempo de execução

`omx session timeline <session-id>` mostra chamadas de ferramentas, limites de turnos e compactações sem exportar texto da conversa. Pareia chamadas e resultados por ID, inclusive paralelos, e mostra falhas explícitas, chamadas sem par, durações observadas e totais por ferramenta/namespace. Use `--kind tools --sort duration --limit 10`, `--status failed` ou `--tool <name>`. Filtros/paginação afetam a lista, não os totais. Aceita IDs/prefixos únicos, sessões ativas/arquivadas, `--codex-home <path>` e JSON com `--json --output timeline.json`. Durações desconhecidas continuam desconhecidas e resultado sem erro explícito não prova sucesso. Veja [timeline de sessões](../../docs/session-timeline.md).

### Runtime Team

Use Team quando precisar de coordenação durável por tmux/worktree, não como padrão. No Codex App ou fora do tmux, `omx team` é uma superfície de shell para o runtime tmux; inicie primeiro o CLI OMX se quiser execução em equipe.

Dentro de uma história Ultragoal, o líder mantém o estado e workers reportam evidências de checkpoint, sem alterar `.omx/ultragoal`. Inícios não vinculados toleram artefatos Ultragoal antigos/malformados; inícios explicitamente vinculados falham de forma segura. Team grava `.omx/state/team/<team-name>/preflight-context.json` para retomar tarefas grandes com o contexto e divisão originais.

Para trabalho pequeno e atômico, Team pode limitar a expansão implícita a um worker e avisar sobre orquestração excessiva. Defina a quantidade explicitamente só quando a coordenação extra for intencional.

```bash
omx team 3:executor "fix the failing tests with verification"
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

`omx team status [<team-name>] [--json]` apenas observa o estado e pode ser usado em raiz OMX somente de leitura. Não recupera claims expirados, entrega mensagens, integra commits nem muda estado. Sem nome, resolve somente uma equipe única da sessão líder atual; informe o nome se não houver contexto. `omx tmux-hook status` também é observacional; use `omx tmux-hook init` para criar configuração explicitamente.

### Setup, doctor e HUD

- Marketplace/discovery do plugin Codex pode armazenar o pacote em `${CODEX_HOME:-~/.codex}/plugins/cache/$MARKETPLACE_NAME/oh-my-codex/$VERSION/` (instalações locais podem usar `local`). O pacote contém metadados de hooks oficiais do Codex e MCP/apps opcionais, desativados por padrão, e continua usando o CLI instalado `omx`.
- Setup por escopo instala prompts, skills, scaffolding `AGENTS.md`, `.codex/config.toml`, `.omx/` e, em modo legado ou Codex sem `plugin_hooks`, hooks OMX gerenciados em `.codex/hooks.json`.
- Atualizações preservam hooks não OMX e reescrevem apenas wrappers administrados pelo OMX.
- Em modo plugin, `AGENTS.md` persistente continua sendo a orientação durável; `omx doctor` falha se faltar o arquivo do escopo, pois o arquivo de sessão contém apenas overlay de runtime.
- `omx setup --merge-agents` atualiza seções entre marcadores `<!-- OMX:AGENTS:START -->` / `<!-- OMX:AGENTS:END -->`; `--no-merge-agents` registra uma escolha contextual e `--clear-merge-agents-policy` a remove. A política é por raiz, reproduzida por atualizações somente com escopo correspondente e não é padrão nem política de força.
- `omx uninstall` remove wrappers OMX de `.codex/hooks.json`, mantendo o arquivo se ainda houver hooks do usuário.
- `omx update` verifica npm, instala a versão global mais recente e refaz o setup interativo. Verificações de atualização no início são limitadas e pedem confirmação; `OMX_AUTO_UPDATE=0` desativa e `OMX_AUTO_UPDATE=defer` agenda sem perguntar.
- Novo setup usa `gpt-6-astra` para agentes frontier, standard e spark/fast, com raciocínio padrão por papel; configurações existentes e overrides explícitos são preservados.
- O roteamento de modelo/ambiente em `.omx-config.json` está na [referência do esquema](../../docs/reference/omx-config-schema-routing.md); edite apenas chaves suportadas pela versão instalada.
- `omx doctor` verifica a instalação, não se o perfil Codex ativo consegue fazer uma chamada autenticada.
- `omx hud --watch` é uma interface de monitoramento/status, não o fluxo principal.
- HUD mostra equipe e número de workers junto da versão OMX; o resumo Ultragoal/Team tem prioridade sobre o repositório. Cada agente tem linha com estado, tarefa, papel, painel tmux e idade do update. A altura acompanha o elenco, diminui quando a equipe para e representa excesso como `+N workers`. `working` não comprova processo vivo; leitura de status não modifica arquivos.
- Progresso GitGuardex é opcional: adicione `"guardex": { "enabled": true }` em `.omx/hud-config.json` do projeto para mostrar `gx:<step>/<total> <phase>`. Sem a flag, OMX não lê estado Guardex.

Para sessões sem Team, hooks nativos do Codex são a superfície canônica:
- `plugins/oh-my-codex/hooks/hooks.json`: registros oficiais de hooks do plugin
- `.codex/hooks.json`: hooks nativos legados/de fallback
- `.omx/hooks/*.mjs`: hooks do plugin OMX
- `omx tmux-hook`, notify-hook e watcher derivado: caminhos de fallback tmux/runtime

Veja o [mapa de hooks nativos do Codex](../../docs/codex-native-hooks.md).

### Diagnosticar prontidão falsamente verde

Um `omx doctor` verde indica instalação e runtime local aparentemente corretos. Se a execução falhar:
- No mesmo shell/perfil, rode `codex login status` e `omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"`.
- Em HOME, perfil, container ou serviço personalizado, confira se `~/.codex` (ou `CODEX_HOME`) contém a autenticação/configuração esperadas; não presuma que o shell vê o home habitual.
- Para proxy compatível com OpenAI, confirme que o `~/.codex/config.toml` ativo define o `openai_base_url` esperado; sem isso uma chave do proxy pode ser enviada ao endpoint padrão e retornar `401 Unauthorized`, `Missing bearer or basic authentication in header` ou `Incorrect API key provided`.
- Se `omx doctor --team` ou resume indicar equipe obsoleta, `resume_blocker` ou sessão tmux ausente, limpe o estado morto:

```bash
omx team shutdown <team-name> --force --confirm-issues
omx cancel
omx doctor --team
```

Use o shutdown forçado somente para uma equipe confirmada como morta ou abandonada intencionalmente. Se `Shift+Enter` enviar em vez de inserir quebra de linha em tmux gerenciado, consulte [solução de problemas](../../docs/troubleshooting.md#shiftenter-submits-instead-of-inserting-a-newline-in-tmux-backed-omx-sessions). O OMX já encaminha teclas estendidas nos caminhos de inicialização; uma falha persistente costuma ser de recursos/detecção do terminal tmux.

### Sparkshell

- `omx sparkshell <command>` serve para inspeção de shell e verificação limitada.
- Para pesquisa somente leitura do repositório, use ferramentas normais de inspeção Codex; o comando obsoleto `omx explore` foi removido.
- Modelos principal e fallback do Sparkshell usam `gpt-6-astra`; defina `OMX_SPARKSHELL_FALLBACK_MODEL` para torná-los diferentes.
- Overrides limitados: `OMX_SPARKSHELL_BIN`, `OMX_SPARKSHELL_MODEL`, `OMX_SPARKSHELL_FALLBACK_MODEL`, `OMX_SPARKSHELL_MODEL_INSTRUCTIONS_FILE`, `OMX_SPARKSHELL_SUMMARY_TIMEOUT_MS`.

```bash
omx sparkshell git status
omx sparkshell --tmux-pane %12 --tail-lines 400
```

### Wiki

- `omx wiki` é a interface JSON CLI-first; o MCP `omx_wiki` é somente compatibilidade explícita.
- Dados Wiki são conhecimento de projeto em Markdown em `omx_wiki/`.
- É Markdown-first e search-first, não vector-first.

```bash
omx wiki list --json
omx wiki query --input '{"query":"session-start lifecycle"}' --json
omx wiki lint --json
omx wiki refresh --json
```

### Notas de plataforma para Team

Team funciona melhor em macOS/Linux com `tmux`. Windows nativo é secundário; WSL2 geralmente é a opção melhor. No Windows nativo, o OMX aceita `psmux` como binário compatível com tmux para os caminhos já suportados.

| Plataforma | Instalação |
| --- | --- |
| macOS | `brew install tmux` |
| Ubuntu/Debian | `sudo apt install tmux` |
| Fedora | `sudo dnf install tmux` |
| Arch | `sudo pacman -S tmux` |
| Windows | `winget install psmux` |
| Windows (WSL2) | `sudo apt install tmux` |

## Problemas conhecidos

### Intel Mac: alto uso de CPU por `syspolicyd` / `trustd` na inicialização

Em alguns Macs Intel, a inicialização do OMX — especialmente com `--madmax --high` — pode elevar o uso de CPU de `syspolicyd` / `trustd` enquanto o Gatekeeper valida vários processos simultâneos.

Se ocorrer:
- `xattr -dr com.apple.quarantine $(which omx)`
- adicione seu terminal à lista de ferramentas de desenvolvedor permitidas nas configurações de Segurança do macOS
- reduza a concorrência (por exemplo, evite `--madmax --high`)

## Documentação

- [Primeiros passos](../../docs/getting-started.html)
- [Guia da demonstração](../../DEMO.md)
- [Recurso Wiki](../../docs/wiki-feature.md)
- [Catálogo de agentes](../../docs/agents.html)
- [Referência de skills](../../docs/skills.html)
- [Mapa de hooks nativos do Codex](../../docs/codex-native-hooks.md)
- [Pipeline de identidade GitHub/PR/pacote](../../docs/pipeline/github-pr-package-identity.md)
- [Integrações](../../docs/integrations.html)
- [Solução de problemas de execução](../../docs/troubleshooting.md)
- [Guia OpenClaw/gateway de notificações](../../docs/openclaw-integration.md)
- [Contribuir](../../CONTRIBUTING.md)
- [Registro de alterações](../../CHANGELOG.md)

## Idiomas

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

## Colaboradores

| Papel | Nome | GitHub |
| --- | --- | --- |
| Criador e líder | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Mantenedor | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Mantenedor | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## Histórico de estrelas

[![Gráfico do histórico de estrelas](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-codex&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-codex&type=date&legend=top-left)

## Licença

MIT

## Benchmark de visibilidade GEO

O OMX inclui uma especificação de produto [`geobench`](https://github.com/NomaDamas/geobench) para medir taxa de acerto de LLM, MRR, share of voice e citações.

- Especificação: [`geobench/oh-my-codex.yaml`](../../geobench/oh-my-codex.yaml)
- Guia de execução: [`docs/geobench.md`](../../docs/geobench.md)
