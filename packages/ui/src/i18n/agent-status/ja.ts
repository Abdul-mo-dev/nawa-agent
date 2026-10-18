import type { en } from './en'
export const ja = {
  historyOpening: '会話履歴を開いています…',
  historyEmpty: '会話が読み込まれていません。',
  stopped: '停止しました。',
  stoppedPartial: '停止しました。途中の応答はこの会話に保存されています。',
  interrupted: '応答が完了する前に停止しました。',
  noReply: '応答がありませんでした。',
  outputLimit: 'モデルの出力上限に達しました。この回答は未完了です。',
  turnLimit: 'ツールの実行回数上限に達しました。この回答は未完了です。',
  requestFailed: 'AI リクエストに失敗しました。',
  requestTimeout: 'AI リクエストがタイムアウトしました。',
  noCredits: 'AI プロバイダーのクレジット残高がありません。',
  networkError: 'AI プロバイダーに接続できませんでした。',
  overloadedError: 'AI プロバイダーが一時的に混雑しています。',
} satisfies Record<keyof typeof en, string>
