import type { en } from './en'

export const ja = {
  'Text indexed with limitations': 'テキストを索引登録済み（制限あり）',
  'Extracted text was embedded. Some content, layout or visual information may be unavailable. See the details below.':
    '抽出したテキストは埋め込み済みです。一部の内容、レイアウト、視覚情報が含まれない場合があります。以下の詳細を確認してください。',
  'Image text indexed (OCR)': '画像内のテキストを索引登録済み（OCR）',
  'Image text was recognized locally by OCR. Layout and visual meaning are not embedded; verify exact wording against the original image.':
    '画像内のテキストをローカルでOCR認識し、索引登録しました。レイアウトや画像の視覚的な意味は埋め込みに含まれません。正確な表記は元の画像で確認してください。',
} satisfies Record<keyof typeof en, string>
