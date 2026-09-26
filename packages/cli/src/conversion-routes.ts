import type { AppExportTarget } from './formats/app-export';
/** Conversions that run in this process. */
export const NODE_ROUTES: Record<string, readonly string[]> = {
    pdf: ['docx', 'pptx', 'xlsx'],
    csv: ['xlsx'],
    xls: ['xlsx'],
    xlsb: ['xlsx'],
    ods: ['xlsx'],
    md: ['docx', 'html'],
    markdown: ['docx', 'html'],
    docx: ['md'],
    xlsx: ['csv'],
    xlsm: ['csv'],
};
/**
 * Conversions the GenOffice binary runs for us in its hidden headless-export
 * mode: anything that needs an app renderer (page layout for pdf, the Word
 * editor's HTML export, html2docx). Mirrors HEADLESS_TARGETS in the shell.
 */
export const APP_ROUTES: Record<string, readonly AppExportTarget[]> = {
    csv: ['pdf'],
    xls: ['pdf'],
    md: ['pdf'],
    markdown: ['pdf'],
    docx: ['pdf', 'html'],
    xlsx: ['pdf'],
    xlsm: ['pdf'],
    pptx: ['pdf'],
    html: ['pdf', 'docx'],
    htm: ['pdf', 'docx'],
};
export const ROUTES: Record<string, readonly string[]> = Object.fromEntries([...new Set([...Object.keys(NODE_ROUTES), ...Object.keys(APP_ROUTES)])].map((from) => [
    from,
    [...(NODE_ROUTES[from] ?? []), ...(APP_ROUTES[from] ?? [])],
]));
export function conversionSupported(from: string, to: string): boolean {
    return ROUTES[from.replace(/^\./, '').toLowerCase()]?.includes(to.replace(/^\./, '').toLowerCase()) ?? false;
}
