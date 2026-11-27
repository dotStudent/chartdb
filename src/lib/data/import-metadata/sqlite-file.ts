import type { Database, SqlValue } from 'sql.js';
import type { DatabaseMetadata } from './metadata-types/database-metadata';

export const sqliteFileExtensions = '.db,.sqlite,.sqlite3';
export const sqliteFileMaxBytes = 128 * 1024 * 1024;

export type SQLiteFileResult =
    | { status: 'ready'; metadata: DatabaseMetadata }
    | { status: 'empty' | 'invalid' | 'failed' };

const sqliteHeader = 'SQLite format 3\0';

interface SQLiteColumn {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
}

interface SQLiteIndex {
    name: string;
    unique: number;
    origin: string;
    partial: number;
}

interface SQLiteIndexColumn {
    seqno: number;
    name: string | null;
    desc: number;
}

interface SQLiteForeignKey {
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string | null;
    on_update: string;
    on_delete: string;
}

const rows = <T>(db: Database, sql: string, params: SqlValue[] = []): T[] => {
    const statement = db.prepare(sql, params);
    try {
        const result: T[] = [];
        while (statement.step()) {
            result.push(statement.getAsObject() as T);
        }
        return result;
    } finally {
        statement.free();
    }
};

// SQLite folds only ASCII letters when resolving identifiers.
const identifierKey = (name: string): string =>
    name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

export const readSQLiteFile = (
    openDatabase: (bytes: Uint8Array) => Database,
    bytes: Uint8Array,
    filename: string
): SQLiteFileResult => {
    if (bytes.length === 0) return { status: 'empty' };
    if (
        bytes.length < 512 ||
        bytes.length > sqliteFileMaxBytes ||
        !bytes
            .subarray(0, sqliteHeader.length)
            .every((byte, index) => byte === sqliteHeader.charCodeAt(index))
    ) {
        return { status: 'invalid' };
    }

    let db: Database | undefined;
    try {
        db = openDatabase(bytes);
        db.run('PRAGMA trusted_schema = OFF; PRAGMA query_only = ON;');

        const metadata: DatabaseMetadata = {
            database_name: filename.replace(/\.(db|sqlite|sqlite3)$/i, ''),
            version: rows<{ version: string }>(
                db,
                'SELECT sqlite_version() AS version'
            )[0].version,
            tables: [],
            columns: [],
            pk_info: [],
            fk_info: [],
            indexes: [],
            views: [],
        };
        const objects = rows<{ name: string; type: 'table' | 'view' }>(
            db,
            `SELECT name, type FROM pragma_table_list
             WHERE schema = 'main' AND type IN ('table', 'view')
               AND name NOT GLOB 'sqlite_*'
             ORDER BY name`
        );
        const schemas = new Map<
            string,
            {
                name: string;
                columns: SQLiteColumn[];
                primaryKey: SQLiteColumn[];
            }
        >();

        for (const { name, type } of objects) {
            let columns: SQLiteColumn[];
            try {
                columns = rows<SQLiteColumn>(
                    db,
                    "SELECT * FROM pragma_table_xinfo(?, 'main') ORDER BY cid",
                    [name]
                );
            } catch (error) {
                // An unresolved view can require a module or function unavailable here.
                if (type === 'view') continue;
                throw error;
            }

            const indexes =
                type === 'table'
                    ? rows<SQLiteIndex>(
                          db,
                          "SELECT * FROM pragma_index_list(?, 'main')",
                          [name]
                      )
                    : [];
            const primaryKey = columns
                .filter((column) => column.pk > 0)
                .sort((a, b) => a.pk - b.pk);
            const rowidAlias =
                primaryKey.length === 1 &&
                primaryKey[0].type.toUpperCase() === 'INTEGER' &&
                !indexes.some((index) => index.origin === 'pk')
                    ? primaryKey[0]
                    : undefined;
            const table = { schema: '', table: name };
            schemas.set(identifierKey(name), { name, columns, primaryKey });
            metadata.tables.push({ ...table, type, rows: -1 });
            if (type === 'view') {
                metadata.views.push({ schema: '', view_name: name });
            }

            for (const column of columns) {
                const [, baseType, length, scale] =
                    /^(.*?)\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)$/.exec(
                        column.type
                    ) ?? [];
                const dataType = baseType ?? (column.type || 'blob');
                metadata.columns.push({
                    ...table,
                    name: column.name,
                    type: dataType,
                    ordinal_position: column.cid,
                    nullable: !column.notnull && column !== rowidAlias,
                    default: column.dflt_value,
                    is_identity: column === rowidAlias,
                    ...(/^(decimal|numeric)$/i.test(dataType) && length
                        ? {
                              precision: {
                                  precision: Number(length),
                                  scale:
                                      scale === undefined
                                          ? null
                                          : Number(scale),
                              },
                          }
                        : { character_maximum_length: length }),
                });
            }

            const pkDefinition = `PRIMARY KEY (${primaryKey
                .map((column) => '"' + column.name.replaceAll('"', '""') + '"')
                .join(', ')})`;
            for (const column of primaryKey) {
                metadata.pk_info.push({
                    ...table,
                    column: column.name,
                    pk_def: pkDefinition,
                });
            }

            for (const index of indexes) {
                // Partial and expression indexes cannot be represented faithfully.
                if (index.partial) continue;
                const fields = rows<SQLiteIndexColumn>(
                    db,
                    "SELECT * FROM pragma_index_xinfo(?, 'main') WHERE key = 1",
                    [index.name]
                );
                if (fields.some((field) => field.name === null)) continue;

                for (const field of fields) {
                    metadata.indexes.push({
                        ...table,
                        name: index.name,
                        column: field.name!,
                        index_type: 'B-TREE',
                        unique: Boolean(index.unique),
                        direction: field.desc ? 'DESC' : 'ASC',
                        column_position: field.seqno + 1,
                    });
                }
            }
        }

        for (const { table, type } of metadata.tables) {
            if (type !== 'table') continue;
            const keys = rows<SQLiteForeignKey>(
                db,
                "SELECT * FROM pragma_foreign_key_list(?, 'main')",
                [table]
            );
            for (const key of keys) {
                const target = schemas.get(identifierKey(key.table));
                const referencedColumn =
                    key.to === null
                        ? target?.primaryKey[key.seq]
                        : target?.columns.find(
                              (column) =>
                                  identifierKey(column.name) ===
                                  identifierKey(key.to!)
                          );
                if (!target || !referencedColumn) continue;
                metadata.fk_info.push({
                    schema: '',
                    table,
                    column: key.from,
                    foreign_key_name: `fk_${table}_${key.id}_${key.seq}`,
                    reference_schema: '',
                    reference_table: target.name,
                    reference_column: referencedColumn.name,
                    fk_def: `ON UPDATE ${key.on_update} ON DELETE ${key.on_delete}`,
                });
            }
        }

        return metadata.tables.length
            ? { status: 'ready', metadata }
            : { status: 'empty' };
    } catch {
        return { status: 'invalid' };
    } finally {
        db?.close();
    }
};
