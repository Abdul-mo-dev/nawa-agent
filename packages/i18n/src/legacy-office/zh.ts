export const zh = {
  modernCopy: '编辑结果将保存到这个新的 .{to} 副本中。原始 .{from} 文件保持不变。',
  workbookCopy: '编辑结果将保存到这个新的 .xlsx 副本中。原始 .{from} 文件保持不变。',
  workbookImport:
    '导入单元格值和支持的公式。格式、图表、图像、宏和命名区域不予保留。以缓存值保留的公式：{formulas}。公式无法读取的工作表：{sheets}。',
  chatCopy:
    '编辑结果将保存到这个新的 .{to} 文件中。原始 .{from} 文件保持不变。转换可能改变布局或动画，且不保留宏。',
  notice:
    '已将 .{from} 导入为可编辑的 .{to} 副本。保存时选择新文件，原文件保持不变。布局或动画可能变化，宏不会保留。',
  missing:
    '请安装 LibreOffice 以导入 Office 或 OpenDocument 文件，或将 NAWA_LIBREOFFICE_PATH 设置为其可执行文件路径并重启 Nawa。',
  tooLarge: 'Office 导入文件大小上限为 64 MiB。',
  failed: '无法转换文件。文件可能已损坏、受密码保护或不受支持。',
  encrypted: '无法导入受密码保护的文件。请先在原应用中保存未加密的副本。',
} as const
