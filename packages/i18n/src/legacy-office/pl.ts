import { zh } from './zh'

export const pl = {
  modernCopy:
    'Zmiany zostaną zapisane w tej nowej kopii .{to}. Oryginał .{from} pozostanie bez zmian.',
  workbookCopy:
    'Zmiany zostaną zapisane w tej nowej kopii .xlsx. Oryginał .{from} pozostanie bez zmian.',
  workbookImport:
    'Importowane są wartości komórek i obsługiwane formuły. Formatowanie, wykresy, obrazy, makra i nazwane zakresy są pomijane. Formuły zachowane jako wartości z pamięci podręcznej: {formulas}. Arkusze z nieczytelnymi formułami: {sheets}.',
  chatCopy:
    'Zmiany zostaną zapisane w tym nowym pliku .{to}. Oryginał .{from} pozostanie bez zmian. Konwersja może zmienić układ lub animacje; makra nie są zachowywane.',
  notice:
    'Zaimportowano .{from} jako edytowalną kopię .{to}. Przy zapisie wybierz nowy plik; oryginał pozostanie bez zmian. Układ lub animacje mogą się zmienić, a makra nie zostaną zachowane.',
  missing:
    'Zainstaluj LibreOffice, aby importować pliki Office lub OpenDocument, albo ustaw NAWA_LIBREOFFICE_PATH na plik wykonywalny i uruchom ponownie Nawa.',
  tooLarge: 'Import plików Office jest ograniczony do 64 MiB.',
  failed:
    'Nie można przekonwertować pliku. Może być uszkodzony, chroniony hasłem lub nieobsługiwany.',
  encrypted:
    'Nie można importować plików chronionych hasłem. Najpierw zapisz niezaszyfrowaną kopię w oryginalnej aplikacji.',
} satisfies Record<keyof typeof zh, string>
