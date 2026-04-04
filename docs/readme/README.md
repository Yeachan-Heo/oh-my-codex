---
title: README translations
description: Index and maintenance guidance for localized oh-my-codex README files
author: GitHub Copilot
ms.date: 2026-04-04
ms.topic: reference
keywords:
  - readme
  - translations
  - localization
  - documentation
estimated_reading_time: 2
---

## Purpose

This folder holds the localized README files for oh-my-codex.

The repository root keeps only the canonical `README.md` so the top level stays focused on the primary entry point, package metadata, and project-wide documents.

## Available translations

| Language            | File              |
|---------------------|-------------------|
| Deutsch             | [README.de.md](./README.de.md)       |
| English             | [../../README.md](../../README.md)   |
| Español             | [README.es.md](./README.es.md)       |
| Français            | [README.fr.md](./README.fr.md)       |
| Italiano            | [README.it.md](./README.it.md)       |
| Polski              | [README.pl.md](./README.pl.md)       |
| Português           | [README.pt.md](./README.pt.md)       |
| Русский             | [README.ru.md](./README.ru.md)       |
| Türkçe              | [README.tr.md](./README.tr.md)       |
| Tiếng Việt          | [README.vi.md](./README.vi.md)       |
| Ελληνικά            | [README.el.md](./README.el.md)       |
| 日本語              | [README.ja.md](./README.ja.md)       |
| 한국어              | [README.ko.md](./README.ko.md)       |
| 简体中文            | [README.zh.md](./README.zh.md)       |
| 繁體中文            | [README.zh-TW.md](./README.zh-TW.md) |

## Maintenance rules

* Treat `../../README.md` as the canonical source.
* Add new README translations in this folder, not at the repository root.
* Keep the language list synchronized between the canonical README and each localized variant.
* Keep relative links valid from `docs/readme/`.
* Prefer updating existing translations instead of introducing duplicate files or alternate naming schemes.

## Related docs

* Localized OpenClaw guides live one level up in `../`.
* The canonical project entry point remains `../../README.md`.