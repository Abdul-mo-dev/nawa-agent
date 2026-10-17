import { zh } from './zh'

export const cs = {
  modernCopy:
    'Úpravy se uloží do této nové kopie .{to}. Původní soubor .{from} zůstane beze změny.',
  workbookCopy:
    'Úpravy se uloží do této nové kopie .xlsx. Původní soubor .{from} zůstane beze změny.',
  workbookImport:
    'Importují se hodnoty buněk a podporované vzorce. Formátování, grafy, obrázky, makra a pojmenované oblasti se vynechají. Vzorce zachované jako hodnoty z mezipaměti: {formulas}. Listy s nečitelnými vzorci: {sheets}.',
  chatCopy:
    'Úpravy se uloží do tohoto nového souboru .{to}. Původní soubor .{from} zůstane beze změny. Převod může změnit rozvržení nebo animace; makra se nezachovají.',
  notice:
    'Soubor .{from} byl importován jako upravitelná kopie .{to}. Při ukládání vyberte nový soubor; originál zůstane beze změny. Rozvržení nebo animace se mohou změnit a makra se nezachovají.',
  missing:
    'Pro import souborů Office nebo OpenDocument nainstalujte LibreOffice, nebo nastavte NAWA_LIBREOFFICE_PATH na jeho spustitelný soubor a restartujte Nawa.',
  tooLarge: 'Import souborů Office je omezen na 64 MiB.',
  failed: 'Soubor se nepodařilo převést. Může být poškozený, chráněný heslem nebo nepodporovaný.',
  encrypted:
    'Soubory chráněné heslem nelze importovat. Nejprve uložte nešifrovanou kopii v původní aplikaci.',
} satisfies Record<keyof typeof zh, string>
