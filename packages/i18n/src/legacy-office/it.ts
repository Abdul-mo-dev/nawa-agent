import { zh } from './zh'

export const it = {
  modernCopy:
    'Le modifiche verranno salvate in questa nuova copia .{to}. L’originale .{from} resta invariato.',
  workbookCopy:
    'Le modifiche verranno salvate in questa nuova copia .xlsx. L’originale .{from} resta invariato.',
  workbookImport:
    'Vengono importati i valori delle celle e le formule supportate. Formattazione, grafici, immagini, macro e intervalli denominati vengono omessi. Formule conservate come valori memorizzati: {formulas}. Fogli con formule illeggibili: {sheets}.',
  chatCopy:
    'Le modifiche verranno salvate in questo nuovo file .{to}. L’originale .{from} resta invariato. La conversione può modificare il layout o le animazioni; le macro non vengono conservate.',
  notice:
    '.{from} importato come copia .{to} modificabile. Scegli un nuovo file al salvataggio; l’originale resta invariato. Layout o animazioni possono cambiare e le macro non vengono conservate.',
  missing:
    'Installa LibreOffice per importare file Office o OpenDocument, oppure imposta NAWA_LIBREOFFICE_PATH sul suo eseguibile e riavvia Nawa.',
  tooLarge: 'Le importazioni Office sono limitate a 64 MiB.',
  failed:
    'Impossibile convertire il file. Potrebbe essere danneggiato, protetto da password o non supportato.',
  encrypted:
    'Impossibile importare file protetti da password. Salva prima una copia non crittografata nell’app originale.',
} satisfies Record<keyof typeof zh, string>
