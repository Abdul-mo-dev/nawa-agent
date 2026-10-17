import { zh } from './zh'

export const es = {
  modernCopy:
    'Los cambios se guardarán en esta nueva copia .{to}. El original .{from} permanece sin cambios.',
  workbookCopy:
    'Los cambios se guardarán en esta nueva copia .xlsx. El original .{from} permanece sin cambios.',
  workbookImport:
    'Se importan los valores de las celdas y las fórmulas compatibles. Se omiten el formato, los gráficos, las imágenes, las macros y los rangos con nombre. Fórmulas conservadas como valores en caché: {formulas}. Hojas con fórmulas ilegibles: {sheets}.',
  chatCopy:
    'Los cambios se guardarán en este nuevo archivo .{to}. El original .{from} permanece sin cambios. La conversión puede alterar el diseño o las animaciones; las macros no se conservan.',
  notice:
    '.{from} importado como copia .{to} editable. Al guardar, elige un archivo nuevo; el original permanece intacto. El diseño o las animaciones pueden cambiar y las macros no se conservan.',
  missing:
    'Instala LibreOffice para importar archivos Office u OpenDocument, o configura NAWA_LIBREOFFICE_PATH con su ejecutable y reinicia Nawa.',
  tooLarge: 'Las importaciones de Office están limitadas a 64 MiB.',
  failed:
    'No se pudo convertir el archivo. Puede estar dañado, protegido con contraseña o no ser compatible.',
  encrypted:
    'No se pueden importar archivos protegidos con contraseña. Guarda primero una copia sin cifrar en la aplicación original.',
} satisfies Record<keyof typeof zh, string>
