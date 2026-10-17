import { zh } from './zh'

export const pt = {
  modernCopy:
    'As alterações serão salvas nesta nova cópia .{to}. O original .{from} permanece inalterado.',
  workbookCopy:
    'As alterações serão salvas nesta nova cópia .xlsx. O original .{from} permanece inalterado.',
  workbookImport:
    'Os valores das células e as fórmulas compatíveis são importados. Formatação, gráficos, imagens, macros e intervalos nomeados são omitidos. Fórmulas mantidas como valores em cache: {formulas}. Planilhas com fórmulas ilegíveis: {sheets}.',
  chatCopy:
    'As alterações serão salvas neste novo arquivo .{to}. O original .{from} permanece inalterado. A conversão pode alterar o layout ou as animações; as macros não são mantidas.',
  notice:
    '.{from} importado como cópia .{to} editável. Ao salvar, escolha um novo arquivo; o original permanece intacto. O layout ou as animações podem mudar, e as macros não são mantidas.',
  missing:
    'Instale o LibreOffice para importar arquivos Office ou OpenDocument, ou defina NAWA_LIBREOFFICE_PATH para o executável e reinicie o Nawa.',
  tooLarge: 'As importações do Office são limitadas a 64 MiB.',
  failed:
    'Não foi possível converter o arquivo. Ele pode estar danificado, protegido por senha ou não ser compatível.',
  encrypted:
    'Arquivos protegidos por senha não podem ser importados. Salve primeiro uma cópia não criptografada no aplicativo original.',
} satisfies Record<keyof typeof zh, string>
