#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import process from 'process';
import { validateCatalogManifest, summarizeCatalogCounts } from '../dist/catalog/schema.js';
import { toPublicCatalogContract } from '../dist/catalog/reader.js';

const CHECK_ONLY = process.argv.includes('--check');
const root = process.cwd();
const sourceManifestPath = join(root, 'src', 'catalog', 'manifest.json');
const templateManifestPath = join(root, 'templates', 'catalog-manifest.json');
const generatedDir = join(root, 'src', 'catalog', 'generated');
const generatedPublicCatalogPath = join(generatedDir, 'public-catalog.json');

const docsToScan = [
  join(root, 'docs', 'index.html'),
  join(root, 'docs', 'skills.html'),
  join(root, 'docs', 'agents.html'),
  join(root, 'README.md'),
  join(root, 'src', 'cli', 'setup.ts'),
  join(root, 'src', 'cli', 'doctor.ts'),
];

const forbiddenCountLiterals = [
  /\b30\b/,
  /\b40\b/,
  /30\+/,
  /\(40\)/,
  /expected\s+30\+/,
];

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = canonicalize(value[key]);
        return acc;
      }, {});
  }
  return value;
}

function assertDeepEqual(label, actual, expected) {
  const left = JSON.stringify(canonicalize(actual));
  const right = JSON.stringify(canonicalize(expected));
  if (left !== right) {
    throw new Error(label);
  }
}

function normalizePublicContract(contract) {
  if (!contract || typeof contract !== 'object') return contract;
  return {
    version: contract.version,
    counts: contract.counts,
    coreSkills: contract.coreSkills,
    skills: contract.skills,
    agents: contract.agents,
    aliases: contract.aliases,
    internalHidden: contract.internalHidden,
  };
}

function assertNoHardcodedCountLiterals() {
  const violations = [];
  for (const file of docsToScan) {
    const content = readFileSync(file, 'utf8');
    const matched = forbiddenCountLiterals.some((re) => re.test(content));
    if (matched) violations.push(file);
  }
  if (violations.length > 0) {
    throw new Error(`catalog_docs_hardcoded_counts:${violations.join(',')}`);
  }
}

function main() {
  const manifestRaw = JSON.parse(readFileSync(sourceManifestPath, 'utf8'));
  const manifest = validateCatalogManifest(manifestRaw);
  const publicContract = toPublicCatalogContract(manifest);
  const expectedCounts = summarizeCatalogCounts(manifest);

  if (CHECK_ONLY) {
    const templateRaw = JSON.parse(readFileSync(templateManifestPath, 'utf8'));
    const template = validateCatalogManifest(templateRaw);
    assertDeepEqual('catalog_manifest_drift:template_content_mismatch', template, manifest);

    const generatedRaw = JSON.parse(readFileSync(generatedPublicCatalogPath, 'utf8'));
    if (generatedRaw.counts?.skillCount !== expectedCounts.skillCount || generatedRaw.counts?.promptCount !== expectedCounts.promptCount) {
      throw new Error('catalog_generated_drift:counts_mismatch');
    }
    assertDeepEqual(
      'catalog_generated_drift:content_mismatch',
      normalizePublicContract(generatedRaw),
      normalizePublicContract(publicContract),
    );

    assertNoHardcodedCountLiterals();
    console.log('catalog check ok');
    return;
  }

  mkdirSync(generatedDir, { recursive: true });
  writeFileSync(templateManifestPath, JSON.stringify(manifest, null, 2));
  writeFileSync(generatedPublicCatalogPath, JSON.stringify(publicContract, null, 2));
  console.log(`wrote ${templateManifestPath}`);
  console.log(`wrote ${generatedPublicCatalogPath}`);
}

main();
