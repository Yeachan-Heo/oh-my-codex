# Homebrew

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

## Maintenance

The formula at `Formula/oh-my-codex.rb` is updated automatically.
The `bump-homebrew-formula` workflow runs after each release, pulls the
latest version and checksum from npm, and commits the updated formula
to `dev`.

To test the formula locally:

    brew install --build-from-source ./Formula/oh-my-codex.rb
    brew test oh-my-codex
