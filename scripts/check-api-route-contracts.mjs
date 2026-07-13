import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const apiSource = new URL('../apps/api/src/', import.meta.url);
const openapi = readFileSync(new URL('../outputs/P0开发交付包/02-API/openapi.yaml', import.meta.url), 'utf8');

const sourceOperations = new Set();
for (const name of readdirSync(apiSource).filter((file) => file.endsWith('.ts'))) {
  // dispatch.ts is retained as development-stage source but registerDispatchRoutes is not called by the production server.
  if (name === 'dispatch.ts') continue;
  const path = join(apiSource.pathname, name);
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  visit(source);
}

const contractOperations = new Set();
let currentPath = null;
for (const line of openapi.split(/\r?\n/u)) {
  const pathMatch = /^  (\/api\/[^:]+):\s*$/u.exec(line);
  if (pathMatch) {
    currentPath = pathMatch[1];
    continue;
  }
  const methodMatch = /^    (get|post|put|patch|delete):\s*$/u.exec(line);
  if (currentPath && methodMatch) contractOperations.add(`${methodMatch[1].toUpperCase()} ${currentPath}`);
}

const missing = [...sourceOperations].filter((operation) => !contractOperations.has(operation)).sort();
if (missing.length) {
  process.stderr.write(`OpenAPI is missing ${missing.length} production route(s):\n${missing.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Route contract parity passed: ${sourceOperations.size} production operations are documented.\n`
  );
}

function visit(node) {
  if (ts.isCallExpression(node) && isSecureRouteCall(node.expression)) {
    const object = node.arguments.find(ts.isObjectLiteralExpression);
    if (object) {
      const method = stringProperty(object, 'method');
      const url = stringProperty(object, 'url');
      if (method && url && url.startsWith('/api/'))
        sourceOperations.add(`${method.toUpperCase()} ${normalizePath(url)}`);
    }
  }
  ts.forEachChild(node, visit);
}

function isSecureRouteCall(expression) {
  return (
    ts.isIdentifier(expression) &&
    (expression.text === 'registerSecureReadRoute' || expression.text === 'registerSecureWriteRoute')
  );
}

function stringProperty(object, name) {
  const property = object.properties.find((item) => ts.isPropertyAssignment(item) && item.name.getText() === name);
  if (!property || !ts.isPropertyAssignment(property)) return null;
  return ts.isStringLiteralLike(property.initializer) ? property.initializer.text : null;
}

function normalizePath(path) {
  return path.replace(/:([A-Za-z][A-Za-z0-9_]*)/gu, '{$1}');
}
