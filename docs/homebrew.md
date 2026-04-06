# Homebrew Installation

oh-my-codex can be installed via Homebrew using the repository as a tap.

## Install

    brew tap Yeachan-Heo/oh-my-codex https://github.com/Yeachan-Heo/oh-my-codex.git
    brew install oh-my-codex

## Upgrade

    brew update
    brew upgrade oh-my-codex

## Uninstall

    brew uninstall oh-my-codex
    brew untap Yeachan-Heo/oh-my-codex

---

## Maintenance

The formula lives at `Formula/oh-my-codex.rb`. On each npm release,
two fields need updating:

| Field    | Source                          |
|----------|---------------------------------|
| `url`    | `npm view oh-my-codex dist.tarball` |
| `sha256` | `curl -sL <tarball-url> \| shasum -a 256` |

### Manual update

    URL=$(npm view oh-my-codex dist.tarball)
    SHA=$(curl -sL "$URL" | shasum -a 256 | awk '{print $1}')
    sed -i '' "s|url \".*\"|url \"$URL\"|" Formula/oh-my-codex.rb
    sed -i '' "s|sha256 \".*\"|sha256 \"$SHA\"|" Formula/oh-my-codex.rb

### CI automation (optional)

A GitHub Action triggered on release tags can run the update above and
open a PR automatically. See `brew bump-formula-pr` for Homebrew's
built-in tooling.

### Testing locally

    brew install --build-from-source ./Formula/oh-my-codex.rb
    brew test oh-my-codex
    omx --version
