# Kết nối OpenClaw local

Máy có CLI OpenClaw tại `/usr/local/bin/openclaw` (bản kiểm tra 2026.9.5) và container `openclaw_bot` dùng bản 2026.5.2. Tại thời điểm kiểm tra container chỉ chạy SSH; port Docker 18789 đã được publish nhưng không có gateway AI phục vụ HTTP.

Hub dùng một gateway native riêng tại **http://127.0.0.1:18791/v1**, agent target `openclaw/default`. Profile nằm trong `data/openclaw`, không bật lại kênh Zalo/Telegram hoặc plugin từ cấu hình OpenClaw gốc. Lịch sử và cấu hình từng hội thoại vẫn do Hub cung cấp qua API.

```sh
npm run openclaw:connect
```

Script lấy provider/model mặc định có sẵn trong `~/.openclaw/openclaw.json`, tạo profile riêng, bật Chat Completions, xác thực bằng token riêng và chỉ bind loopback. Không thay model hoặc sửa cấu hình OpenClaw gốc. Nếu khóa 9Router cũ bị từ chối 401/403, script kiểm tra khóa 9Router local hiện có trong cấu hình Hermes và chỉ dùng khóa đã xác thực cho cùng endpoint localhost:20128; không đổi credentials của dịch vụ gốc. Profile cũ được backup riêng tư trước khi sửa khóa.

Gateway chạy bằng LaunchAgent `com.zalo-agent-hub.openclaw`, tự khởi động khi đăng nhập macOS và khởi động lại khi lỗi. File service: `~/Library/LaunchAgents/com.zalo-agent-hub.openclaw.plist`. Config, state, workspace, backup và log nằm trong `data/openclaw` và không đưa vào Git. Token được Hub lưu mã hóa; API không trả token cho trình duyệt. Chạy lại script giữ profile đã tạo, kiểm tra readiness rồi cập nhật kết nối Dashboard. Nếu phải đổi khóa, script chờ PID gateway mới và readiness, tránh kết nối nhầm tiến trình đang dừng.

```sh
launchctl print gui/$(id -u)/com.zalo-agent-hub.openclaw
# Dừng gateway riêng khi cần:
launchctl bootout gui/$(id -u)/com.zalo-agent-hub.openclaw
```

Muốn gỡ tự khởi động, dừng job rồi xóa đúng file plist trên. Không xóa profile/state nếu muốn giữ cấu hình. Không dùng `--force` trên port 18789: Docker hiện đang giữ port này.

## Điều phối và giới hạn

- Hub tự chọn agent đang được bật và online làm Main. Nếu Hermes đang tắt, OpenClaw làm Main. Trong chế độ auto, khi bật lại Hermes và đủ thời gian ổn định, Hermes trở lại Main, OpenClaw là backup/delegate. Không tự bật lại Hermes khi người dùng đã tắt.
- Hai agent hiện dùng alias AntiGravity qua cùng 9Router. Có thể tiếp quản lỗi tiến trình agent, nhưng lỗi quota/quyền truy cập của model/provider dùng chung có thể ảnh hưởng cả hai. Muốn dự phòng cả tầng provider cần chọn provider/model độc lập.
- Hội thoại có chính sách giới hạn lệnh vẫn yêu cầu guard backend tương ứng. OpenClaw hiện chưa có guard per-chat của Hub; các lượt đó bị chặn để tránh bỏ qua quyền, kể cả khi là Main/backup.
- `/v1/models` online chỉ xác nhận gateway/auth hoạt động; cần kiểm tra câu trả lời thật để xác nhận provider/model. Không gửi thông báo thử đến Zalo; có thể probe trực tiếp adapter bằng nội dung kiểm tra không dùng công cụ.

## Worker đồng bộ và tìm kiếm web

Khi nhận việc từ Hermes, OpenClaw phải trả kết quả trong cùng lượt HTTP. Không dùng subagent chạy nền rồi `sessions_yield`: Chat Completions có thể trả placeholder `No response from OpenClaw.` trước khi có completion event. Hub coi placeholder/`NO_REPLY` là chưa có kết quả xác thực, giữ để đối soát và trả trạng thái lỗi về Hermes, không tự gọi lại tác vụ.

Gateway riêng chặn `sessions_spawn`, `sessions_send`, `sessions_yield`, `subagents`, tắt agent-to-agent nội bộ; Hub quản lý việc Hermes giao OpenClaw. Web search dùng plugin Parallel Free, không cần API key tìm kiếm. Chỉ plugin `parallel` được allowlist, không bật các plugin/kênh Zalo từ profile gốc.

```sh
OPENCLAW_CONFIG_PATH="$PWD/data/openclaw/openclaw.json" OPENCLAW_STATE_DIR="$PWD/data/openclaw/state" openclaw plugins install @openclaw/parallel-plugin@2026.9.5 --pin --accept-capabilities
npm run openclaw:worker
```

Version plugin trên tương thích CLI OpenClaw 2026.9.5 đã cài; kiểm tra tương thích khi nâng cấp. Công cụ tìm kiếm miễn phí vẫn có thể bị giới hạn hoặc gián đoạn; không bịa dữ kiện khi không có nguồn.

Nếu tin nhắn yêu cầu **chi tiết giao việc**, Hub thêm nhật ký xác nhận nội dung giao, trạng thái OpenClaw trả về, thời gian và mã công việc con. Trong Dashboard → Công việc → Chi tiết, xem nhánh **Hermes → OpenClaw → Hermes** để đọc yêu cầu, kết quả/lỗi và các lượt thực thi. Lỗi hoặc kết quả chưa hoàn tất từ worker không được ghi thành công chỉ vì HTTP trả 200.

Với lệnh chỉ định rõ **giao việc cho OpenClaw**, Hub tạo công việc con trực tiếp theo chỉ định, bỏ bước yêu cầu LLM hứa giao việc; OpenClaw xử lý rồi trả cho Hermes tổng hợp. Nhật ký ghi đúng actor Hub, không giả một lượt gọi Hermes trước đó. Nếu OpenClaw chưa sẵn sàng hoặc không đáp ứng chính sách, báo chưa giao thay vì tạo lời hứa chạy nền. Khi Hermes tự chọn giao việc, vẫn dùng lệnh JSON điều phối và tạo công việc con qua Hub. Nếu Hermes lỗi lúc tổng hợp, kết quả OpenClaw đã nhận được vẫn được giữ trong phản hồi, kèm trạng thái cần đối soát; không làm lại công việc đã hoàn tất.
