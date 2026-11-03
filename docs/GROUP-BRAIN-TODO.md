# Tiến độ bộ nhớ riêng từng nhóm

Đã triển khai ngày 02/11/2026 trên Hub hiện tại. Chi tiết vận hành và giới hạn: [GROUP-BRAIN.md](GROUP-BRAIN.md).

- [x] Rà soát tiếp nhận, context, tri thức, agent và luồng gửi.
- [x] Kho dữ liệu có RLS, FORCE RLS, role không bypass và khóa ngoại cùng phạm vi; khóa gồm tài khoản + nhóm.
- [x] Tách ghi nhận khỏi phản hồi, giữ metadata, reply và bằng chứng gốc.
- [x] Lọc nhiễu bảo thủ, không bỏ quyết định ngắn; có sửa phân loại trên giao diện.
- [x] Topic nhiều-nhiều, nối topic cũ theo reply/độ liên quan, sửa tên/đóng/gộp/tách.
- [x] Worker tổng hợp định kỳ theo nhóm, overview, phiên bản, nguồn, retry, lease và ghi nhận mâu thuẫn.
- [x] Tổng hợp lại từ raw theo yêu cầu và định kỳ 7 ngày; không tự xóa tin gốc.
- [x] Context theo câu hỏi trong nhóm, gồm tin gần đây chưa tổng hợp, fact, nguồn và tìm kiếm full text trên raw cũ.
- [x] Model nhóm stateless không công cụ/session/memory agent dùng chung; không fallback agent chung.
- [x] API và giao diện kiểm tra/sửa topic, fact, nguồn và tiến độ; fact AI không tự thành xác nhận quản trị.
- [x] Kiểm thử RLS, nguồn chéo nhóm/tài khoản, model, lease/retry, thu hồi quyền, topic và hồi quy.
- [x] Kiểm tra model thật với hội thoại giả lập: 2 topic, 7 fact có nguồn và overview; không gửi tin Zalo.
- [x] Kiểm tra giao diện desktop/mobile, escape nguồn, thao tác xác nhận và cấu hình chu kỳ.
- [x] Backup database trước nâng cấp, migration và nhập 93 tin có nguồn xác định; 24 tin thiếu phạm vi vẫn giữ ở transcript cũ và không dùng làm trí nhớ mới.
- [x] Khởi động lại một phiên Hub; Zalo kết nối lại; kiểm tra API trí nhớ của 2 nhóm đang được cấp quyền.
- [x] Hai nhóm hoàn tất lô tổng hợp đầu: 12 topic, 34 fact có nguồn; không có lỗi. Backlog tiếp tục được xử lý theo lô nền.
- [x] Tài liệu triển khai, giới hạn, backup và phục hồi.

Kiểm tra: TypeScript; 35 unit test TS; 37 integration hồi quy; 8 integration bộ nhớ nhóm; 4 kiểm thử guard Python; browser và model smoke. Test DB tách riêng dữ liệu thật.

## Ranh giới và hướng mở rộng

Cô lập nhóm áp dụng trong đường xử lý của ứng dụng. Quản trị viên máy chủ/database vẫn có quyền vận hành/sao lưu; model provider hiện cấu hình vẫn nhận dữ liệu cần suy luận, không phải mã hóa đầu cuối. Nhóm không còn dùng công cụ/lệnh hoặc giao việc qua agent chung. DM giữ luồng agent hiện tại.

- [ ] Đánh giá thêm chất lượng phân topic/tổng hợp trên lịch sử thực tế và hiệu chỉnh bằng phản hồi quản trị.
- [ ] Embedding/pgvector nếu tìm kiếm từ khóa chưa đủ; hiện dùng full text và model phân loại topic.
- [ ] OCR/ASR, đính kèm và sự kiện sửa/thu hồi tin Zalo.
- [ ] Chính sách retention/xóa theo yêu cầu và phân quyền thành viên trực tiếp nếu mở dashboard ngoài quản trị máy chủ.
- [ ] Khóa thủ công việc gán topic sau gộp/tách nếu thực tế cho thấy AI cần bị ràng buộc mạnh hơn.
