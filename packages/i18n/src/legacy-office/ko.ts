import { zh } from './zh'

export const ko = {
  modernCopy: '편집 내용은 이 새 .{to} 사본에 저장됩니다. 원본 .{from} 파일은 변경되지 않습니다.',
  workbookCopy: '편집 내용은 이 새 .xlsx 사본에 저장됩니다. 원본 .{from} 파일은 변경되지 않습니다.',
  workbookImport:
    '셀 값과 지원되는 수식을 가져옵니다. 서식, 차트, 이미지, 매크로 및 이름이 지정된 범위는 유지되지 않습니다. 캐시된 값으로 유지된 수식: {formulas}. 수식을 읽을 수 없는 시트: {sheets}.',
  chatCopy:
    '편집 내용은 이 새 .{to} 파일에 저장됩니다. 원본 .{from} 파일은 변경되지 않습니다. 변환 시 레이아웃이나 애니메이션이 달라질 수 있으며 매크로는 유지되지 않습니다.',
  notice:
    '.{from} 파일을 편집 가능한 .{to} 사본으로 가져왔습니다. 저장할 때 새 파일을 선택하며 원본은 변경되지 않습니다. 레이아웃이나 애니메이션이 달라질 수 있고 매크로는 유지되지 않습니다.',
  missing:
    'Office 또는 OpenDocument 파일을 가져오려면 LibreOffice를 설치하거나 NAWA_LIBREOFFICE_PATH에 실행 파일을 지정한 후 Nawa를 다시 시작하세요.',
  tooLarge: 'Office 가져오기는 64 MiB로 제한됩니다.',
  failed:
    '파일을 변환할 수 없습니다. 손상되었거나 암호로 보호되었거나 지원되지 않는 형식일 수 있습니다.',
  encrypted:
    '암호로 보호된 파일은 가져올 수 없습니다. 원래 앱에서 암호화되지 않은 사본을 먼저 저장하세요.',
} satisfies Record<keyof typeof zh, string>
