# Cấu hình riêng cho nhóm và DM

Mở **Kết nối → Quyền trò chuyện với bot → Cấu hình riêng** trên đúng dòng nhóm/DM. Cấu hình lưu theo tài khoản Zalo + loại hội thoại + ID, độc lập với chế độ Tag mới trả lời / Im lặng / Hóng chuyện.

- **Tính cách:** tối đa 2.000 ký tự, nạp lại từ database cho mỗi lượt xử lý. Nhập cách xưng hô, vai trò, tư duy và phong cách ở đây.
- **Hội thoại → Trả lời lần lượt:** mặc định bật. Xử lý theo thứ tự nhận trong nhóm/DM, chờ gửi xong phản hồi trước rồi mới làm câu tiếp theo. Các hội thoại khác vẫn xử lý độc lập. Khi tắt, cho phép tối đa hai lượt đồng thời, kết quả có thể về khác thứ tự. Lượt lỗi không tự chạy lại hoặc khóa các câu hỏi mới; việc đổi chế độ không hủy lượt đang chạy.
- **Hội thoại → Tag / Reply:** chọn Tắt, Reply tin gốc, Tag người hỏi hoặc Tag + Reply. Trong DM dùng Reply; Tag native áp dụng cho nhóm. Đích trả lời lấy từ metadata tin nhận đã lưu trong database, không nhờ AI đoán người hỏi. Câu trả lời dài vẫn Reply cùng câu hỏi gốc qua từng phần, chỉ Tag một lần. Tin cũ thiếu ID Reply dùng Tag người hỏi nếu có metadata; không bịa ID hoặc gắn câu hỏi khác. Mặc định Tắt để giữ cách trình bày cũ, chọn chế độ rồi lưu để bật.
- **Tri thức & Skill:** tải TXT/MD/CSV/JSON/HTML/PDF/DOCX/YAML tối đa 8 MB, thêm URL công khai, chọn thư mục, ghi chú hoặc SKILL.md. Nguồn được đọc thành snapshot; bấm Làm mới khi tài liệu gốc thay đổi. Thư mục tối đa 100 file/20 MB; PDF scan chưa có OCR. File upload được sao chép vào `data/library`; gỡ nguồn không xóa file gốc. Nguồn lớn được lấy trích đoạn phù hợp, tối đa khoảng 20.000 ký tự mỗi lượt. Skill cung cấp hướng dẫn, không tự cài công cụ hoặc chạy script.
- **Não & Chất lượng:** chọn Theo Main & Backup, Hermes hoặc OpenClaw. Hermes hỗ trợ danh sách model và provider; OpenClaw nhập ID provider/model theo gateway. Model riêng áp dụng cho agent đã chọn; khi chuyển sang backup khác, dùng model mặc định của backup. Cấu hình tính cách/tri thức/chất lượng vẫn đi theo hội thoại. Ba mức chất lượng điều chỉnh hướng dẫn độ dài và reasoning effort của Hermes; mức hỗ trợ thực tế tùy model. Chỉ dẫn link khi có nguồn thật.
- **OpenClaw hỗ trợ Hermes:** bật mặc định theo từng DM/nhóm. Khi Hermes là Main và cả hai agent online, yêu cầu phân tích/đánh giá/so sánh, tra cứu thông tin mới và xử lý nội dung sẽ được Hermes phân tích trước rồi giao OpenClaw nhiệm vụ cụ thể; Hermes nhận kết quả để tổng hợp. Hub vẫn giao việc nếu Hermes lỡ trả lời trực tiếp thay vì tạo brief. Tắt lựa chọn này để Hermes tự xử lý. Nếu Hermes offline, OpenClaw vẫn tiếp quản theo chính sách Main & Backup.
- **Hermes tổng hợp sau OpenClaw:** mặc định Nhanh, dùng Hermes riêng không có công cụ để biên tập bằng chứng đã nhận, không tự tìm nguồn hoặc chạy lệnh lại. Cấu hình Dài vẫn giữ cho phần nghiên cứu của OpenClaw và độ dài trình bày. Chọn Kiểm chứng lại khi cần Hermes tự truy cập nguồn độc lập; cách này có thể chậm hơn. Nếu dịch vụ tổng hợp chưa sẵn sàng hoặc phát hiện bật công cụ, Hub giữ nguyên kết quả worker và báo cần đối soát, không tự tra cứu/lặp công việc.
- **Trình bày:** màu Zalo native Xanh/Đỏ/Vàng hoặc màu chữ mặc định. Emoji bật cho phép reaction 👍 khi nhận việc và emoji trong câu trả lời; tắt ngăn reaction mới và bỏ emoji khỏi câu trả lời mới.
- **Quyền & Lời chào:** bật/tắt lệnh hệ thống, nhập lệnh cấm mỗi dòng, và lời chào nhóm. `{members}` tạo tag Zalo thật, `{group}` chèn tên nhóm; nếu thiếu `{members}`, bot tự thêm tag phía trước. Để trống để tắt. Chỉ gửi khi phản hồi nhóm được bật, nhóm được cấp quyền và không Im lặng. Lời chào dài được chia tin, tránh cắt tên được tag; sự kiện trùng không gửi lặp. Lỗi gửi không rõ kết quả được giữ `review` trong `zalo_announcements` để đối soát, không tự gửi lại.

Bấm **Lưu cấu hình hội thoại** để lưu form. Các nút thêm/gỡ/làm mới nguồn lưu ngay. Thay đổi áp dụng từ lượt xử lý kế tiếp; chính sách công cụ được kiểm tra lại trước từng tool call, kể cả khi lượt đang chạy.

## Bộ chặn lệnh Hermes

```sh
npm run hermes:install-guard
# Chọn thời điểm gateway không có việc đang chạy:
hermes gateway restart
```

Installer cài plugin `zhub-policy` vào `~/.hermes/plugins`, không sửa mã nguồn Hermes và không cấp quyền ghi đè công cụ. Dashboard hiển thị guard hoạt động khi PID plugin trùng gateway đang nghe cổng 8642. Tích hợp hiện hỗ trợ Hermes local tại `http://127.0.0.1:8642/v1`.

Hook chỉ áp dụng phiên `zhub_` do Hub tạo. Mỗi lần gọi công cụ, hook lấy chính sách mới từ Hub bằng token riêng cho lượt; lỗi đọc hoặc token hết hạn sẽ chặn công cụ. Lịch sử chung được chuyển vào request kể cả khi dùng session riêng cho guard. Các phiên Hermes bên ngoài Hub không bị áp dụng chính sách này.

Tắt lệnh sẽ chặn terminal, chạy mã, ghi file và các công cụ không nằm trong danh sách chỉ đọc. Khi nhập lệnh cấm, chỉ cho phép một số lệnh đọc trực tiếp; shell chaining, interpreter và công cụ trung gian bị chặn để hạn chế lách danh sách. Đây là chính sách ở lớp công cụ, không phải sandbox hệ điều hành. Công cụ đã chạy trước lúc thay đổi quyền không tự bị hủy.

**OpenClaw/remote Hermes chưa có guard tương ứng.** Yêu cầu có chính sách hạn chế sẽ không được gửi sang backend chưa được bảo vệ, kể cả khi backup tiếp quản. Muốn vừa giới hạn lệnh vừa có BCP qua OpenClaw cần triển khai guard tương đương trên gateway đó. Mặc định quyền lệnh vẫn bật để giữ hành vi cũ; quản trị viên cần chọn chính sách cho từng hội thoại.

## Backup và kiểm thử

Database backup chứa cấu hình, nội dung tri thức đã trích xuất và hàng đợi lời chào. Cần backup riêng `data/library`, khóa/session và các thư mục nguồn/skill gốc để phục hồi đầy đủ khả năng Làm mới. Không công khai các thư mục này. Guard được cài lại bằng script sau khi chuyển máy.

```sh
npm run check
npm test
npm run test:hermes-guard
DATABASE_URL=postgres://hub:hub_local_dev@127.0.0.1:55439/zalo_hub_test npm run test:integration
npm run test:chat-profiles-browser
```

Browser test giả lập dữ liệu cấu hình để không thay đổi quyền hoặc gửi tin đến nhóm thật. Welcome, reaction và màu đã kiểm tra qua SDK giả lập; cần nghiệm thu hiển thị trên ứng dụng Zalo và sự kiện thêm thành viên thật ở nhóm thử nghiệm.
