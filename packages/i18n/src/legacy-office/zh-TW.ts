import { zh } from './zh'

export const zhTW = {
  modernCopy: '編輯結果將儲存到這個新的 .{to} 副本中。原始 .{from} 檔案保持不變。',
  workbookCopy: '編輯結果將儲存到這個新的 .xlsx 副本中。原始 .{from} 檔案保持不變。',
  workbookImport:
    '匯入儲存格值和支援的公式。不保留格式、圖表、影像、巨集和命名範圍。以快取值保留的公式：{formulas}。公式無法讀取的工作表：{sheets}。',
  chatCopy:
    '編輯結果將儲存到這個新的 .{to} 檔案中。原始 .{from} 檔案保持不變。轉換可能改變版面配置或動畫，且不保留巨集。',
  notice:
    '已將 .{from} 匯入為可編輯的 .{to} 副本。儲存時選擇新檔案，原檔案保持不變。版面或動畫可能變更，巨集不會保留。',
  missing:
    '請安裝 LibreOffice 以匯入 Office 或 OpenDocument 檔案，或將 NAWA_LIBREOFFICE_PATH 設為其執行檔路徑並重新啟動 Nawa。',
  tooLarge: 'Office 匯入檔案大小上限為 64 MiB。',
  failed: '無法轉換檔案。檔案可能已損毀、受密碼保護或不受支援。',
  encrypted: '無法匯入受密碼保護的檔案。請先在原應用程式中儲存未加密的副本。',
} satisfies Record<keyof typeof zh, string>
