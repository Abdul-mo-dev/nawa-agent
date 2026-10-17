import { zh } from './zh'

export const nl = {
  modernCopy:
    'Bewerkingen worden opgeslagen in deze nieuwe .{to}-kopie. Het oorspronkelijke .{from}-bestand blijft ongewijzigd.',
  workbookCopy:
    'Bewerkingen worden opgeslagen in deze nieuwe .xlsx-kopie. Het oorspronkelijke .{from}-bestand blijft ongewijzigd.',
  workbookImport:
    'Celwaarden en ondersteunde formules worden geïmporteerd. Opmaak, grafieken, afbeeldingen, macro’s en benoemde bereiken worden weggelaten. Formules behouden als gecachte waarden: {formulas}. Bladen met onleesbare formules: {sheets}.',
  chatCopy:
    'Bewerkingen worden opgeslagen in dit nieuwe .{to}-bestand. Het oorspronkelijke .{from}-bestand blijft ongewijzigd. Conversie kan de indeling of animaties veranderen; macro’s worden niet behouden.',
  notice:
    '.{from} geïmporteerd als bewerkbare .{to}-kopie. Kies bij het opslaan een nieuw bestand; het origineel blijft ongewijzigd. Lay-out of animaties kunnen veranderen en macro’s worden niet behouden.',
  missing:
    'Installeer LibreOffice om Office- of OpenDocument-bestanden te importeren, of stel NAWA_LIBREOFFICE_PATH in op het uitvoerbare bestand en herstart Nawa.',
  tooLarge: 'Office-imports zijn beperkt tot 64 MiB.',
  failed:
    'Het bestand kon niet worden geconverteerd. Het is mogelijk beschadigd, met een wachtwoord beveiligd of niet ondersteund.',
  encrypted:
    'Bestanden met wachtwoordbeveiliging kunnen niet worden geïmporteerd. Sla eerst een onversleutelde kopie op in de oorspronkelijke app.',
} satisfies Record<keyof typeof zh, string>
