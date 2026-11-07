# oh-my-codex (OMX)

<p align="center">
  <img src="https://yeachan-heo.github.io/oh-my-codex-website/omx-character-nobg.png" alt="Personaje de oh-my-codex" width="280">
  <br>
  <em>Empieza Codex con más fuerza y deja que OMX aporte mejores prompts, flujos de trabajo y soporte de ejecución cuando el trabajo crezca.</em>
  <br><br>
  <strong>¿Te gusta OMX, pero te parece demasiado? <a href="https://github.com/Yeachan-Heo/gajae-code">Prueba gajae-code</a>.</strong><br>
  <sub>Conserva la autenticación OAuth de Codex con una ruta basada en SDK más rápida, económica, sencilla y potente para OpenClaw, Hermes, Grokbot y otras integraciones.</sub>
</p>

[![versión npm](https://img.shields.io/npm/v/oh-my-codex)](https://www.npmjs.com/package/oh-my-codex)
[![Licencia: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Discord](https://img.shields.io/discord/1452487457085063218?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/wSyUQYfhAw)

**Sitio web:** https://yeachan-heo.github.io/oh-my-codex-website/

**Documentación:** [Primeros pasos](../getting-started.html) · [Agentes](../agents.html) · [Skills](../skills.html) · [Integraciones](../integrations.html) · [Demostración](../../DEMO.md) · [Guía de OpenClaw](../../docs/openclaw-integration.md)

**Comunidad:** [Discord](https://discord.gg/wSyUQYfhAw), servidor compartido de la comunidad Gajae para oh-my-codex, [gajae-code](https://github.com/Yeachan-Heo/gajae-code) y herramientas relacionadas.

## Proyecto y paquete oficiales

El proyecto OMX oficial/original es este repositorio, [`Yeachan-Heo/oh-my-codex`](https://github.com/Yeachan-Heo/oh-my-codex), y su paquete npm oficial es [`oh-my-codex`](https://www.npmjs.com/package/oh-my-codex). Instálalo con `npm install -g oh-my-codex` (o junto con Codex CLI, como se muestra abajo).

Los proyectos de terceros o forks que utilicen nombres como «OMX v2» no son continuaciones, sustitutos ni líneas de publicación oficiales de este repositorio, salvo que este README o la documentación lo indiquen expresamente. Ante cualquier duda, considera este repositorio y el paquete `oh-my-codex` como el destino de instalación oficial.

OMX es una capa de flujos de trabajo para [OpenAI Codex CLI](https://github.com/openai/codex).

<table>
<tr>
<td><strong>🚨 AVISO — EXPERIENCIA PREDETERMINADA RECOMENDADA: macOS o Linux con Codex CLI.</strong><br><br><strong>OMX está diseñado principalmente y optimizado activamente para esa ruta.</strong><br><strong>Windows nativo y Codex App no son la experiencia predeterminada, pueden fallar o comportarse de forma inconsistente y reciben menos soporte actualmente.</strong></td>
</tr>
</table>

OMX mantiene a Codex como motor de ejecución y facilita:
- iniciar por defecto una sesión Codex más sólida
- seguir un flujo coherente, desde la aclaración hasta la finalización
- invocar flujos canónicos de forma independiente con `$plan`, `$ultragoal`, `$team`, `$code-review` y `$ultraqa`, sin una cadena fija
- conservar la guía, planes, registros y estado del proyecto en `.omx/`

## Mantenedores principales

| Rol | Nombre | GitHub |
| --- | --- | --- |
| Creador y líder | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Mantenedor | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Mantenedor | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## Embajadores

| Nombre | GitHub |
| --- | --- |
| Sigrid Jin | [@sigridjineth](https://github.com/sigridjineth) |

## Colaboradores destacados

| Nombre | GitHub |
| --- | --- |
| Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Junho Yeo | [@junhoyeo](https://github.com/junhoyeo) |
| JiHongKim98 | [@JiHongKim98](https://github.com/JiHongKim98) |
| Lor | [@gobylor](https://github.com/gobylor) |
| HyunjunJeon | [@HyunjunJeon](https://github.com/HyunjunJeon) |

## Flujo predeterminado recomendado

Si quieres la experiencia OMX predeterminada, empieza aquí.

Elige una ruta de instalación. Si Codex CLI ya está instalado (Homebrew, npm u otro método compatible):

```bash
codex --version
npm install -g oh-my-codex
# desde el repositorio Git que quieras editar con Codex; elige un nombre específico para la tarea
omx --worktree=feat/task --madmax --xhigh
```

Si aún no tienes Codex CLI y quieres que npm lo gestione:

```bash
npm install -g @openai/codex
npm install -g oh-my-codex
```

No ejecutes `npm install -g @openai/codex oh-my-codex` sobre un binario `codex` existente instalado por Homebrew, por ejemplo `/opt/homebrew/bin/codex`: npm puede fallar con `EEXIST` al intentar crear el mismo binario. OMX solo necesita un comando `codex` funcional y autenticado en `PATH`; no exige que Codex esté instalado con npm.

Al instalar una nueva versión de `oh-my-codex`, npm ahora muestra un recordatorio explícito en lugar de iniciar setup automáticamente. Cuando quieras, ejecuta el comando de setup con el alcance adecuado o usa `omx update` para comprobar npm y luego aplicar la misma actualización de setup.

OMX también comprueba si hay actualizaciones npm al iniciar, con una frecuencia limitada, y pide confirmación antes de programar la actualización para cuando termine la sesión actual. Usa `OMX_AUTO_UPDATE=0` para desactivar la comprobación al inicio, o `OMX_AUTO_UPDATE=defer` para programar la misma actualización diferida sin preguntar.

Elige deliberadamente el alcance de setup:
- Ejecuta `omx setup --scope project --merge-agents` desde el proyecto Git donde OMX trabajará si ese repositorio debe ser dueño de la guía duradera `AGENTS.md`.
- Usa `omx setup --scope user` para configurar Codex a nivel de usuario cuando el directorio actual no deba convertirse en un proyecto OMX.
- No ejecutes setup de proyecto desde un directorio personal amplio o un centro de trabajo, salvo que ese directorio sea realmente el proyecto. El `AGENTS.md` del usuario suele contener reglas globales de seguridad y enrutamiento; conserva la guía de ejecución específica del proyecto en el repositorio correspondiente.

### Política explícita de combinación de AGENTS

`omx setup --merge-agents`, `omx setup --no-merge-agents` y `omx setup --clear-merge-agents-policy` son los únicos selectores de política; usa estas formas simples, no variantes `=valor`. Repetir el mismo selector no causa daño, pero mezclar opciones de establecer y borrar hace que setup falle antes de modificar nada. Una opción explícita prevalece sobre una política guardada. Si se establece correctamente, guarda `mergeAgents: true` o `false` en `./.omx/setup-scope.json` del directorio de trabajo actual, incluso con alcance `user`; no es una preferencia global ni se propaga a otros directorios. Las futuras ejecuciones de `omx update` reproducen una política válida y coincidente, tanto para actualizaciones inmediatas como diferidas.

`true` usa la ruta de combinación existente. `false` solo la desactiva: no promete conservar, sustituir ni aplicar un modo nuevo de seguridad; siguen vigentes los comportamientos existentes de prompts, omisiones, actualizaciones gestionadas, valores predeterminados del plugin y `--force`. Una revisión con el mismo alcance conserva la política mientras cambian opciones ajenas. Restablecer o cambiar el alcance elimina la política heredada, salvo que la misma ejecución establezca explícitamente `true` o `false`; borrar siempre elimina la política y no puede combinarse con un selector de establecimiento. Los datos guardados malformados, desconocidos, no booleanos o de otro alcance se ignoran de forma segura.

`--force` es independiente y temporal: no se guarda ni se reproduce, y no anula una política explícita de combinación. Setup registra atómicamente la intención explícita de establecer o borrar solo cuando todo el trabajo finaliza correctamente, incluso si las protecciones de sesión activa o de enlaces simbólicos de plugins omiten la escritura del `AGENTS.md` actual. Esto no convierte la combinación en opción predeterminada ni recupera el enfoque rechazado de combinar siempre de #2892. Versiones antiguas de OMX ignoran el campo de forma segura, aunque podrían borrarlo al reescribir sus preferencias de setup conocidas.

**Nota sobre la instalación del plugin Codex:** este repositorio también ofrece un layout oficial de plugin Codex en `plugins/oh-my-codex`, con metadatos de marketplace en `.agents/plugins/marketplace.json`. Incluye la superficie de skills reflejada y metadatos complementarios para hooks oficiales del ciclo de vida de Codex, servidores MCP opcionales de compatibilidad y apps. No sustituye al CLI global `oh-my-codex` ni al setup con alcance: los hooks del plugin ejecutan el CLI `omx` instalado y ambos modos de setup suelen instalar TOML de agentes nativos para el enrutamiento `agent_type`. En ambos modos, `omx setup --disable-hooks` desactiva los registros de hooks de OMX y funciones relacionadas, y termina antes de instalar recursos, configurar opciones, crear `AGENTS.md`, HUD o estado. El modo heredado también instala copias de prompts y skills. El modo plugin descubre las skills incluidas en el plugin, archiva o elimina las copias de prompts OMX heredadas y quita archivos de agentes nativos generados que estén obsoletos o ya no sean instalables. Sin `--force`, conserva los archivos de rol creados por el usuario o ambiguos; al desactivar Team, con `--disable-team` o `teamMode: "disabled"` guardado, respalda y elimina `team-executor.toml` independientemente de su propietario. Consulta [Plugin bundle SSOT](../../docs/plugin-bundle-ssot.md) para estas reglas de propiedad. El modo plugin sigue necesitando un `AGENTS.md` persistente para el alcance (`~/.codex/AGENTS.md` en setup de usuario o `./AGENTS.md` en setup de proyecto) como guía duradera; los archivos de sesión solo combinan esa guía con superposiciones de ejecución y no la sustituyen.

Después, trabaja normalmente dentro de Codex:

```text
# Objetivo/checkpoints duraderos para una tarea larga:
/goal Crear un plan seguro para refactorizar autenticación, implementarlo y verificar login, logout y renovación de tokens.

$deep-interview "aclarar el cambio de autenticación"
$ralplan "aprobar el plan de autenticación y revisar sus riesgos"
$ultragoal "convertir el plan aprobado en objetivos duraderos de Codex"
```

Esa es la ruta principal. Antes de considerar listo el entorno, ejecuta la prueba rápida de inicio más abajo: `omx doctor` verifica la instalación y `omx exec` demuestra que el entorno activo de Codex puede autenticarse y completar una llamada al modelo. Inicia OMX desde un proyecto Git como se recomienda, aclara lo necesario, aprueba el plan y usa `$ultragoal` como envoltorio predeterminado de finalización duradera. Usa `$team` dentro de esa ejecución solo si una historia concreta de Ultragoal requiere coordinación paralela.

## Para qué sirve OMX

Usa OMX si ya te gusta Codex y quieres un mejor entorno de trabajo diario:
- un flujo estándar `$deep-interview` → `$ralplan` → `$ultragoal`
- límites de investigación: `$best-practice-research` para evidencia oficial/upstream antes de planificar; `$autoresearch` para artefactos de investigación acotados y validados (usa `$deep-interview --autoresearch` para la toma de requisitos y luego `$autoresearch` con el modo de validación elegido), incorporando los hallazgos a `$ralplan`
- traspasos duraderos multiobjetivo con artefactos de `$ultragoal` y `.omx/ultragoal`
- roles especializados y skills de apoyo cuando sean necesarios
- instrucciones de proyecto mediante `AGENTS.md`
- estado duradero en `.omx/` para planes, registros, memoria y modos

Si prefieres Codex sin capas adicionales de flujo de trabajo, probablemente no necesitas OMX.

## Inicio rápido

### Requisitos

- Node.js 20 o posterior
- Codex CLI instalado, verificado con `codex --version`, y autenticado (Homebrew y npm son válidos; no reinstales con npm `@openai/codex` si Homebrew ya posee el binario `codex`)
- La autenticación de Codex configurada y visible desde el mismo shell/perfil que ejecutará OMX
- `tmux` en macOS/Linux si quieres el entorno duradero recomendado para Team
- Solo en Windows nativo, `psmux` si eliges intencionalmente la ruta de Team con menos soporte

### Una buena primera sesión

Tras instalar, comprueba ambos límites:

```bash
omx doctor
codex login status
omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"
```

`omx doctor` detecta archivos, hooks y requisitos faltantes. La prueba real detecta problemas de autenticación, perfil o URL base del proveedor que solo aparecen cuando Codex realiza una solicitud.

Inicia OMX desde un proyecto Git con el modo recomendado:

```bash
omx --worktree=feat/task --madmax --xhigh
```

En terminales interactivos macOS/Linux con `tmux`, OMX inicia por defecto al líder en tmux separado y administrado por OMX para poder crear o recuperar paneles HUD/runtime. `--worktree` también inicia el trabajo en otro checkout de Git, opción más segura con `--madmax`. Sustituye `feat/task` por un nombre similar al de una rama.

### Conversaciones estándar concurrentes

Un inicio estándar posee un único puntero de sesión editable en su `OMX_ROOT`. Un segundo inicio normal de `omx` desde el mismo checkout falla de forma segura en vez de compartir o cambiar esa raíz. Para cada conversación adicional, elige una raíz distinta:

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

Símbolo del sistema:

```bat
set "OMX_ROOT=%USERPROFILE%\.omx\instances\second-conversation"
omx
```

Las raíces especificadas por el usuario se consideran literales: dos inicios con el mismo `OMX_ROOT` explícito provocan conflicto de propietario. Checkouts separados tienen raíces predeterminadas distintas; `--worktree` y `--madmax` conservan su aislamiento habitual.

### Seguridad de inicio con Madmax y worktrees

`--madmax` es la forma abreviada de OMX para `--dangerously-bypass-approvals-and-sandbox` de Codex. Elimina las protecciones normales de aprobación y sandbox: úsalo solo en repositorios y entornos de confianza. `--high` y `--xhigh` equivalen a `-c model_reasoning_effort="high|xhigh"`. Una sesión fuerte normal es `omx --madmax --xhigh` (o `omx --worktree=feat/task --madmax --xhigh` desde un proyecto Git).

Al usar `--madmax` en un repositorio Git, prefiere iniciar en un worktree en vez del checkout actual. Para trabajo repetible o concurrente, usa nombres:

```bash
omx --worktree=feature/auth --madmax --xhigh
omx --worktree=fix/flaky-tests --madmax --xhigh
```

Fuera de un repositorio Git, omite `--worktree`; requiere Git. No ejecutes sesiones concurrentes `--madmax` en el mismo directorio: asigna a cada una un worktree nombrado. `--worktree` / `-w` sin nombre crea o reutiliza `../<repo>.omx-worktrees/launch-detached`; con nombre crea o reutiliza un worktree en `../<repo>.omx-worktrees/` y usa ese nombre de rama. OMX consume la opción antes de iniciar Codex. Si el worktree ya está sucio, OMX avisa y lo inicia tal cual; limpia, confirma o guarda esos cambios antes de depender del aislamiento.

En sesiones concurrentes `--madmax`, no uses el mismo directorio para todas: asigna un worktree nombrado a cada sesión.

Las herramientas conscientes del repositorio reciben el mismo contexto canónico en los entornos launch, team-worker y autoresearch: `OMX_REPO_ROOT`, `OMX_WORKTREE_ROOT`, `OMX_GIT_COMMON_DIR`, `OMX_WORKTREE_SCOPE`, `OMX_CODEGRAPH_MODE` y `OMX_CODEGRAPH_PROJECT_PATH`. El modo `auto` de CodeGraph prefiere una base local del worktree, después la del líder/repositorio y, si no existe, se desactiva. Los modos explícitos `shared`, `local` y `off` se respetan. OMX no instala CodeGraph, indexa worktrees automáticamente ni copia/enlaza `.codegraph`; un índice compartido del líder sirve para orientarse, pero no refleja con precisión cambios exclusivos del worktree.

Para un inicio puntual sin gestión de tmux/HUD de OMX:

```bash
omx --direct --yolo
```

Para una preferencia persistente de shell/perfil:

```bash
OMX_LAUNCH_POLICY=direct omx --yolo
```

Restablece el comportamiento predeterminado con `unset OMX_LAUNCH_POLICY`. Las opciones CLI prevalecen sobre el entorno, y antes de `--` se aplica la última opción de política CLI. Valores válidos: `direct|tmux|detached-tmux|auto`. No hay opción equivalente en archivo de configuración. Dentro de un panel tmux existente, `--direct` no crea divisiones HUD, activa el modo ratón ni configura teclas extendidas, aunque el proceso sigue ejecutándose dentro de esa terminal.

Prueba el flujo canónico:

```text
# Ejemplo de objetivo duradero:
/goal Entregar la corrección del checkout con objetivo y checkpoints para reproducir, implementar, probar regresiones y verificar.

$plan "aprobar el plan de corrección de checkout y revisar los riesgos"
$ultragoal "ejecutar la corrección aprobada con evidencia por checkpoint"
```

Usa `$team` cuando una historia activa de Ultragoal requiera coordinación.

### `/goal` y selección de skills

Inicia una sesión sólida normal con `omx --madmax --xhigh` (o añade `--worktree=<task>` en un repositorio Git). Ejecuta directamente o usa `$ultragoal` para ejecuciones multiobjetivo duraderas, `$team` para coordinar trabajo paralelo o `$plan` cuando haga falta planificar primero. Usa `/goal` cuando la tarea necesite un objetivo/checkpoints duradero que Codex deba reconciliar a lo largo de varios turnos.

Si las respuestas nativas de `get_goal` no están disponibles o el transporte las envuelve, Ultragoal conserva un estado respaldado por artefactos sin declarar falsamente que está completo. Consulta [diagnóstico y recuperación de Ultragoal](../../docs/ultragoal.md).

Carga solo 2–5 skills pertinentes de forma predeterminada. Se permiten más cuando el alcance lo justifique, pero cargar un catálogo grande suele ser un problema de contexto y atención, no un límite duro del parser/runtime. Considéralo un bloqueo real solo si el comando falla.

Antipatrón:

```text
omx --madmax --xhigh
# Luego carga 20 skills «por si acaso» antes de explicar la tarea.
# Esto llena el contexto y distrae al modelo con flujos irrelevantes.
```

## Modelo mental sencillo

OMX no reemplaza a Codex. Añade una capa de trabajo:
- **Codex** realiza el trabajo del agente
- las palabras clave de rol de **OMX** permiten reutilizar roles útiles
- las **skills** reutilizan flujos de trabajo comunes
- `.omx/` guarda planes, registros, memoria y estado de ejecución

Piensa en OMX como mejor enrutamiento de tareas, flujo de trabajo y entorno de ejecución, no como una superficie de comandos para operar manualmente todo el día.

## Empieza aquí si eres nuevo

1. Si ya tienes Codex CLI, comprueba `codex --version` e instala/actualiza OMX con `npm install -g oh-my-codex`; si no, instala `@openai/codex` por separado si quieres que npm gestione Codex.
2. Después de instalar o actualizar la versión de OMX, ejecuta `omx setup --scope project --merge-agents` desde el proyecto Git objetivo, o `omx setup --scope user`; también puedes usar `omx update` para buscar e instalar la última versión y refrescar setup.
3. Ejecuta `omx doctor`.
4. Ejecuta una prueba real: `codex login status` y `omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"`.
5. Desde un repositorio Git, inicia con un worktree nombrado, por ejemplo `omx --worktree=feat/task --madmax --xhigh`; usa worktrees distintos para sesiones concurrentes `--madmax`.
6. Usa `$deep-interview "..."` si la solicitud o sus límites no están claros.
7. Usa `$ralplan "..."` para aprobar el plan y revisar riesgos.
8. Usa `$ultragoal` o `$team` si la tarea requiere ejecución duradera o paralela; añade `/goal` si la estructura de objetivo/checkpoints debe ser explícita.

## Flujo de trabajo recomendado

`$autopilot` es el orquestador canónico de primera clase para la secuencia `$deep-interview -> $ralplan -> $ultragoal`. Esa cadena define su comportamiento predeterminado; cada fase puede invocarse por separado cuando ya se cumplan sus requisitos de entrada.

1. `$deep-interview` — aclaración socrática iterativa y requisitos listos para ejecución.
2. `$ralplan` — análisis de arquitectura, viabilidad y consenso sobre el artefacto de entrevista.
3. `$ultragoal` — ejecución de múltiples objetivos con checkpoints en el ledger `.omx/ultragoal`.
4. `$team` — ejecución coordinada cuando una historia lo justifica.

`$deep-interview` es una fase independiente de requisitos, no un alias de `$plan --interview`, y no implementa directamente. La planificación produce artefactos de plan; los cambios de código requieren una vía de ejecución explícita, como `$ultragoal` o `$team`. Dentro de una historia Ultragoal, usa `$team` solo si aporta valor.

## Superficies comunes de sesión

| Superficie | Uso |
| --- | --- |
| `$plan "..."` | Planificación y aclaración opcionales |
| `$ultragoal "..."` | Ejecución multiobjetivo duradera tras aprobar el plan |
| `$team "..."` | Ejecución coordinada en paralelo |
| `/skills` | Explorar skills instaladas |
| `/goal ...` | Objetivo/checkpoints duraderos que deben reconciliarse en varias sesiones |
| `omx mission <file>` | Ejecutar prompts/checklists secuencialmente mediante `omx exec`; guarda `.omx/missions/<slug>/summary.json` y `ledger.jsonl` |

## Superficies avanzadas / de operador

Son útiles para operadores; no son el recorrido principal para empezar con OMX.

### Ejecutor de misiones

Usa `omx mission plan ./mission.md` o `omx mission ./mission.md --dry-run` para validar el formato. Ejecuta con `omx mission run ./mission.md -- --model gpt-5`. Inspecciona con `status`, continúa con `resume`, marca tareas bloqueadas con `mark` y repara tareas específicas con `rerun`. Consulta [docs/mission.md](../../docs/mission.md).

### Exportar una conversación anterior

Busca un ID con `omx session search "frase recordada"` y exporta con `omx session export <session-id> --output conversation.md`. Admite ID exacto o prefijo único, incluye transcripciones activas y archivadas de los mismos Codex homes, y nunca sobrescribe un archivo existente. Usa `--format json`, `--include-tools` o `--codex-home <path>`; sin `--output`, escribe en stdout. De forma predeterminada incluye solo mensajes de usuario/asistente; excluye instrucciones del sistema/desarrollador y razonamientos, pero no redacta el texto. Consulta [exportar sesiones](../../docs/session-export.md).

### Consultar uso de tokens

`omx session usage --since 7d --sort tokens` muestra uso acumulado registrado en sesiones locales activas y archivadas. Filtra con `--project current` o `--session <fragmento>`, usa `--json` o limita a un Codex home con `--codex-home <path>`. `--limit` limita lo mostrado, no los totales. Los espejos de una misma sesión se cuentan una vez; mediciones faltantes se indican como desconocidas. `--since` selecciona por última actividad, por lo que los contadores pueden incluir trabajo anterior y no son informes de consumo/facturación del período. El input almacenado en caché y el razonamiento son subconjuntos de input y output. Consulta [uso de sesiones](../../docs/session-usage.md).

### Diagnosticar la cronología de ejecución

`omx session timeline <session-id>` muestra llamadas a herramientas, límites de turnos y compactaciones sin exportar el texto de conversación. Empareja llamadas y resultados por ID, incluidas las paralelas, e informa errores, llamadas sin pareja, duraciones observadas y totales por herramienta/espacio de nombres. Usa `--kind tools --sort duration --limit 10`, `--status failed` o `--tool <name>`. Los filtros y la paginación afectan la lista, no los totales. Admite IDs exactos o prefijos, sesiones activas/archivadas, `--codex-home <path>` y salida JSON con `--json --output timeline.json`. Duraciones desconocidas siguen siendo desconocidas y un resultado sin error explícito no demuestra éxito. Consulta [cronología de sesiones](../../docs/session-timeline.md).

### Entorno de Team

Usa Team para coordinación duradera mediante tmux/worktrees, no como entrada predeterminada. En Codex App o fuera de tmux, `omx team` es una superficie de shell para el runtime tmux: inicia primero OMX CLI desde una shell si quieres ejecución en equipo.

En una historia Ultragoal, el líder conserva el estado de Ultragoal y los workers informan evidencia lista para checkpoint; no modifican directamente `.omx/ultragoal`. El inicio tolera artefactos Ultragoal antiguos o malformados en trabajos no relacionados, pero falla de forma segura en lanzamientos vinculados explícitamente a Ultragoal. Al iniciar, Team guarda `.omx/state/team/<team-name>/preflight-context.json` para recuperar tareas grandes con contexto, reparto de workers y verificaciones originales.

Para tareas atómicas pequeñas, Team puede limitar la expansión implícita a un worker y advertir de sobreorquestación. Solo especifica cantidad cuando la coordinación adicional sea intencional.

```bash
omx team 3:executor "fix the failing tests with verification"
omx team status <team-name>
omx team resume <team-name>
omx team shutdown <team-name>
```

`omx team status [<team-name>] [--json]` solo observa estado, por lo que también funciona en una raíz OMX de solo lectura. No recupera claims expirados, entrega mensajes, integra commits ni cambia estado. Sin nombre de equipo, resuelve solo un equipo único de la sesión líder actual; usa nombre explícito si falta el contexto. `omx tmux-hook status` también es observacional; inicializa la configuración explícitamente con `omx tmux-hook init`.

### Setup, doctor y HUD

- La instalación/descubrimiento del plugin Codex puede guardar el paquete bajo `${CODEX_HOME:-~/.codex}/plugins/cache/$MARKETPLACE_NAME/oh-my-codex/$VERSION/` (instalaciones locales pueden usar `local`). Incluye metadatos de hooks oficiales, MCP y apps opcionales (desactivados de forma predeterminada); sigue requiriendo el CLI instalado `omx`.
- Setup por alcance instala prompts, skills, scaffolding `AGENTS.md`, `.codex/config.toml`, `.omx/` y, en instalaciones heredadas o Codex antiguo sin `plugin_hooks`, hooks OMX gestionados en `.codex/hooks.json`.
- Las actualizaciones de setup conservan hooks no OMX y solo reescriben wrappers administrados por OMX.
- En modo plugin, `AGENTS.md` sigue siendo guía duradera obligatoria; `omx doctor` marca error si falta el archivo persistente del alcance, porque el `AGENTS.md` de sesión solo contiene la superposición de ejecución.
- `omx setup --merge-agents` actualiza secciones entre `<!-- OMX:AGENTS:START -->` y `<!-- OMX:AGENTS:END -->`; `--no-merge-agents` guarda una elección contextual explícita y `--clear-merge-agents-policy` la borra. La política se guarda por raíz, se reproduce en actualizaciones inmediatas/diferidas solo si el alcance coincide y nunca es una opción predeterminada ni `--force`.
- `omx uninstall` elimina wrappers gestionados por OMX de `.codex/hooks.json`, pero conserva el archivo si contiene hooks del usuario.
- `omx update` comprueba npm, instala la versión global más reciente y vuelve a ejecutar setup interactivo. Las comprobaciones al iniciar son limitadas y preguntan antes de actualizar; `OMX_AUTO_UPDATE=0` las desactiva y `OMX_AUTO_UPDATE=defer` programa una actualización diferida sin preguntar.
- Un setup nuevo usa `gpt-6-astra` para agentes frontier, standard y spark/fast, con razonamiento predeterminado por rol; se conservan las configuraciones existentes y anulaciones explícitas.
- El enrutamiento de modelos/entorno de `.omx-config.json` se documenta en [referencia de esquema](../../docs/reference/omx-config-schema-routing.md); modifica solo claves admitidas por la versión instalada.
- `omx doctor` verifica la instalación, no que el perfil Codex activo pueda realizar una llamada autenticada.
- `omx hud --watch` es una superficie de monitorización/estado, no el flujo principal.
- En cada preset HUD, los equipos activos muestran nombre y cantidad de workers junto a la versión OMX; el resumen Ultragoal/Team tiene prioridad sobre etiquetas de repositorio. Cada agente tiene fila actualizada con estado, tarea, rol, panel tmux y antigüedad del informe. El HUD crece/encoge con el equipo y limita su altura; trabajadores que no caben se resumen como `+N workers`. Estado `working` no comprueba que el proceso siga vivo; la lectura de miembros/estado no modifica archivos.
- El progreso de GitGuardex es optativo: añade `"guardex": { "enabled": true }` a `.omx/hud-config.json` del proyecto para ver `gx:<step>/<total> <phase>`. Sin este flag, OMX no lee el estado de Guardex.

Para sesiones sin Team, los hooks nativos de Codex son la superficie canónica:
- `plugins/oh-my-codex/hooks/hooks.json`: registros oficiales de hooks del plugin
- `.codex/hooks.json`: registros nativos heredados o de respaldo
- `.omx/hooks/*.mjs`: hooks del plugin OMX
- `omx tmux-hook`, notify-hook y watcher: rutas de respaldo para tmux/runtime

Consulta [mapa de hooks nativos de Codex](../../docs/codex-native-hooks.md).

### Diagnosticar una disponibilidad falsamente positiva

Que `omx doctor` aparezca en verde significa que la instalación y el runtime local parecen correctos. Si la ejecución falla, comprueba el entorno que realmente utiliza Codex:
- Desde el mismo shell/perfil, ejecuta `codex login status` y `omx exec --skip-git-repo-check -C . "Reply with exactly OMX-EXEC-OK"`.
- En shells con HOME, perfil, contenedor o servicio personalizado, confirma que `~/.codex` (o `CODEX_HOME`) tiene la autenticación y configuración esperadas; no supongas que ve el home normal.
- Si dependes de un proxy local compatible con OpenAI, confirma que el `~/.codex/config.toml` activo contiene el `openai_base_url` correcto; de lo contrario, una clave del proxy puede enviarse al endpoint predeterminado y fallar con `401 Unauthorized`, `Missing bearer or basic authentication in header` o `Incorrect API key provided`.
- Si `omx doctor --team` o la reanudación informan de un equipo obsoleto, como `resume_blocker` o una sesión tmux ausente, limpia primero el estado muerto:

```bash
omx team shutdown <team-name> --force --confirm-issues
omx cancel
omx doctor --team
```

Usa el apagado forzado solo para un equipo confirmado como muerto o abandonado intencionalmente.

Si `Shift+Enter` envía en lugar de insertar una nueva línea en un tmux gestionado por OMX, consulta [solución de problemas](../../docs/troubleshooting.md#shiftenter-submits-instead-of-inserting-a-newline-in-tmux-backed-omx-sessions). OMX ya activa el reenvío de teclas extendidas en sus rutas de inicio de Codex; una falla persistente suele deberse a capacidades/detección de terminal tmux, no a una función nueva de OMX que falte.

### Sparkshell

- `omx sparkshell <command>` sirve para inspección nativa de shell y verificación acotada.
- Para búsquedas de solo lectura del repositorio usa las herramientas normales de inspección de Codex; el comando obsoleto `omx explore` se eliminó.
- Los modelos principal y alternativo de resúmenes Sparkshell usan `gpt-6-astra` de forma predeterminada; configura `OMX_SPARKSHELL_FALLBACK_MODEL` para diferenciarlos.
- Las anulaciones de entorno son acotadas: `OMX_SPARKSHELL_BIN`, `OMX_SPARKSHELL_MODEL`, `OMX_SPARKSHELL_FALLBACK_MODEL`, `OMX_SPARKSHELL_MODEL_INSTRUCTIONS_FILE` y `OMX_SPARKSHELL_SUMMARY_TIMEOUT_MS`.

```bash
omx sparkshell git status
omx sparkshell --tmux-pane %12 --tail-lines 400
```

### Wiki

- `omx wiki` es la interfaz JSON prioritaria de CLI; `omx_wiki` MCP es solo compatibilidad explícita.
- Los datos wiki son conocimiento de proyecto en Markdown bajo `omx_wiki/`.
- El sistema prioriza Markdown y búsqueda, no vectores.

```bash
omx wiki list --json
omx wiki query --input '{"query":"session-start lifecycle"}' --json
omx wiki lint --json
omx wiki refresh --json
```

### Notas de plataforma para Team

`omx team` funciona mejor en macOS/Linux con `tmux`. Windows nativo es una ruta secundaria; para Windows, WSL2 suele ser mejor. En Windows nativo, OMX acepta `psmux` como binario compatible con tmux para las rutas existentes.

| Plataforma | Instalación |
| --- | --- |
| macOS | `brew install tmux` |
| Ubuntu/Debian | `sudo apt install tmux` |
| Fedora | `sudo dnf install tmux` |
| Arch | `sudo pacman -S tmux` |
| Windows | `winget install psmux` |
| Windows (WSL2) | `sudo apt install tmux` |

## Problemas conocidos

### Intel Mac: uso elevado de CPU por `syspolicyd` / `trustd` al iniciar

En algunos Mac Intel, el inicio de OMX —sobre todo con `--madmax --high`— puede elevar la CPU de `syspolicyd` / `trustd` mientras Gatekeeper valida muchos procesos concurrentes.

Si ocurre:
- `xattr -dr com.apple.quarantine $(which omx)`
- añade tu terminal a la lista de herramientas de desarrollo permitidas en Seguridad de macOS
- reduce la concurrencia; por ejemplo, evita `--madmax --high`

## Documentación

- [Primeros pasos](../../docs/getting-started.html)
- [Guía de demostración](../../DEMO.md)
- [Función Wiki](../../docs/wiki-feature.md)
- [Catálogo de agentes](../../docs/agents.html)
- [Referencia de skills](../../docs/skills.html)
- [Mapa de hooks nativos de Codex](../../docs/codex-native-hooks.md)
- [Pipeline de identidad GitHub/PR/paquete](../../docs/pipeline/github-pr-package-identity.md)
- [Integraciones](../../docs/integrations.html)
- [Solución de problemas de ejecución](../../docs/troubleshooting.md)
- [Guía de OpenClaw/gateway de notificaciones](../../docs/openclaw-integration.md)
- [Contribuir](../../CONTRIBUTING.md)
- [Registro de cambios](../../CHANGELOG.md)

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

| Rol | Nombre | GitHub |
| --- | --- | --- |
| Creador y líder | Yeachan Heo | [@Yeachan-Heo](https://github.com/Yeachan-Heo) |
| Mantenedor | Doyun Ha | [@HaD0Yun](https://github.com/HaD0Yun) |
| Mantenedor | Valeriy Pavlovich | [@iqdoctor](https://github.com/iqdoctor) |

## Historial de estrellas

[![Gráfico del historial de estrellas](https://api.star-history.com/svg?repos=Yeachan-Heo/oh-my-codex&type=date&legend=top-left)](https://www.star-history.com/#Yeachan-Heo/oh-my-codex&type=date&legend=top-left)

## Licencia

MIT

## Benchmark de visibilidad GEO

OMX incluye una especificación de producto [`geobench`](https://github.com/NomaDamas/geobench) para medir tasa de aciertos de LLM, MRR, cuota de voz y citas.

- Especificación: [`geobench/oh-my-codex.yaml`](../../geobench/oh-my-codex.yaml)
- Guía de ejecución: [`docs/geobench.md`](../../docs/geobench.md)
