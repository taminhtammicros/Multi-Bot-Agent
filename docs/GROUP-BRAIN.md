# Trí nhớ riêng từng nhóm Zalo

## Phạm vi và ranh giới tin cậy

Khóa nhóm là `zalo:<account_id>:group:<group_id>`. Cùng người dùng, cùng tên nhóm hoặc cùng ID nhóm trên hai tài khoản không tạo quyền chia sẻ nội dung. Nhóm không có API tìm nhóm khác.

Kho `group_*` có RLS, FORCE RLS và khóa ngoại ghép `scope`. Mỗi giao dịch truy cập nội dung hạ xuống role `zhub_group_scope` (NOLOGIN, NOSUPERUSER, NOBYPASSRLS), đặt phạm vi bằng `set_config(...,true)` và tự reset sau commit/rollback. Role này không có quyền đọc settings/credentials hoặc các bảng Hub. Lịch trình chỉ đọc danh sách ID phạm vi; đọc nội dung luôn qua lớp `inGroup`.

Đây là cô lập truy cập trong ứng dụng, không phải mã hóa đầu cuối hay ngăn quản trị viên máy chủ/DB đọc backup. Tài khoản DB vận hành/migration hiện có quyền cao. Model trực tiếp vẫn nhận phần dữ liệu nhóm cần xử lý qua nhà cung cấp đang cấu hình; `store:false` không phải cam kết chính sách lưu trữ của nhà cung cấp. Không ghi nội dung prompt hoặc lỗi provider vào event log.

Hội thoại nhóm không gửi sang Hermes/OpenClaw có công cụ/bộ nhớ dùng chung. Inference gọi trực tiếp endpoint provider hiện có, mỗi request độc lập, không session, tool, agent memory hoặc tự fallback. Chỉ Hub cung cấp dữ liệu trong nhóm. Lỗi model được báo an toàn; không chạy lại hành động. Vì vậy nhóm không dùng lệnh hệ thống, tra web qua công cụ hoặc giao việc agent; các chức năng agent của DM vẫn giữ nguyên. Model không được coi là ranh giới quyền truy cập: dữ liệu nhóm khác không có trong request.

## Tiếp nhận và lọc

- Chỉ các nhóm trong allowlist khi `groupsEnabled=true` được ghi nhận.
- Mặc định cấu hình `groupMemoryEnabled=true`: nhóm chế độ Tag ghi nhận cả tin không tag; chỉ tạo task trả lời khi tag. Chế độ Hóng chuyện vẫn trả lời mọi tin text theo cấu hình cũ.
- Im lặng/thu hồi quyền dừng tiếp nhận; tắt groupMemoryEnabled dừng lắng nghe nền/tổng hợp, vẫn giữ tương tác được gửi trực tiếp tới bot và dữ liệu cũ. Pause routing dừng inference/worker, không xóa lịch sử.
- Raw giữ ID ngoài, người gửi, thời gian nguồn/tiếp nhận, reply, đoạn trích reply và loại nội dung. ID reply số không an toàn không được coi là ID chính xác.
- Không tự xóa raw. Tin xã giao/icon được đánh dấu nhiễu; lời chốt, phủ định, thay đổi và reply phải giữ. Quản trị có thể sửa bộ lọc; fact có nguồn bị đánh dấu nhiễu chuyển sang cần xác minh.
- Đính kèm chưa đọc được lưu thành dấu chỉ rõ thiếu nội dung; không suy đoán đã đọc ảnh, audio hoặc file. Tin do chính tài khoản bot gửi ngoài Hub hiện không được thu nhận.

## Topic, bộ nhớ và tổng hợp

`group_record_topics` là quan hệ nhiều-nhiều. Worker chọn tối đa 100 topic ứng viên trong đúng nhóm theo liên kết reply và độ liên quan từ khóa, rồi model quyết định nối topic hoặc tạo topic. Topic cũ có thể được mở lại. Quản trị có thể sửa tên, đóng, gộp hoặc tách tin sang topic khác; việc tổ chức lại làm mất hiệu lực bản tổng hợp hiện tại và yêu cầu đọc lại nguồn.

Worker xử lý tối đa 25 record/lô, có giới hạn payload, lease 3 phút, timeout inference 90 giây và retry tăng dần tối đa khoảng 1 giờ. Mốc tiến độ nằm trên từng record, không chỉ một watermark thời gian, nên tin đến trễ không bị bỏ qua. Tiến độ chỉ commit khi đầu ra được kiểm tra đầy đủ, nguồn cùng nhóm, trích dẫn khớp nguyên văn, lease còn hiệu lực và nhóm còn quyền. Chỉnh sửa topic trong lúc model chạy làm lượt tổng hợp rollback để thử lại.

Chu kỳ mặc định 15 phút, cấu hình 5–1440 phút. Nếu còn backlog, xử lý lô tiếp sau 1 phút; tick lịch trình mỗi 15 giây. Worker chỉ chạy cho tài khoản Zalo hiện đang kết nối. Cứ 7 ngày bắt đầu đọc lại raw để hạn chế sai lệch tích lũy từ tóm tắt; cũng có nút Tổng hợp lại từ nguồn.

Fact gồm decision/task/deadline/constraint/question/insight. Mỗi fact có nguồn raw; assistant không được dùng làm bằng chứng độc lập. Fact AI tạo có trạng thái proposed hoặc disputed; chỉ thao tác quản trị xác nhận mới chuyển confirmed. Bản xác nhận không bị AI tự thay thế. Khi quản trị chọn thay bản cũ, `valid_to`, `supersedes` và lịch sử được giữ.

Summary topic và overview nhóm là dữ liệu AI dẫn xuất, không phải chuỗi suy luận nội bộ hay xác nhận của nhóm. Overview phản ánh các topic/lô được cung cấp, không bảo đảm bao phủ toàn bộ lịch sử của nhóm lớn. Các revision giữ lại để đối chiếu.

## Truy xuất và kiểm tra

Context gồm câu hỏi hiện tại, tối đa 60 record gần nhất, topic liên quan, fact còn hiệu lực, nguồn gốc và tìm kiếm văn bản trên raw cũ. Có giới hạn ký tự từng phần; câu hỏi hiện tại không bị cắt. Tìm kiếm hiện dùng PostgreSQL full text và từ khóa, chưa có embedding/pgvector; cách diễn đạt hoàn toàn khác có thể cần người dùng nêu rõ topic. Các câu trả lời không dùng bảng memories chung/legacy.

Dashboard: Zalo & Telegram → Cấu hình của nhóm → Trí nhớ & Topic. Xem số tin chờ, lần tổng hợp, lỗi an toàn, overview, topic, fact và nguồn. Có thể xác nhận/bác bỏ/thay fact, sửa/gộp/tách topic, sửa nhiễu và yêu cầu tổng hợp lại. Dashboard là giao diện quản trị máy chủ, có quyền quản lý nhiều nhóm; thành viên nhóm không được cấp cookie/token quản trị.

## Cài đặt và nâng cấp

1. `npm run db:backup` trước migration.
2. `npm run check`, `npm test`.
3. Test DB riêng: `DATABASE_URL=postgres://.../zalo_brain_test npm run test:brain:integration`. Không chạy vào DB thật. Hồi quy cũ dùng DB `/zalo_hub_test` và `npm run test:integration`.
4. `npm run brain:setup`: lấy custom provider đã cấu hình trong Hermes, lưu key mã hóa trong settings. Không sửa Hermes chính, không in key. Hỗ trợ endpoint OpenAI-compatible Chat Completions; từ chối các cổng gateway agent đã biết. Chỉ người vận hành đáng tin cậy được thay endpoint.
5. Chạy migration khi khởi động. Role migration cần CREATE ROLE/GRANT (compose hiện dùng tài khoản PostgreSQL quản trị). Lỗi quyền sẽ dừng khởi động thay vì bỏ qua RLS.
6. `npm run brain:import`: nhập các tin user cũ có account ID, group ID và sender ID xác định ở từng tin; idempotent. Không nhập assistant/bộ nhớ cũ chưa chứng minh được nguồn. Tin không rõ phạm vi vẫn giữ ở transcript quản trị cũ, không được đưa vào context nhóm mới.
7. Khởi động một phiên Hub. `recover()` giữ queued task/outbox của nhóm có ID cũ ở trạng thái review; không tự phát lại vào nhóm.

Rollback vận hành: tạm pause routing, dừng một phiên Hub, phục hồi code phù hợp và DB backup khi cần. Không tự hạ schema hoặc gửi lại outbox review. Không đưa kho mới sang agent có công cụ để làm fallback. Backup PostgreSQL chứa toàn bộ raw và tri thức nhóm, phải được bảo vệ như dữ liệu gốc.

## Giới hạn cần đánh giá tiếp

Phân loại topic/tóm tắt phụ thuộc chất lượng model; kiểm tra nguồn và trạng thái giúp đối soát nhưng không chứng minh mọi diễn giải đều đúng. Bộ ứng viên topic và ngân sách context có giới hạn. Gộp/tách là hỗ trợ chỉnh tổ chức, chưa khóa cứng mọi gán topic sau này của AI. Chưa nhận lịch sử Zalo chưa từng tới listener, chưa xử lý thu hồi/sửa tin Zalo thành lịch sử sự kiện, chưa có OCR/ASR, embedding hoặc phân quyền thành viên trực tiếp trong dashboard. Các mục này không được báo là đã hỗ trợ.
