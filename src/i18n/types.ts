import type { en } from './locales/en';

export type LanguageTranslation = Omit<typeof en, 'translation'> & {
    translation: Omit<typeof en.translation, 'sqlite_file'> &
        Partial<Pick<typeof en.translation, 'sqlite_file'>>;
};

export type LanguageMetadata = {
    name: string;
    nativeName: string;
    code: string;
};
