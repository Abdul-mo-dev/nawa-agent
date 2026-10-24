import type { en } from './en'

export const ar = {
  'Text indexed with limitations': 'تمت فهرسة النص مع وجود قيود',
  'Extracted text was embedded. Some content, layout or visual information may be unavailable. See the details below.':
    'تم تضمين النص المستخرج. قد لا يتوفر بعض المحتوى أو التخطيط أو المعلومات البصرية. راجع التفاصيل أدناه.',
  'Image text indexed (OCR)': 'تمت فهرسة نص الصورة بالتعرف الضوئي',
  'Image text was recognized locally by OCR. Layout and visual meaning are not embedded; verify exact wording against the original image.':
    'تم التعرف على نص الصورة محلياً وفهرسته. لا يشمل التضمين التخطيط أو المعنى البصري؛ تحقّق من الصياغة الدقيقة بمقارنتها بالصورة الأصلية.',
} satisfies Record<keyof typeof en, string>
