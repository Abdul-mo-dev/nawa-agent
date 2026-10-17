import { zh } from './zh'

export const fr = {
  modernCopy:
    'Les modifications seront enregistrées dans cette nouvelle copie .{to}. L’original .{from} reste inchangé.',
  workbookCopy:
    'Les modifications seront enregistrées dans cette nouvelle copie .xlsx. L’original .{from} reste inchangé.',
  workbookImport:
    'Les valeurs des cellules et les formules prises en charge sont importées. La mise en forme, les graphiques, les images, les macros et les plages nommées sont omis. Formules conservées comme valeurs en cache : {formulas}. Feuilles aux formules illisibles : {sheets}.',
  chatCopy:
    'Les modifications seront enregistrées dans ce nouveau fichier .{to}. L’original .{from} reste inchangé. La conversion peut modifier la mise en page ou les animations ; les macros ne sont pas conservées.',
  notice:
    '.{from} importé comme copie .{to} modifiable. Choisissez un nouveau fichier lors de l’enregistrement ; l’original reste intact. La mise en page ou les animations peuvent changer, et les macros ne sont pas conservées.',
  missing:
    'Installez LibreOffice pour importer des fichiers Office ou OpenDocument, ou définissez NAWA_LIBREOFFICE_PATH sur son exécutable et redémarrez Nawa.',
  tooLarge: 'Les imports Office sont limités à 64 MiB.',
  failed:
    'Le fichier n’a pas pu être converti. Il est peut-être endommagé, protégé par un mot de passe ou non pris en charge.',
  encrypted:
    'Les fichiers protégés par mot de passe ne peuvent pas être importés. Enregistrez d’abord une copie non chiffrée dans l’application d’origine.',
} satisfies Record<keyof typeof zh, string>
