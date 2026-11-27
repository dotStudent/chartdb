import React, { useEffect, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/button/button';
import { Spinner } from '@/components/spinner/spinner';
import {
    sqliteFileExtensions,
    sqliteFileMaxBytes,
    type SQLiteFileResult,
} from '@/lib/data/import-metadata/sqlite-file';

type Status = SQLiteFileResult['status'] | 'idle' | 'loading' | 'too_large';

export const SQLiteFileInput: React.FC<{
    onResult: (value: string) => void;
}> = ({ onResult }) => {
    const { t } = useTranslation();
    const input = useRef<HTMLInputElement>(null);
    const activeWorker = useRef<Worker>();
    const [status, setStatus] = useState<Status>('idle');
    const [filename, setFilename] = useState('');

    useEffect(
        () => () => {
            activeWorker.current?.terminate();
            activeWorker.current = undefined;
        },
        []
    );

    const readFile = (file?: File) => {
        if (!file) return;
        activeWorker.current?.terminate();
        activeWorker.current = undefined;
        onResult('');
        setFilename(file.name);

        if (!/\.(db|sqlite|sqlite3)$/i.test(file.name)) {
            setStatus('invalid');
            return;
        }
        if (file.size > sqliteFileMaxBytes) {
            setStatus('too_large');
            return;
        }
        setStatus('loading');

        try {
            const worker = new Worker(
                new URL(
                    '../../../lib/data/import-metadata/sqlite-file.worker.ts',
                    import.meta.url
                ),
                { type: 'module' }
            );
            activeWorker.current = worker;

            const finish = (result: SQLiteFileResult) => {
                if (activeWorker.current !== worker) return;
                worker.terminate();
                activeWorker.current = undefined;
                setStatus(result.status);
                if (result.status === 'ready') {
                    onResult(JSON.stringify(result.metadata));
                }
            };

            worker.onmessage = ({ data }: MessageEvent<SQLiteFileResult>) =>
                finish(data);
            worker.onerror = () => finish({ status: 'failed' });
            worker.postMessage(file);
        } catch {
            activeWorker.current?.terminate();
            activeWorker.current = undefined;
            setStatus('failed');
        }
    };

    const isError =
        status === 'invalid' || status === 'failed' || status === 'too_large';

    return (
        <div
            className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-md border border-dashed p-4 text-center"
            onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
            }}
            onDrop={(event) => {
                event.preventDefault();
                readFile(event.dataTransfer.files[0]);
            }}
        >
            <input
                ref={input}
                type="file"
                accept={sqliteFileExtensions}
                className="hidden"
                onChange={(event) => {
                    readFile(event.target.files?.[0]);
                    event.target.value = '';
                }}
            />
            <p className="text-sm text-muted-foreground">
                {t('sqlite_file.drop')}
            </p>
            <Button
                type="button"
                variant="outline"
                className="gap-2"
                onClick={() => input.current?.click()}
            >
                <Upload size={16} />
                {t('sqlite_file.choose')}
            </Button>
            {filename && (
                <p className="max-w-full break-all text-sm">{filename}</p>
            )}
            {status !== 'idle' && (
                <div
                    className="flex items-center gap-2 text-sm"
                    role={isError ? 'alert' : 'status'}
                >
                    {status === 'loading' && <Spinner size="small" />}
                    {t(`sqlite_file.${status}`)}
                </div>
            )}
        </div>
    );
};
