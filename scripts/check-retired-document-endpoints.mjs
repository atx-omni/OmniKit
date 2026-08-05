#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);
const SKIPPED_DIRECTORIES = new Set([
  '__fixtures__',
  '__tests__',
  'coverage',
  'dist',
  'docs',
  'examples',
  'fixtures',
  'node_modules',
  'test',
  'tests',
]);

function staticText(node, constants) {
  if (!node) return null;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isIdentifier(node)) return constants.get(node.text) ?? null;
  if (ts.isParenthesizedExpression(node)) return staticText(node.expression, constants);
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    return staticText(node.expression, constants);
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      value += ':param';
      value += span.literal.text;
    }
    return value;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticText(node.left, constants);
    const right = staticText(node.right, constants);
    return left !== null && right !== null ? `${left}${right}` : null;
  }
  return null;
}

function collectStaticConstants(sourceFile) {
  const constants = new Map();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
    ) {
      const value = staticText(node.initializer, constants);
      if (value !== null) constants.set(node.name.text, value);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return constants;
}

function normalizedDocumentPath(rawValue) {
  const value = rawValue.trim();
  const apiIndex = value.indexOf('/api/v1/documents');
  const directIndex = value.indexOf('/v1/documents');
  const start = apiIndex >= 0 ? apiIndex : directIndex;
  if (start < 0) return null;

  let endpoint = value.slice(start).split(/[?#]/, 1)[0];
  if (endpoint.startsWith('/api/')) endpoint = endpoint.slice(4);
  endpoint = endpoint.replace(/\/{2,}/g, '/').replace(/\/$/, '');
  return endpoint;
}

function methodFromCall(node, constants) {
  for (const argument of node.arguments) {
    if (!ts.isObjectLiteralExpression(argument)) continue;
    for (const property of argument.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = property.name.getText().replace(/^['"]|['"]$/g, '').toLowerCase();
      if (name !== 'method') continue;
      const method = staticText(property.initializer, constants)?.toUpperCase();
      if (method && HTTP_METHODS.has(method)) return method;
    }
  }

  for (const argument of node.arguments) {
    const method = staticText(argument, constants)?.toUpperCase();
    if (method && HTTP_METHODS.has(method)) return method;
  }

  const calleeName = ts.isPropertyAccessExpression(node.expression)
    ? node.expression.name.text
    : ts.isIdentifier(node.expression)
      ? node.expression.text
      : '';
  const method = calleeName.toUpperCase();
  if (HTTP_METHODS.has(method)) return method;
  if (calleeName === 'fetch') return 'GET';
  return null;
}

function retiredContract(method, endpoint) {
  const segments = endpoint.split('/').filter(Boolean);
  if (segments[0] !== 'v1' || segments[1] !== 'documents') return null;

  if (method === 'POST' && segments.length === 2) return 'POST /v1/documents';
  if (method === 'POST' && segments.length === 4 && segments[3] === 'draft') {
    return 'POST /v1/documents/:documentId/draft';
  }
  if (segments.length !== 3) return null;
  if (method === 'PUT') return 'PUT /v1/documents/:documentId';
  if (method === 'PATCH') return 'PATCH /v1/documents/:documentId';
  if (method === 'GET') return 'GET /v1/documents/:documentId';
  return null;
}

function sourceFiles(root) {
  const files = [];
  for (const productionRoot of ['server', 'src']) {
    const absoluteRoot = path.join(root, productionRoot);
    try {
      if (!statSync(absoluteRoot).isDirectory()) continue;
    } catch {
      continue;
    }

    const walk = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(path.join(directory, entry.name));
          continue;
        }
        if (!entry.isFile()) continue;
        if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
        if (/\.(?:spec|test)\.[^.]+$/i.test(entry.name)) continue;
        files.push(path.join(directory, entry.name));
      }
    };
    walk(absoluteRoot);
  }
  return files.sort();
}

export function findRetiredDocumentEndpointUsages(root) {
  const findings = [];
  for (const file of sourceFiles(root)) {
    const source = readFileSync(file, 'utf8');
    const scriptKind = file.endsWith('.tsx') || file.endsWith('.jsx')
      ? ts.ScriptKind.TSX
      : file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
    const constants = collectStaticConstants(sourceFile);

    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const method = methodFromCall(node, constants);
        if (method) {
          for (const argument of node.arguments) {
            const value = staticText(argument, constants);
            if (value === null) continue;
            const endpoint = normalizedDocumentPath(value);
            if (!endpoint) continue;
            const contract = retiredContract(method, endpoint);
            if (!contract) continue;
            const position = sourceFile.getLineAndCharacterOfPosition(argument.getStart(sourceFile));
            findings.push({
              contract,
              endpoint,
              file: path.relative(root, file),
              line: position.line + 1,
              column: position.character + 1,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return findings;
}

function commandRoot(argv) {
  const rootIndex = argv.indexOf('--root');
  if (rootIndex >= 0) {
    const requested = argv[rootIndex + 1];
    if (!requested) throw new Error('--root requires a directory path.');
    return path.resolve(requested);
  }
  return process.cwd();
}

function run() {
  const root = commandRoot(process.argv.slice(2));
  const findings = findRetiredDocumentEndpointUsages(root);
  if (findings.length === 0) {
    console.log('Documents V1 retirement guard passed: no retired document contracts found in production source.');
    return;
  }

  console.error(`Documents V1 retirement guard failed with ${findings.length} retired contract usage(s):`);
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line}:${finding.column} ${finding.contract} (${finding.endpoint})`);
  }
  process.exitCode = 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) run();
