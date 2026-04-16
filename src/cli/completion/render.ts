import type { CompletionNode } from './catalog.js';

interface FlatCompletionTables {
  subcommands: Record<string, string[]>;
  options: Record<string, string[]>;
  positionalValues: Record<string, string[]>;
  optionValues: Record<string, string[]>;
}

const BASH_ROOT_KEY = '__omx_root__';

function unique(values: readonly string[] | undefined): string[] {
  if (!values || values.length === 0) return [];
  return [...new Set(values)];
}

function flattenCatalog(
  node: CompletionNode,
  path = '',
  tables: FlatCompletionTables = {
    subcommands: {},
    options: {},
    positionalValues: {},
    optionValues: {},
  },
): FlatCompletionTables {
  tables.subcommands[path] = unique(node.subcommands?.map((entry) => entry.name));
  tables.options[path] = unique(node.options?.flatMap((entry) => entry.flags));
  tables.positionalValues[path] = unique(node.positionalValues);

  for (const option of node.options ?? []) {
    if (!option.values || option.values.length === 0) continue;
    for (const flag of option.flags) {
      tables.optionValues[`${path}|${flag}`] = unique(option.values);
    }
  }

  for (const child of node.subcommands ?? []) {
    const childPath = path ? `${path} ${child.name}` : child.name;
    flattenCatalog(child, childPath, tables);
  }

  return tables;
}

function escapeForDoubleQuotes(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function renderBashAssoc(name: string, values: Record<string, string[]>): string {
  const entries = Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, list]) => {
      const normalizedKey = key === '' ? BASH_ROOT_KEY : key;
      return `  ["${escapeForDoubleQuotes(normalizedKey)}"]="${escapeForDoubleQuotes(list.join(' '))}"`;
    });
  return [`declare -A ${name}=(`, ...entries, ')'].join('\n');
}

function renderZshAssoc(name: string, values: Record<string, string[]>): string {
  const entries = Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, list]) => `  ["${escapeForDoubleQuotes(key)}"]="${escapeForDoubleQuotes(list.join(' '))}"`);
  return [`typeset -A ${name}`, `${name}=(`, ...entries, ')'].join('\n');
}

function renderFishCaseBlocks(values: Record<string, string[]>): string[] {
  return Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, list]) => {
      const caseValue = key === '' ? "''" : `'${key.replace(/'/g, "\\'")}'`;
      if (list.length === 0) return [
        `    case ${caseValue}`,
        '      return 0',
      ];
      return [
        `    case ${caseValue}`,
        ...list.map((entry) => `      printf '%s\\n' '${entry.replace(/'/g, "\\'")}'`),
      ];
    });
}

function renderPowerShellHashtable(name: string, values: Record<string, string[]>): string {
  const entries = Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, list]) => {
      const escapedKey = key.replace(/'/g, "''");
      const renderedValues = list.map((entry) => `'${entry.replace(/'/g, "''")}'`).join(', ');
      return `  '${escapedKey}' = @(${renderedValues})`;
    });
  return [`$${name} = @{`, ...entries, '}'].join('\n');
}

export function renderBashCompletion(catalog: CompletionNode): string {
  const tables = flattenCatalog(catalog);
  return [
    '# omx bash completion',
    renderBashAssoc('__OMX_SUBCOMMANDS', tables.subcommands),
    '',
    renderBashAssoc('__OMX_OPTIONS', tables.options),
    '',
    renderBashAssoc('__OMX_POSITIONALS', tables.positionalValues),
    '',
    renderBashAssoc('__OMX_OPTION_VALUES', tables.optionValues),
    '',
    '__omx_contains() {',
    '  local needle="$1"',
    '  shift || true',
    '  local entry',
    '  for entry in "$@"; do',
    '    if [[ "$entry" == "$needle" ]]; then',
    '      return 0',
    '    fi',
    '  done',
    '  return 1',
    '}',
    '',
    '__omx_list() {',
    '  local list="$1"',
    '  if [[ -n "$list" ]]; then',
    '    printf "%s\\n" $list',
    '  fi',
    '}',
    '',
    '__omx_join_path() {',
    '  local path="$1" token="$2"',
    '  if [[ -z "$path" ]]; then',
    '    printf "%s" "$token"',
    '  else',
    '    printf "%s %s" "$path" "$token"',
    '  fi',
    '}',
    '',
    '__omx_path_key() {',
    '  local path="$1"',
    '  if [[ -z "$path" ]]; then',
    `    printf "%s" "${BASH_ROOT_KEY}"`,
    '  else',
    '    printf "%s" "$path"',
    '  fi',
    '}',
    '',
    '__omx_option_expects_value() {',
    '  local path="$1" flag="$2"',
    '  [[ -n "${__OMX_OPTION_VALUES["$path|$flag"]}" ]]',
    '}',
    '',
    '_omx() {',
    '  local cur prev path token idx values',
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    '  prev="${COMP_WORDS[COMP_CWORD-1]}"',
    '  path=""',
    '  idx=1',
    '  while (( idx < COMP_CWORD )); do',
    '    token="${COMP_WORDS[idx]}"',
    '    if __omx_option_expects_value "$path" "$token"; then',
    '      ((idx+=2))',
    '      continue',
    '    fi',
    '    mapfile -t values < <(__omx_list "${__OMX_SUBCOMMANDS[$(__omx_path_key "$path")]}")',
    '    if __omx_contains "$token" "${values[@]}"; then',
    '      path="$(__omx_join_path "$path" "$token")"',
    '      ((idx+=1))',
    '      continue',
    '    fi',
    '    mapfile -t values < <(__omx_list "${__OMX_POSITIONALS[$(__omx_path_key "$path")]}")',
    '    if __omx_contains "$token" "${values[@]}"; then',
    '      ((idx+=1))',
      '      continue',
    '    fi',
    '    ((idx+=1))',
    '  done',
    '  local suggestions="" option_key',
    '  option_key="$path|$prev"',
    '  if [[ -n "$prev" && -n "${__OMX_OPTION_VALUES[$option_key]}" ]]; then',
    '    suggestions="${__OMX_OPTION_VALUES[$option_key]}"',
    '  else',
    '    suggestions="${__OMX_SUBCOMMANDS[$(__omx_path_key "$path")]} ${__OMX_OPTIONS[$(__omx_path_key "$path")]} ${__OMX_POSITIONALS[$(__omx_path_key "$path")]}"',
    '  fi',
    '  COMPREPLY=( $(compgen -W "$suggestions" -- "$cur") )',
    '}',
    '',
    'complete -F _omx omx',
    '',
  ].join('\n');
}

export function renderZshCompletion(catalog: CompletionNode): string {
  const tables = flattenCatalog(catalog);
  return [
    '#compdef omx',
    '# omx zsh completion',
    renderZshAssoc('__OMX_SUBCOMMANDS', tables.subcommands),
    '',
    renderZshAssoc('__OMX_OPTIONS', tables.options),
    '',
    renderZshAssoc('__OMX_POSITIONALS', tables.positionalValues),
    '',
    renderZshAssoc('__OMX_OPTION_VALUES', tables.optionValues),
    '',
    '__omx_list() {',
    '  local list="$1"',
    '  if [[ -n "$list" ]]; then',
    '    print -r -- $list',
    '  fi',
    '}',
    '',
    '__omx_contains() {',
    '  local needle="$1"',
    '  shift',
    '  local entry',
    '  for entry in "$@"; do',
    '    if [[ "$entry" == "$needle" ]]; then',
    '      return 0',
    '    fi',
    '  done',
    '  return 1',
    '}',
    '',
    '__omx_join_path() {',
    '  local path="$1" token="$2"',
    '  if [[ -z "$path" ]]; then',
    '    print -r -- "$token"',
    '  else',
    '    print -r -- "$path $token"',
    '  fi',
    '}',
    '',
    '__omx_option_expects_value() {',
    '  local path="$1" flag="$2"',
    '  [[ -n "${__OMX_OPTION_VALUES["$path|$flag"]}" ]]',
    '}',
    '',
    '_omx() {',
    '  local cur prev path token idx option_key',
    '  local -a values suggestions',
    '  cur="${words[CURRENT]}"',
    '  prev="${words[CURRENT-1]}"',
    '  path=""',
    '  idx=2',
    '  while (( idx < CURRENT )); do',
    '    token="${words[idx]}"',
    '    if __omx_option_expects_value "$path" "$token"; then',
    '      ((idx+=2))',
    '      continue',
    '    fi',
    '    values=(${=__OMX_SUBCOMMANDS[$path]})',
    '    if __omx_contains "$token" "${values[@]}"; then',
    '      path="$(__omx_join_path "$path" "$token")"',
    '      ((idx+=1))',
    '      continue',
    '    fi',
    '    values=(${=__OMX_POSITIONALS[$path]})',
    '    if __omx_contains "$token" "${values[@]}"; then',
    '      ((idx+=1))',
    '      continue',
    '    fi',
    '    ((idx+=1))',
    '  done',
    '  option_key="$path|$prev"',
    '  if [[ -n "$prev" && -n "${__OMX_OPTION_VALUES[$option_key]}" ]]; then',
    '    suggestions=(${=__OMX_OPTION_VALUES[$option_key]})',
    '  else',
    '    suggestions=(${=__OMX_SUBCOMMANDS[$path]} ${=__OMX_OPTIONS[$path]} ${=__OMX_POSITIONALS[$path]})',
    '  fi',
    '  compadd -- $suggestions',
    '}',
    '',
    'compdef _omx omx',
    '',
  ].join('\n');
}

export function renderFishCompletion(catalog: CompletionNode): string {
  const tables = flattenCatalog(catalog);
  return [
    '# omx fish completion',
    'function __omx_join_path --argument-names path token',
    '  if test -z "$path"',
    '    printf "%s" "$token"',
    '  else',
    '    printf "%s %s" "$path" "$token"',
    '  end',
    'end',
    '',
    'function __omx_get_subcommands --argument-names path',
    '  switch "$path"',
    ...renderFishCaseBlocks(tables.subcommands),
    '  end',
    'end',
    '',
    'function __omx_get_options --argument-names path',
    '  switch "$path"',
    ...renderFishCaseBlocks(tables.options),
    '  end',
    'end',
    '',
    'function __omx_get_positionals --argument-names path',
    '  switch "$path"',
    ...renderFishCaseBlocks(tables.positionalValues),
    '  end',
    'end',
    '',
    'function __omx_get_option_values --argument-names path flag',
    '  switch "$path|$flag"',
    ...renderFishCaseBlocks(tables.optionValues),
    '  end',
    'end',
    '',
    'function __omx_option_expects_value --argument-names path flag',
    '  set -l values (__omx_get_option_values "$path" "$flag")',
    '  test (count $values) -gt 0',
    'end',
    '',
    'function __omx_complete',
    '  set -l words (commandline -opc)',
    '  set -l current (commandline -ct)',
    '  if test (count $words) -gt 0; and test "$words[-1]" = "$current"',
    '    set -e words[-1]',
    '  end',
    '  if test (count $words) -gt 0',
    '    set -e words[1]',
    '  end',
    '  set -l path ""',
    '  set -l idx 1',
    '  while test $idx -le (count $words)',
    '    set -l token $words[$idx]',
    '    if __omx_option_expects_value "$path" "$token"',
    '      set idx (math $idx + 2)',
    '      continue',
    '    end',
    '    if contains -- "$token" (__omx_get_subcommands "$path")',
    '      set path (__omx_join_path "$path" "$token")',
    '      set idx (math $idx + 1)',
    '      continue',
    '    end',
    '    if contains -- "$token" (__omx_get_positionals "$path")',
    '      set idx (math $idx + 1)',
    '      continue',
    '    end',
    '    set idx (math $idx + 1)',
    '  end',
    '  set -l prev ""',
    '  if test (count $words) -gt 0',
    '    set prev $words[-1]',
    '  end',
    '  if test -n "$prev"; and __omx_option_expects_value "$path" "$prev"',
    '    __omx_get_option_values "$path" "$prev"',
    '    return 0',
    '  end',
    '  __omx_get_subcommands "$path"',
    '  __omx_get_options "$path"',
    '  __omx_get_positionals "$path"',
    'end',
    '',
    'complete -f -c omx -a "(__omx_complete)"',
    '',
  ].join('\n');
}

export function renderPowerShellCompletion(catalog: CompletionNode): string {
  const tables = flattenCatalog(catalog);
  return [
    '# omx PowerShell completion',
    renderPowerShellHashtable('OmxSubcommands', tables.subcommands),
    '',
    renderPowerShellHashtable('OmxOptions', tables.options),
    '',
    renderPowerShellHashtable('OmxPositionals', tables.positionalValues),
    '',
    renderPowerShellHashtable('OmxOptionValues', tables.optionValues),
    '',
    'function Get-OmxList([hashtable]$Table, [string]$Key) {',
    '  if ($Table.ContainsKey($Key)) { return [string[]]$Table[$Key] }',
    '  return @()',
    '}',
    '',
    'function Test-OmxContains([string[]]$Items, [string]$Value) {',
    '  foreach ($Item in $Items) {',
    '    if ($Item -eq $Value) { return $true }',
    '  }',
    '  return $false',
    '}',
    '',
    'function Join-OmxPath([string]$Path, [string]$Token) {',
    '  if ([string]::IsNullOrEmpty($Path)) { return $Token }',
    '  return "$Path $Token"',
    '}',
    '',
    'function Get-OmxSuggestions([string[]]$CompletedWords, [string]$WordToComplete) {',
    '  $path = ""',
    '  for ($idx = 0; $idx -lt $CompletedWords.Count; $idx++) {',
    '    $token = $CompletedWords[$idx]',
    '    $optionKey = "$path|$token"',
    '    if ($OmxOptionValues.ContainsKey($optionKey)) {',
    '      $idx += 1',
    '      continue',
    '    }',
    '    $subcommands = Get-OmxList $OmxSubcommands $path',
    '    if (Test-OmxContains $subcommands $token) {',
    '      $path = Join-OmxPath $path $token',
    '      continue',
    '    }',
    '    $positionals = Get-OmxList $OmxPositionals $path',
    '    if (Test-OmxContains $positionals $token) {',
    '      continue',
    '    }',
    '  }',
    '  if ($CompletedWords.Count -gt 0) {',
    '    $previous = $CompletedWords[$CompletedWords.Count - 1]',
    '    $previousKey = "$path|$previous"',
    '    if ($OmxOptionValues.ContainsKey($previousKey)) {',
    '      return Get-OmxList $OmxOptionValues $previousKey | Where-Object { $_ -like "$WordToComplete*" }',
    '    }',
    '  }',
    '  $suggestions = @()',
    '  $suggestions += Get-OmxList $OmxSubcommands $path',
    '  $suggestions += Get-OmxList $OmxOptions $path',
    '  $suggestions += Get-OmxList $OmxPositionals $path',
    '  return $suggestions | Where-Object { $_ -like "$WordToComplete*" } | Select-Object -Unique',
    '}',
    '',
    'Register-ArgumentCompleter -Native -CommandName omx -ScriptBlock {',
    '  param($WordToComplete, $CommandAst, $CursorPosition)',
    '  $elements = @($CommandAst.CommandElements | ForEach-Object { $_.Extent.Text })',
    '  if ($elements.Count -gt 1) {',
    '    $elements = $elements[1..($elements.Count - 1)]',
    '  } else {',
    '    $elements = @()',
    '  }',
    '  if ($elements.Count -gt 0 -and $WordToComplete -ne "" -and $elements[-1] -eq $WordToComplete) {',
    '    $elements = if ($elements.Count -gt 1) { $elements[0..($elements.Count - 2)] } else { @() }',
    '  }',
    '  foreach ($Suggestion in Get-OmxSuggestions $elements $WordToComplete) {',
    "    [System.Management.Automation.CompletionResult]::new($Suggestion, $Suggestion, 'ParameterValue', $Suggestion)",
    '  }',
    '}',
    '',
  ].join('\n');
}
