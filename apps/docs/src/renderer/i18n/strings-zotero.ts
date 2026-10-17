import { defineStrings } from '@genoffice/i18n'

/** Strings for the Zotero integration in the References tab. */
export const zoteroStrings = defineStrings({
  en: {
    zoteroCitation: 'Zotero Citation',
    zoteroCitationTip: 'Add a citation with Zotero; place the cursor in a citation to edit it',
    zoteroBibliography: 'Zotero Bibliography',
    zoteroBibliographyTip: 'Add or edit the bibliography with Zotero',
    zoteroRefresh: 'Refresh',
    zoteroRefreshTip: 'Refresh all Zotero citations and bibliographies',
    zoteroDocumentSettings: 'Document Settings',
    zoteroDocumentSettingsTip: 'Zotero document settings',
    zoteroDocumentPreferences: 'Document Preferences',
    zoteroRemoveCodes: 'Remove Field Codes',
    zoteroConnectionError: 'Unable to connect to Zotero. Start Zotero and keep it running.',
    zoteroOperationError: 'The Zotero operation failed.',
    zoteroNoteFieldsUnsupported:
      'This document has Zotero citations in footnotes or endnotes, which Nawa cannot update yet. Zotero commands are turned off here so the bibliography stays intact.',
    zoteroGroup: 'Zotero',
  },
  ja: {
    zoteroCitation: 'Zotero 引用',
    zoteroCitationTip: 'Zotero で引用を追加します。既存の引用内にカーソルを置くと編集できます',
    zoteroBibliography: 'Zotero 文献目録',
    zoteroBibliographyTip: 'Zotero で文献目録を追加または編集します',
    zoteroRefresh: '更新',
    zoteroRefreshTip: 'すべての Zotero 引用と文献目録を更新します',
    zoteroDocumentSettings: '文書設定',
    zoteroDocumentSettingsTip: 'Zotero 文書設定',
    zoteroDocumentPreferences: '文書の環境設定',
    zoteroRemoveCodes: 'フィールドコードを削除',
    zoteroConnectionError: 'Zotero に接続できません。Zotero を起動したままにしてください。',
    zoteroOperationError: 'Zotero の操作に失敗しました。',
    zoteroNoteFieldsUnsupported:
      'この文書の脚注または文末脚注に Zotero の引用が含まれていますが、Nawa はまだ更新できません。参考文献一覧を保つため、この文書では Zotero コマンドを無効にしています。',
    zoteroGroup: 'Zotero',
  },
  ar: {
    zoteroCitation: 'اقتباس Zotero',
    zoteroCitationTip: 'أضف اقتباسًا باستخدام Zotero؛ ضع المؤشر داخل اقتباس لتعديله',
    zoteroBibliography: 'مراجع Zotero',
    zoteroBibliographyTip: 'أضف قائمة المراجع أو عدّلها باستخدام Zotero',
    zoteroRefresh: 'تحديث',
    zoteroRefreshTip: 'تحديث جميع اقتباسات ومراجع Zotero',
    zoteroDocumentSettings: 'إعدادات المستند',
    zoteroDocumentSettingsTip: 'إعدادات مستند Zotero',
    zoteroDocumentPreferences: 'تفضيلات المستند',
    zoteroRemoveCodes: 'إزالة رموز الحقول',
    zoteroConnectionError: 'تعذر الاتصال بـ Zotero. شغّل Zotero واتركه مفتوحًا.',
    zoteroOperationError: 'فشلت عملية Zotero.',
    zoteroNoteFieldsUnsupported:
      'يحتوي هذا المستند على استشهادات Zotero في الحواشي السفلية أو الختامية، ولا يستطيع Nawa تحديثها بعد. تم تعطيل أوامر Zotero هنا للحفاظ على قائمة المراجع سليمة.',
    zoteroGroup: 'Zotero',
  },
})
