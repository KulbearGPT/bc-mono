import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const planPath = path.join(root, 'outputs/P0开发交付包/07-验收测试/Dashboard-E2E自动化测试开发计划.md');
const specsPath = path.join(root, 'tests/e2e/dashboard');
const idPattern = /DE2E-[A-Z]+-\d{3}/g;
const collect = (source) => source.match(idPattern) ?? [];
const difference = (left, right) => [...left].filter((id) => !right.has(id)).sort();

const planSource = await readFile(planPath, 'utf8');
const specFiles = (await readdir(specsPath)).filter((name) => name.endsWith('.spec.ts')).sort();
const specSources = await Promise.all(specFiles.map((name) => readFile(path.join(specsPath, name), 'utf8')));
const planned = new Set(collect(planSource));
const implementedOccurrences = specSources.flatMap(collect);
const implemented = new Set(implementedOccurrences);
const duplicates = [...new Set(implementedOccurrences.filter((id, index, all) => all.indexOf(id) !== index))].sort();
const missing = difference(planned, implemented);
const extra = difference(implemented, planned);
const expectedCount = 131;
const failures = [];

if (planned.size !== expectedCount) failures.push(`plan has ${planned.size} unique IDs; expected ${expectedCount}`);
if (implemented.size !== expectedCount) failures.push(`specs have ${implemented.size} unique IDs; expected ${expectedCount}`);
if (missing.length) failures.push(`missing IDs: ${missing.join(', ')}`);
if (extra.length) failures.push(`unplanned IDs: ${extra.join(', ')}`);
if (duplicates.length) failures.push(`duplicate test IDs: ${duplicates.join(', ')}`);

if (failures.length) {
  console.error('Dashboard E2E coverage verification failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Dashboard E2E coverage verified: ${planned.size} planned IDs = ${implemented.size} unique implemented IDs.`);
}
