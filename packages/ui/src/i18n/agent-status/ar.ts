import type { en } from './en'
export const ar = {
  historyOpening: 'جارٍ فتح سجل المحادثة…',
  historyEmpty: 'لم يتم تحميل محادثة.',
  stopped: 'تم الإيقاف.',
  stoppedPartial: 'تم الإيقاف. تم حفظ الرد الجزئي في هذه المحادثة.',
  interrupted: 'تم الإيقاف قبل اكتمال الرد.',
  noReply: 'لم يتم إرجاع رد.',
  outputLimit: 'بلغ النموذج حد الإخراج. هذه الإجابة غير مكتملة.',
  turnLimit: 'بلغ المساعد حد استخدام الأدوات. هذه الإجابة غير مكتملة.',
  requestFailed: 'فشل طلب الذكاء الاصطناعي.',
  requestTimeout: 'انتهت مهلة طلب الذكاء الاصطناعي.',
  noCredits: 'لا يوجد رصيد متاح لدى مزود الذكاء الاصطناعي.',
  networkError: 'تعذر الاتصال بمزود الذكاء الاصطناعي.',
  overloadedError: 'مزود الذكاء الاصطناعي مشغول مؤقتًا.',
} satisfies Record<keyof typeof en, string>
