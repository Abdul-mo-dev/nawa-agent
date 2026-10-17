import { en } from './en'

export const ja = {
  modernCopy:
    '編集結果はこの新しい .{to} コピーに保存されます。元の .{from} ファイルは変更されません。',
  workbookCopy:
    '編集結果はこの新しい .xlsx コピーに保存されます。元の .{from} ファイルは変更されません。',
  workbookImport:
    'セルの値と対応する数式を読み込みます。書式、グラフ、画像、マクロ、名前付き範囲は保持されません。キャッシュ値として保持された数式：{formulas}。数式を読み取れないシート：{sheets}。',
  chatCopy:
    '編集結果はこの新しい .{to} ファイルに保存されます。元の .{from} ファイルは変更されません。変換によりレイアウトやアニメーションが変わる場合があり、マクロは保持されません。',
  notice:
    '.{from} を編集可能な .{to} のコピーとして読み込みました。保存時に新しいファイルを選び、元のファイルは変更されません。レイアウトやアニメーションが変わる場合があり、マクロは保持されません。',
  missing:
    'Office または OpenDocument ファイルを読み込むには LibreOffice をインストールするか、NAWA_LIBREOFFICE_PATH に実行ファイルを指定して Nawa を再起動してください。',
  tooLarge: 'Office ファイルの読み込み上限は 64 MiB です。',
  failed:
    'ファイルを変換できませんでした。破損、パスワード保護、または未対応の形式の可能性があります。',
  encrypted:
    'パスワード保護されたファイルは読み込めません。元のアプリで暗号化されていないコピーを保存してください。',
} satisfies Record<keyof typeof en, string>
