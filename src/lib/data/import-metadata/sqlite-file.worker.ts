import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url&no-inline';
import { readSQLiteFile, type SQLiteFileResult } from './sqlite-file';

self.onmessage = async ({ data }: MessageEvent<File>) => {
    let result: SQLiteFileResult;
    try {
        const [sqlite, bytes] = await Promise.all([
            initSqlJs({ locateFile: () => wasmUrl }),
            data.arrayBuffer(),
        ]);
        result = readSQLiteFile(
            (content) => new sqlite.Database(content),
            new Uint8Array(bytes),
            data.name
        );
    } catch {
        result = { status: 'failed' };
    }
    self.postMessage(result);
};
