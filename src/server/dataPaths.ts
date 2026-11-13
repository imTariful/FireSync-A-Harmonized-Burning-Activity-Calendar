import path from 'node:path';

/** Dataset root for a file/glob, accepting native Windows and forward slashes. */
export function parquetDatasetDirectory(glob: string): string {
  const normalized = glob.replace(/\\/g, '/');
  const partition = normalized.indexOf('/year=');
  const directory = normalized.startsWith('year=') ? '.'
    : partition >= 0 ? normalized.slice(0, partition) : path.posix.dirname(normalized);
  if (/^[a-z]:$/i.test(directory)) return directory + '/';
  return directory || '/';
}

/** A SQL filename literal, not an escaped filesystem path. */
export function parquetSqlPath(filename: string): string {
  return `'${filename.replace(/\\/g, '/').replace(/'/g, "''")}'`;
}
