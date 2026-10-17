import { zh } from './zh'

export const vi = {
  modernCopy:
    'Các chỉnh sửa sẽ được lưu vào bản sao .{to} mới này. Tệp .{from} gốc không thay đổi.',
  workbookCopy:
    'Các chỉnh sửa sẽ được lưu vào bản sao .xlsx mới này. Tệp .{from} gốc không thay đổi.',
  workbookImport:
    'Giá trị ô và các công thức được hỗ trợ được nhập. Định dạng, biểu đồ, hình ảnh, macro và phạm vi có tên bị bỏ qua. Công thức được giữ dưới dạng giá trị lưu đệm: {formulas}. Trang tính có công thức không đọc được: {sheets}.',
  chatCopy:
    'Các chỉnh sửa sẽ được lưu vào tệp .{to} mới này. Tệp .{from} gốc không thay đổi. Việc chuyển đổi có thể thay đổi bố cục hoặc hoạt ảnh; macro không được giữ lại.',
  notice:
    'Đã nhập .{from} thành bản sao .{to} có thể chỉnh sửa. Chọn tệp mới khi lưu; tệp gốc không thay đổi. Bố cục hoặc hoạt ảnh có thể thay đổi và macro không được giữ lại.',
  missing:
    'Cài đặt LibreOffice để nhập tệp Office hoặc OpenDocument, hoặc đặt NAWA_LIBREOFFICE_PATH thành đường dẫn tệp thực thi rồi khởi động lại Nawa.',
  tooLarge: 'Tệp Office nhập vào bị giới hạn ở 64 MiB.',
  failed:
    'Không thể chuyển đổi tệp. Tệp có thể bị hỏng, được bảo vệ bằng mật khẩu hoặc không được hỗ trợ.',
  encrypted:
    'Không thể nhập tệp được bảo vệ bằng mật khẩu. Hãy lưu bản sao không mã hóa trong ứng dụng gốc trước.',
} satisfies Record<keyof typeof zh, string>
