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
  /\b30\b/g,
  /\b40\b/g,
  /30\+/g,
  /\(40\)/g,
  /expected\s+30\+/g,
];

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
    if (template.catalogVersion !== manifest.catalogVersion) {
      throw new Error('catalog_manifest_drift:template_version_mismatch');
    }

    const generatedRaw = JSON.parse(readFileSync(generatedPublicCatalogPath, 'utf8'));
    if (generatedRaw.counts.skillCount !== expectedCounts.skillCount || generatedRaw.counts.promptCount !== expectedCounts.promptCount) {
      throw new Error('catalog_generated_drift:counts_mismatch');
    }

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
