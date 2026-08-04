import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

const root = 'apps/bot/src';

describe('M20-US-15 Bot module boundaries', () => {
  test('keeps every Bot source file and function within reviewable bounds', async () => {
    const violations: string[] = [];
    for (const path of await typescriptFiles(root)) {
      const source = await readFile(path, 'utf8');
      const lineCount = source.split('\n').length;
      if (lineCount > 700) violations.push(`${relative(root, path)}: ${lineCount} lines`);

      const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const inspect = (node: ts.Node): void => {
        if (isFunction(node) && node.body) {
          const start = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
          const end = file.getLineAndCharacterOfPosition(node.end).line + 1;
          const name = functionName(node);
          if (end - start + 1 > 150)
            violations.push(`${relative(root, path)}:${start} ${name}: ${end - start + 1} lines`);
          const decisions = decisionCount(node.body);
          if (decisions > 20) violations.push(`${relative(root, path)}:${start} ${name}: ${decisions} decisions`);
        }
        ts.forEachChild(node, inspect);
      };
      inspect(file);
    }
    expect(violations).toEqual([]);
  });

  test('preserves stable public facades while moving implementation to domain modules', async () => {
    const [center, api, config, selection] = await Promise.all(
      ['service-center.ts', 'service-center-api.ts', 'bot-config.ts', 'selection-discord.ts'].map((name) =>
        readFile(join(root, name), 'utf8')
      )
    );
    for (const [name, source] of [
      ['service-center.ts', center],
      ['service-center-api.ts', api],
      ['bot-config.ts', config],
      ['selection-discord.ts', selection]
    ] as const) {
      expect(source.split('\n').length, name).toBeLessThanOrEqual(250);
      expect(source, name).toMatch(/export \*/u);
    }
  });
});

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? typescriptFiles(path) : Promise.resolve(entry.name.endsWith('.ts') ? [path] : []);
    })
  );
  return nested.flat();
}

function isFunction(node: ts.Node): node is ts.FunctionLikeDeclaration & { body: ts.ConciseBody } {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isConstructorDeclaration(node)
  );
}

function functionName(node: ts.FunctionLikeDeclaration): string {
  if ('name' in node && node.name && ts.isIdentifier(node.name)) return node.name.text;
  return ts.isConstructorDeclaration(node) ? 'constructor' : '<anonymous>';
}

function decisionCount(rootNode: ts.Node): number {
  let count = 1;
  const visit = (node: ts.Node): void => {
    if (node !== rootNode && isFunction(node)) return;
    if (
      ts.isIfStatement(node) ||
      ts.isConditionalExpression(node) ||
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isCaseClause(node) ||
      ts.isCatchClause(node) ||
      (ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken))
    ) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(rootNode);
  return count;
}
