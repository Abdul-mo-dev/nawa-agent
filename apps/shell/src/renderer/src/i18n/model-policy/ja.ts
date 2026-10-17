import { en } from './en'

export const ja = {
  'Run location': '実行場所',
  'Local server': 'ローカルサーバー',
  'Cloud API': 'クラウド API',
  'Context limit (tokens)': 'コンテキスト上限（トークン）',
  'Output limit (tokens)': '出力上限（トークン）',
  'API output parameter': 'API 出力パラメーター',
  Automatic: '自動',
  'Test image understanding': '画像理解をテスト',
  No: 'いいえ',
  Yes: 'はい',
  'Advanced model settings': 'モデルの詳細設定',
  'Tool calling verified.': 'ツール呼び出しを確認しました。',
  Local: 'ローカル',
  Cloud: 'クラウド',
  'Search unavailable for this format': 'この形式では検索できません',
  'Analysis unavailable for this format': 'この形式では分析できません',
  'Save a copy as XLSX to search, inspect or analyze it.':
    '検索・検査・分析には XLSX のコピーを保存してください。',
  'Extracted text is available; native inspection and editing are unavailable for this format.':
    '抽出テキストを利用できます。この形式ではネイティブ検査・編集は利用できません。',
  'Native analysis supports XLSX, XLSM, CSV, TSV and JSON tables.':
    'ネイティブ分析は XLSX、XLSM、CSV、TSV、JSON の表をサポートします。',
  'Codex output limits are advisory; large tool responses are rejected before execution.':
    'Codex の出力上限は目安です。大きすぎるツール応答は実行前に拒否されます。',
} satisfies Record<keyof typeof en, string>
