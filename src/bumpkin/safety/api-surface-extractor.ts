import { Project, type SourceFile, type Node } from 'ts-morph';

import type { SurfaceSnapshot } from './api-surface-differ.js';

export interface ExtractOptions {
  entryFiles: readonly string[];
  tsConfigFilePath?: string;
  includeInternalTypes?: boolean;
}

export function extractApiSurface(opts: ExtractOptions): SurfaceSnapshot {
  const project = opts.tsConfigFilePath
    ? new Project({ tsConfigFilePath: opts.tsConfigFilePath, skipAddingFilesFromTsConfig: true })
    : new Project({ useInMemoryFileSystem: false });
  const sourceFiles = project.addSourceFilesAtPaths([...opts.entryFiles]);
  const snapshot: Record<string, string> = {};

  for (const file of sourceFiles) {
    collectFromFile(file, snapshot);
  }
  return snapshot;
}

export function extractFromSource(sourceFilePath: string, source: string): SurfaceSnapshot {
  const project = new Project({ useInMemoryFileSystem: true });
  const file = project.createSourceFile(sourceFilePath, source, { overwrite: true });
  const snapshot: Record<string, string> = {};
  collectFromFile(file, snapshot);
  return snapshot;
}

function collectFromFile(file: SourceFile, snapshot: Record<string, string>): void {
  for (const [name, declarations] of file.getExportedDeclarations()) {
    for (const decl of declarations) {
      const signature = describeDeclaration(decl);
      if (signature) snapshot[name] = signature;
    }
  }
}

function describeDeclaration(node: Node): string | null {
  const kindName = node.getKindName();

  if (kindName === 'FunctionDeclaration' || kindName === 'MethodDeclaration') {
    return compactSignature(node.getText());
  }

  if (kindName === 'VariableDeclaration') {
    const sym = node.getSymbol();
    const type = sym?.getDeclarations()?.[0]?.getType().getText();
    return type ?? compactSignature(node.getText());
  }

  if (kindName === 'ClassDeclaration' || kindName === 'InterfaceDeclaration' || kindName === 'TypeAliasDeclaration') {
    return compactSignature(node.getText());
  }

  if (kindName === 'EnumDeclaration') {
    return compactSignature(node.getText());
  }

  return compactSignature(node.getText());
}

function compactSignature(raw: string): string {
  const stripped = raw
    .replace(/\/\*\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > 240 ? `${stripped.slice(0, 237)}...` : stripped;
}
