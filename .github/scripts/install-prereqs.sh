#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <apt-package>... -- <required-command>..." >&2
}

if [[ $# -lt 3 ]]; then
  usage
  exit 2
fi

packages=()
commands=()
seen_separator=false
for arg in "$@"; do
  if [[ "$arg" == "--" ]]; then
    seen_separator=true
    continue
  fi

  if [[ "$seen_separator" == "true" ]]; then
    commands+=("$arg")
  else
    packages+=("$arg")
  fi
done

if [[ "$seen_separator" != "true" || ${#packages[@]} -eq 0 || ${#commands[@]} -eq 0 ]]; then
  usage
  exit 2
fi

missing_commands=()
for command_name in "${commands[@]}"; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    missing_commands+=("$command_name")
  fi
done

if [[ ${#missing_commands[@]} -eq 0 ]]; then
  echo "All required commands are already available: ${commands[*]}"
  exit 0
fi

echo "Missing required command(s): ${missing_commands[*]}"
echo "Attempting to install apt package(s): ${packages[*]}"

apt_get=()
if ! command -v apt-get >/dev/null 2>&1; then
  echo "::error::Cannot install missing command(s) (${missing_commands[*]}): apt-get is not available on this runner." >&2
  exit 1
elif [[ "$(id -u)" == "0" ]]; then
  apt_get=(env DEBIAN_FRONTEND=noninteractive apt-get)
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  apt_get=(sudo env DEBIAN_FRONTEND=noninteractive apt-get)
else
  echo "::error::Cannot install missing command(s) (${missing_commands[*]}): runner is not root and passwordless sudo is unavailable or blocked. Preinstall package(s): ${packages[*]}." >&2
  exit 1
fi

"${apt_get[@]}" update
"${apt_get[@]}" install -y --no-install-recommends "${packages[@]}"

still_missing=()
for command_name in "${commands[@]}"; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    still_missing+=("$command_name")
  fi
done

if [[ ${#still_missing[@]} -gt 0 ]]; then
  echo "::error::Prerequisite install completed, but command(s) are still missing: ${still_missing[*]}. Package(s) attempted: ${packages[*]}." >&2
  exit 1
fi

echo "Required command(s) available after prerequisite install: ${commands[*]}"
