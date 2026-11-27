import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { DatabaseType } from '@/lib/domain';
import { loadFromDatabaseMetadata } from '../import';
import { DatabaseMetadataSchema } from '../metadata-types/database-metadata';
import { getSQLiteQuery } from '../scripts/sqlite-script';
import { isStringMetadataJson } from '../utils';
import { readSQLiteFile } from '../sqlite-file';

let sqlite: SqlJsStatic;

beforeAll(async () => {
    sqlite = await initSqlJs();
});

const createFile = (ddl: string) => {
    const db = new sqlite.Database();
    try {
        db.run(ddl);
        return db.export();
    } finally {
        db.close();
    }
};

const readFile = (bytes: Uint8Array) =>
    readSQLiteFile(
        (data) => new sqlite.Database(data),
        bytes,
        'sample.sqlite3'
    );

const metadataFor = (ddl: string) => {
    const result = readFile(createFile(ddl));
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('Schema unavailable');
    return DatabaseMetadataSchema.parse(result.metadata);
};

describe('SQLite file import', () => {
    it('imports column types, generated fields, defaults and constraints', async () => {
        const metadata = metadataFor(`
            CREATE TABLE item (
                id INTEGER PRIMARY KEY,
                code VARCHAR(24) NOT NULL UNIQUE,
                amount NUMERIC(12, 2) DEFAULT 0,
                doubled NUMERIC GENERATED ALWAYS AS (amount * 2) STORED
            );
            INSERT INTO item (code) VALUES ('fixture row contents');
        `);
        const diagram = await loadFromDatabaseMetadata({
            databaseType: DatabaseType.SQLITE,
            databaseMetadata: metadata,
        });
        expect(diagram.name).toBe('sample');
        expect(diagram.tables?.[0].fields).toMatchObject([
            { name: 'id', primaryKey: true, nullable: false },
            {
                name: 'code',
                unique: true,
                nullable: false,
                characterMaximumLength: '24',
            },
            { name: 'amount', precision: 12, scale: 2, default: '0' },
            { name: 'doubled' },
        ]);
        expect(diagram.relationships).toEqual([]);
        expect(JSON.stringify(metadata)).not.toContain('fixture row contents');
    });

    it('preserves declared relationships, actions and views', async () => {
        const metadata = metadataFor(`
            CREATE TABLE Parent (Id INTEGER PRIMARY KEY);
            CREATE TABLE child (parent_id INT REFERENCES parent(id) ON DELETE CASCADE);
            CREATE TABLE unrelated (parent_id INT);
            CREATE VIEW child_view AS SELECT parent_id FROM child;
        `);
        expect(metadata.fk_info).toMatchObject([
            {
                table: 'child',
                reference_table: 'Parent',
                reference_column: 'Id',
                fk_def: 'ON UPDATE NO ACTION ON DELETE CASCADE',
            },
        ]);
        const diagram = await loadFromDatabaseMetadata({
            databaseType: DatabaseType.SQLITE,
            databaseMetadata: metadata,
        });
        expect(diagram.tables).toHaveLength(4);
        expect(
            diagram.tables?.find((table) => table.name === 'child_view')?.isView
        ).toBe(true);
        expect(diagram.relationships).toHaveLength(1);
    });

    it('resolves implicit composite foreign keys in primary-key order', async () => {
        const metadata = metadataFor(`
            CREATE TABLE parent (a TEXT, b TEXT, PRIMARY KEY (b, a)) WITHOUT ROWID;
            CREATE TABLE child (x TEXT, y TEXT, FOREIGN KEY (x, y) REFERENCES parent);
            CREATE UNIQUE INDEX child_pair ON child (y DESC, x);
            CREATE UNIQUE INDEX partial_child ON child (x) WHERE y IS NOT NULL;
            CREATE INDEX expression_child ON child (LOWER(x), y);
        `);
        expect(metadata.pk_info.map((key) => key.column)).toEqual(['b', 'a']);
        expect(
            metadata.fk_info.map((key) => [key.column, key.reference_column])
        ).toEqual([
            ['x', 'b'],
            ['y', 'a'],
        ]);
        expect(
            metadata.indexes.filter((idx) => idx.table === 'child')
        ).toMatchObject([
            {
                name: 'child_pair',
                column: 'y',
                unique: true,
                direction: 'DESC',
            },
            { name: 'child_pair', column: 'x', unique: true, direction: 'ASC' },
        ]);
        const diagram = await loadFromDatabaseMetadata({
            databaseType: DatabaseType.SQLITE,
            databaseMetadata: metadata,
        });
        expect(
            diagram.tables
                ?.find((table) => table.name === 'parent')
                ?.fields.every((field) => field.primaryKey && !field.nullable)
        ).toBe(true);
        expect(diagram.relationships).toHaveLength(2);
    });

    it('preserves punctuation, quotes, commas, spaces and Unicode', async () => {
        const metadata = metadataFor(`
            CREATE TABLE "München, ""West""" (" Schlüssel " TEXT PRIMARY KEY);
            CREATE TABLE "s'outh" ("a,ß" TEXT REFERENCES "München, ""West""" (" Schlüssel "));
        `);
        const diagram = await loadFromDatabaseMetadata({
            databaseType: DatabaseType.SQLITE,
            databaseMetadata: metadata,
        });
        const table = diagram.tables?.find(
            ({ name }) => name === 'München, "West"'
        );
        expect(table?.fields[0]).toMatchObject({
            name: ' Schlüssel ',
            primaryKey: true,
        });
        expect(diagram.relationships).toHaveLength(1);
    });

    it('handles empty databases and ignores internal tables', () => {
        expect(readFile(createFile('PRAGMA user_version = 1'))).toEqual({
            status: 'empty',
        });
        expect(readFile(new Uint8Array())).toEqual({ status: 'empty' });
        const metadata = metadataFor(
            'CREATE TABLE a (id INTEGER PRIMARY KEY AUTOINCREMENT)'
        );
        expect(metadata.tables.map(({ table }) => table)).toEqual(['a']);
    });

    it('rejects unrelated, forged and truncated files', () => {
        expect(
            readFile(new TextEncoder().encode('this is not SQLite'))
        ).toEqual({ status: 'invalid' });
        const forged = new Uint8Array(4096);
        forged.set(new TextEncoder().encode('SQLite format 3\0'));
        expect(readFile(forged)).toEqual({ status: 'invalid' });
        expect(
            readFile(createFile('CREATE TABLE a (id INT)').slice(0, 512))
        ).toEqual({ status: 'invalid' });
    });

    it('reads a larger model with multiple tables and relationships', () => {
        const count = 250;
        const metadata = metadataFor(
            Array.from(
                { length: count },
                (_, i) =>
                    `CREATE TABLE t${i} (id INTEGER PRIMARY KEY${i ? `, parent_id INTEGER REFERENCES t${i - 1}(id)` : ''});`
            ).join('\n')
        );
        expect(metadata.tables).toHaveLength(count);
        expect(metadata.fk_info).toHaveLength(count - 1);
    });

    it('still loads the standard SQLite Smart Query output', async () => {
        const db = new sqlite.Database(
            createFile(
                'CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (id INTEGER REFERENCES parent(id));'
            )
        );
        try {
            const json = db.exec(getSQLiteQuery())[0].values[0][0];
            expect(typeof json).toBe('string');
            if (typeof json !== 'string')
                throw new Error('Smart Query output missing');
            expect(isStringMetadataJson(json)).toBe(true);
            const diagram = await loadFromDatabaseMetadata({
                databaseType: DatabaseType.SQLITE,
                databaseMetadata: DatabaseMetadataSchema.parse(
                    JSON.parse(json)
                ),
            });
            expect(diagram.tables).toHaveLength(2);
            expect(diagram.relationships).toHaveLength(1);
        } finally {
            db.close();
        }
    });
});
