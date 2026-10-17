import { zh } from './zh'

export const de = {
  modernCopy:
    'Änderungen werden in dieser neuen .{to}-Kopie gespeichert. Das .{from}-Original bleibt unverändert.',
  workbookCopy:
    'Änderungen werden in dieser neuen .xlsx-Kopie gespeichert. Das .{from}-Original bleibt unverändert.',
  workbookImport:
    'Zellwerte und unterstützte Formeln werden importiert. Formatierungen, Diagramme, Bilder, Makros und benannte Bereiche werden ausgelassen. Als zwischengespeicherte Werte übernommene Formeln: {formulas}. Blätter mit unlesbaren Formeln: {sheets}.',
  chatCopy:
    'Änderungen werden in dieser neuen .{to}-Datei gespeichert. Das .{from}-Original bleibt unverändert. Die Konvertierung kann Layout oder Animationen verändern; Makros werden nicht übernommen.',
  notice:
    '.{from} als bearbeitbare .{to}-Kopie importiert. Wählen Sie beim Speichern eine neue Datei; das Original bleibt unverändert. Layout oder Animationen können sich ändern, Makros werden nicht übernommen.',
  missing:
    'Installieren Sie LibreOffice zum Importieren von Office- oder OpenDocument-Dateien, oder setzen Sie NAWA_LIBREOFFICE_PATH auf die Programmdatei und starten Sie Nawa neu.',
  tooLarge: 'Office-Importe sind auf 64 MiB begrenzt.',
  failed:
    'Die Datei konnte nicht konvertiert werden. Sie ist möglicherweise beschädigt, kennwortgeschützt oder wird nicht unterstützt.',
  encrypted:
    'Kennwortgeschützte Dateien können nicht importiert werden. Speichern Sie zuerst eine unverschlüsselte Kopie in der ursprünglichen Anwendung.',
} satisfies Record<keyof typeof zh, string>
