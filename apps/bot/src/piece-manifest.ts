import { readdir } from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SapphirePieceManifest {
  framework: '@sapphire/framework';
  rootDir: string;
  pieces: Array<{
    kind: string;
    name: string;
    path: string;
  }>;
}

const currentDir = dirname(fileURLToPath(import.meta.url));

export async function discoverSapphirePieces(
  rootDir = join(currentDir, 'pieces')
): Promise<SapphirePieceManifest> {
  const files = await listTypeScriptFiles(rootDir);
  return {
    framework: '@sapphire/framework',
    rootDir,
    pieces: files.map((filePath) => {
      const relativePath = relative(rootDir, filePath);
      const [kind] = relativePath.split('/');
      return {
        kind: kind ?? 'unknown',
        name: basename(filePath, extname(filePath)),
        path: relativePath
      };
    })
  };
}

async function listTypeScriptFiles(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const results = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = join(rootDir, entry.name);
      if (entry.isDirectory()) {
        return listTypeScriptFiles(absolutePath);
      }
      if (entry.isFile() && entry.name.endsWith('.ts')) {
        return [absolutePath];
      }
      return [];
    })
  );

  return results.flat().sort();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await discoverSapphirePieces(), null, 2));
}
