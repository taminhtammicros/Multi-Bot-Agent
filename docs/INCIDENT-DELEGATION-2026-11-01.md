# Đối soát giao việc trong CÁ HEO AI - BOT FORUM

Thời gian dưới đây là UTC+7, ngày 01/11/2026.

| Mốc | Bằng chứng trong hệ thống |
|---|---|
| 23:14:03 | Hub nhận tin yêu cầu tra giá xăng và giao OpenClaw. |
| 23:14:19 | Tạo công việc con OpenClaw `817e0b33` cho lượt cha `c720efba`. |
| 23:14:48 | Native OpenClaw gọi `sessions_spawn`. |
| 23:14:55 | Native OpenClaw gọi `sessions_yield`; HTTP trả `No response from OpenClaw.` với finish reason stop. Hub cũ ghi nhầm completed. |
| 23:15:10 | Hermes tổng hợp placeholder thành câu chưa lấy được giá và tạo phản hồi gửi nhóm. |
| 23:18:36 | Native OpenClaw mới có câu trả lời cuối trong transcript sau completion event. Không thuộc response HTTP mà Hub đã nhận trước đó. |

Subagent nội bộ gặp lỗi model/provider; `web_search` lúc đó chưa có provider hoạt động. Sau đó native parent tiếp tục fetch web rồi mới tạo kết quả cuối. Ảnh gửi lúc 23:15:10 không gây ra response rỗng lúc 23:14:55.

Lượt mới lúc 23:30 còn có phản hồi hứa chạy nền nhưng không tạo công việc OpenClaw trong Hub. Các lượt trên được giữ để đối soát thay vì coi là đã hoàn thành; không tự chạy lại hoặc gửi lại nhóm. Phản hồi cũ đã gửi được giữ nguyên làm bằng chứng lịch sử.

## Sửa và kiểm chứng

- Chặn placeholder/NO_REPLY ở adapter OpenClaw. Không coi HTTP 200 là đã có kết quả hợp lệ.
- Worker dùng prompt riêng, không kế thừa quyền điều phối của Main; chặn sessions_spawn/sessions_send/sessions_yield/subagents và agent-to-agent native trong gateway riêng.
- Cài plugin Parallel 2026.9.5 tương thích CLI, allowlist riêng và bật parallel-free. Đã gọi web_search thật trả hai URL Petrolimex. Không tự bật plugin/kênh từ cấu hình gốc.
- Yêu cầu chỉ định OpenClaw được Hub tạo công việc con trực tiếp, không cần một LLM hứa giao việc. Kết quả/trạng thái quay về Hermes tổng hợp. Nếu Hermes lỗi, giữ kết quả worker thay vì làm mất câu trả lời. Không tự giao lại tác vụ khi tổng hợp lỗi.
- Có nhật ký giao việc trong phản hồi khi được yêu cầu và trong Dashboard → Chi tiết công việc, gồm công việc con, nội dung, trạng thái, thời gian và lượt thực thi.
- TypeScript check, 29 unit test, 32 integration test và kiểm tra UI chi tiết giao việc đã qua. Có kiểm tra placeholder, không phát lại, worker không sẵn sàng, và giữ kết quả khi synthesis lỗi.
- Lần thử với default AntiGravity vẫn gặp lỗi provider ở cả hai agent; không coi là handoff thành công. Báo cáo riêng trong `test-results/delegation-live-probe.json`.
- Probe riêng theo từng request với NANO-FREE-COMBO đã nhận URL Petrolimex từ OpenClaw và xác nhận Hermes nhận lại đúng URL, tổng khoảng 24 giây. Không thay model mặc định hoặc cấu hình nhóm/DM; báo cáo `test-results/delegation-native-probe-override.json`.

Lỗi provider/quota của AntiGravity là vấn đề riêng còn tồn tại. Hai agent dùng chung router/model mặc định có thể cùng lỗi; việc sửa luồng không bảo đảm model luôn cung cấp được dữ liệu giá xăng hiện hành.

## Xác nhận lượt thật sau sửa

Lượt `7d25006d` trong nhóm, nhận lúc **23:53:40**, đã tạo công việc OpenClaw `68285761` ngay theo chỉ định người dùng. OpenClaw hoàn tất và trả kết quả lúc **23:55:35.893** (115,5 giây). Hermes nhận kết quả, kiểm chứng/tổng hợp và hoàn tất lúc **23:57:24.828** (108,9 giây). Parent và child đều `completed`; outbox của parent là **sent**, câu trả lời có nhật ký giao việc cùng mã công việc con. Xác nhận bằng database production, không phải probe giả lập và không đổi model mặc định.

Nhóm hiện chọn chất lượng `long`; lượt trên tổng cộng khoảng 3 phút 45 giây. Việc trả kết quả đã thông suốt, nhưng thời gian nghiên cứu/kiểm chứng của model vẫn có thể dài và lỗi provider vẫn có thể tái diễn.
