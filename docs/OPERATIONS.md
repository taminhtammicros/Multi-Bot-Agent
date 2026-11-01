# Vận hành và phục hồi

## Trạng thái hiện tại

Bản đầu phục vụ triển khai cục bộ và kiểm chứng luồng nghiệp vụ. Không có cam kết RTO/RPO thảm họa. PostgreSQL Compose là một node; mất máy hoặc volume vẫn làm gián đoạn toàn hệ thống.

Không mở trực tiếp dashboard ra Internet. Khi cần truy cập từ xa, bổ sung TLS, proxy xác thực, chính sách host và quản lý secrets; cookie Secure được xác định từ giao thức mà Fastify nhận. Chưa cấu hình trust proxy, nên phải thiết kế phần này trước khi public.

## Khi Hermes dừng

1. Mở Main & BCP, xem agent đang làm Main và trạng thái health.
2. Nếu OpenClaw hoạt động, lượt mới chuyển sang OpenClaw sau khi đủ ngưỡng lỗi và lượt trước kết thúc/lỗi.
3. Công việc `review` không tự chạy lại. Kiểm tra tác động trên agent/đích thực thi, xử lý nhiệm vụ con trước nhiệm vụ cha.
4. Nếu đã có kết quả nhưng tin gửi bị gián đoạn, kiểm tra Zalo trước khi bấm gửi lại trong outbox.
5. Khi Hermes hoạt động ổn định lại, hệ thống tự đưa Hermes về Main giữa hai lượt (chế độ auto).

Đổi Main không hủy công việc đã gửi đi. Agent có thể tiếp tục chạy sau khi HTTP timeout; cần đối soát bên agent.

## Khi tiến trình bot dừng

Chạy lại `npm start` trong thư mục dự án. Khóa database ngăn hai bản chạy cùng lúc. Các lượt đang chạy trước lúc dừng được đưa vào đối soát. Phiên Zalo được thử khôi phục; nếu không dùng được, quét QR mới trên dashboard.

Chưa cài launchd/systemd vào máy của anh. Để chạy lâu dài, triển khai service restart theo hệ điều hành sau khi nghiệm thu kết nối thật.

## Thử phục hồi backup vào database mới

Không restore đè database đang chạy. Ví dụ tạo database kiểm thử mới:

```sh
docker compose exec -T db createdb -U hub zalo_hub_restore_test
```

Chọn file dump cụ thể trong `backups/`, sau đó:

```sh
docker compose exec -T db pg_restore -U hub -d zalo_hub_restore_test --exit-on-error --no-owner --no-privileges < backups/TEN_FILE.dump
```

Kiểm tra bảng, số lượng tin, khả năng đọc cấu hình mã hóa với khóa đúng. Không khởi động worker thứ hai từ bản sao dữ liệu thật khi bridge chính vẫn chạy: khóa PostgreSQL chỉ có tác dụng trong cùng database, không ngăn hai database khác nhau đăng nhập cùng Zalo.

Để chuyển production: dừng và cách ly dịch vụ cũ trước, cấu hình DATABASE_URL mới, phục hồi khóa/session an toàn rồi khởi động một dịch vụ. Kiểm tra outbox và công việc cần đối soát trước khi cho nhận việc.

## Checklist diễn tập production còn phải làm

- Tắt Hermes trước khi giao việc: Main chuyển OpenClaw, ngữ cảnh đúng.
- Tắt Hermes sau khi đã thực hiện một hành động: không tự lặp tác động.
- Tắt bridge trong lúc gửi tin: outbox yêu cầu đối soát.
- Tắt máy chính: bản dự phòng chỉ khởi động sau khi máy cũ bị fencing.
- Mất PostgreSQL: không thực thi việc mới khi chưa ghi trạng thái; xác minh tin nhận có bị mất không.
- Khôi phục backup + khóa trên máy khác; đo RTO/RPO thực tế.
- Kiểm chứng Zalo có phát lại tin trong khoảng bridge offline hay không.

## Nâng cấp schema

Schema hiện chạy idempotent khi khởi động. Khi bắt đầu có dữ liệu production và nhiều phiên bản ứng dụng, chuyển sang migration đánh số, có kiểm tra phiên bản và kế hoạch rollback; backup trước mọi nâng cấp.

## Khi người dùng DM nhưng bot không trả lời

1. Mở Kết nối → **Quản lý quyền chat**. Xem UID thực tế ở danh sách người đã nhắn bot; không mặc định UID từ nguồn khác là giống nhau.
2. Lọc **Chưa cấp quyền**, đối chiếu đúng người rồi bấm **Cho phép DM**. Nhờ người dùng gửi tin text mới; không phát lại tin cũ bị chặn.
3. Xem **Chẩn đoán nhận tin Zalo** để biết đã nhận/chặn/xếp hàng và UID người gửi gần nhất. Bộ đếm này tính từ lúc tiến trình khởi động; bảng người dùng DM được lưu bền vững trong database.
4. Nếu đã xếp hàng, kiểm tra Công việc → trạng thái agent → outbox. Kết quả `sent` nghĩa là API gửi Zalo đã thành công, không đồng nghĩa người nhận đã đọc.
5. Thu hồi quyền bằng nút trong danh sách. Phản hồi còn chờ bị hủy trước khi gửi; tác vụ agent đang chạy không tự bị hủy.

## Bot Owner

Trong **Kết nối → Phân quyền**, các UID ở ô **UID Bot Owner / người dùng được phép** vừa được cấp quyền DM, vừa được xác thực là Bot Owner khi chính người đó nhắn bot trong DM hoặc nhóm đã bật. Đối chiếu đúng UID Zalo; quyền Owner không được suy ra từ tên hiển thị, câu tự nhận trong nội dung chat hay lời nhắn của người khác. Xóa UID khỏi danh sách để thu hồi cả quyền DM lẫn vai trò Owner.

Yêu cầu rõ ràng của Owner được thực hiện ngay, không chờ mã xác nhận. Nếu thiếu người nhận, đối tượng, nội dung hoặc phạm vi, bot hỏi phần thiết yếu còn thiếu trước khi làm. Agent chỉ nhận đúng yêu cầu của Owner; kết quả không rõ hoặc tiến trình bị dừng chuyển sang `review`, không tự chạy lại.

Lệnh gửi tin chữ rõ ràng theo mẫu `nhắn tin vào nhóm <group_id> nội dung: <text>` được Hub gửi trực tiếp qua bridge Zalo, không phụ thuộc Hermes/OpenClaw có công cụ gửi hay `conversationRef`. Hub xác minh tài khoản, nhóm đã được quan sát và quyền nhóm còn bật. Trạng thái gửi lưu riêng; `sent` nghĩa là Zalo API đã nhận lệnh gửi, còn gián đoạn chuyển sang `review` và không tự gửi lại.

Owner vẫn phải được phép nhắn theo chính sách DM/nhóm. Owner không vượt qua quyền công cụ, guard hoặc giới hạn an toàn. Nhận diện Owner bằng UID có tính xác thực; yêu cầu viết tự nhiên chưa đủ rõ sẽ được chuyển cho agent hỏi bổ sung thay vì tự suy đoán.

## Telegram cảnh báo

Trong **Kết nối**, tạo bot riêng bằng `@BotFather`, nhập token và lưu. Hub xác thực bằng `getMe`, lưu token đã mã hóa trong PostgreSQL rồi polling Telegram `getUpdates`. Bấm **Nối tài khoản nhận**, mở link riêng và gửi `/start` trong chat riêng với bot; mã nối chỉ dùng một lần và hết hạn sau 10 phút. **Gửi tin thử** kiểm tra đường gửi. Bot báo khi trạng thái Zalo hoặc Agent chuyển giữa online/offline. Gỡ kết nối sẽ xóa token, link người nhận và mã chờ.

Bot cảnh báo này chưa nhận câu hỏi để chuyển cho Hermes/OpenClaw; nó chỉ dùng để nhận cảnh báo hệ thống.

## Khi trả lời chậm hoặc có lượt AI trả rỗng

- **Kết nối API online không xác nhận model tạo được câu trả lời.** Xem thời gian lượt AI và lỗi gần nhất trên trang Kết nối/Tổng quan. Health check không xóa lỗi lượt AI; chỉ lượt AI thành công mới xóa lỗi này.
- Nhà cung cấp trả 403: kiểm tra đúng model/API key/gói được cấp quyền. Trả 429: kiểm tra quota và giới hạn lượt gọi. Không chuyển sang model tính phí hoặc sửa router chung khi chưa xác định model muốn dùng.
- Hàng đợi cho phép hai hội thoại song song, một lượt đang chạy mỗi hội thoại. Lượt `review` không tự phát lại và không chặn câu hỏi mới; hành động chưa rõ kết quả vẫn phải được đối soát trước khi yêu cầu lặp lại.
- Outbox gửi độc lập mỗi 500 ms; lỗi model có thông báo loại `notice`, độc lập với kết quả loại `answer`. Thông báo vẫn chịu quyền nhóm/DM, tài khoản và chế độ trả lời hiện hành. Có thông báo lỗi không ngăn quản trị viên đối soát rồi chạy lại tác vụ.
- Lỗi gọi model có bộ đếm riêng, không bị kiểm tra `/models` xóa. Khi đủ ngưỡng lỗi, agent vào cooldown 30 giây. Nếu chỉ có Hermes được cấu hình thì không có OpenClaw để chuyển sang; tin mới tiếp tục chờ khi không có Main.
- Với alias trên custom provider thiếu metadata, Hermes có thể mất nhiều giây dò context window mỗi lượt. Có thể đặt **giới hạn ngữ cảnh vận hành** theo alias bằng script dưới đây. Giá trị phải phù hợp model thật và khối lượng ngữ cảnh; 65.536 là cap vận hành, không phải khẳng định thông số của nhà cung cấp. Script giữ nguyên model và credentials, ghi backup riêng tư vào `data/hermes-config-backups`, rồi cập nhật `model_overrides.custom.<alias>.context_window`. Không sửa mã nguồn Hermes. Cấu hình được nạp lại theo thay đổi file.

```sh
~/.hermes/hermes-agent/venv/bin/python scripts/hermes-context-cap.py --model TEN_ALIAS --context-window 65536
```

Khôi phục bằng cách đối chiếu bản backup và gỡ/đổi đúng trường override đã thêm; tránh ghi đè các thay đổi cấu hình khác diễn ra sau thời điểm backup.

### Tăng tốc lượt Hermes tổng hợp kết quả OpenClaw

Lượt giao việc mặc định dùng dịch vụ Hermes tổng hợp riêng ở `127.0.0.1:8643`. Dịch vụ này dùng cùng model/provider đã cấu hình cho Hermes chính nhưng không nạp kênh chat, lịch sử hay công cụ; nó chỉ nhận kết quả OpenClaw và soạn câu trả lời cuối. Vì vậy Hermes không chạy lại tìm kiếm/terminal để xác minh cùng một việc. Mức chất lượng và hướng dẫn riêng của DM/nhóm vẫn được gửi cho OpenClaw và lượt tổng hợp.

Trong **Kết nối → Quyền trò chuyện với bot → Cấu hình riêng → Não & Chất lượng**, chọn **Kiểm chứng lại** nếu muốn Hermes chính dùng công cụ để tự xác minh sau OpenClaw. Lựa chọn này chậm hơn. Nếu dịch vụ nhanh không khỏe hoặc báo có công cụ, Hub giữ kết quả OpenClaw để đối soát thay vì lặp lại nghiên cứu. Lỗi quota/provider vẫn có thể làm chậm cả hai agent.

Đo với cùng bằng chứng OpenClaw: lượt tổng hợp Hermes cũ mất 108,9 giây (8 lần gọi API, 8 lần dùng công cụ); dịch vụ mới mất 12,0–24,5 giây qua 3 mẫu, trung vị 23,1 giây. Cả 3 mẫu giữ đủ 12 giá trị tiền tệ và các liên kết nguồn đã có. Đây là thời gian **pha tổng hợp**, không phải cam kết thời gian toàn lượt; thời gian OpenClaw tra cứu và tình trạng nhà cung cấp vẫn thay đổi.

Tạo/cập nhật dịch vụ bằng `npm run hermes:summary:setup`. Script đặt profile riêng dưới `data/hermes-summary` và LaunchAgent `com.zalo-agent-hub.hermes-summary`; profile Hermes chính không bị sửa. Chạy lại sau khi đổi provider, endpoint hoặc thông tin xác thực của Hermes chính. Dashboard chỉ ghi bản lưu thông tin kết nối đã mã hóa, không hiển thị key. Có thể quay lại quy trình cũ cho từng hội thoại bằng **Kiểm chứng lại**. Nếu LaunchAgent dừng, chế độ nhanh sẽ báo dịch vụ chưa sẵn sàng và giữ kết quả worker để đối soát.

## Khi Zalo mất kết nối

- Mở Kết nối → **Duy trì kết nối Zalo**, xem mã ngắt và lịch thử lại. HTTP dashboard trả 200 không có nghĩa WebSocket Zalo còn kết nối.
- Với 1006/lỗi mạng, supervisor tự dùng lại phiên đã lưu với backoff. Không cần quét QR cho mỗi lần gián đoạn mạng.
- Với 3000, đóng Zalo Web/bridge đang dùng cùng tài khoản rồi bấm Kết nối lại. Hệ thống không tự giành lại phiên liên tục.
- Với 3003 hoặc phiên bị thu hồi, chọn Quản lý đăng nhập → đăng nhập lại bằng QR.
- Nếu kết nối treo, watchdog loại bỏ lượt cũ và lên lịch mới; không khởi động thêm một bản bot trên database khác để thử, vì có thể gây trùng phiên.
- Chức năng Ngắt kết nối là đăng xuất chủ động: xóa phiên đã lưu và dừng tự phục hồi. Dừng dịch vụ giữ file phiên để lần khởi động sau phục hồi.

## Khi bot được thêm vào nhóm nhưng nhóm chưa hiện trong bảng

1. Vào Kết nối → Quản lý quyền chat → lọc Nhóm, bấm Đồng bộ nhóm.
2. Nhóm mới cũng được ghi nhận từ sự kiện nhóm hoặc tin nhắn, kể cả khi quyền phản hồi chưa được cấp. Việc ghi nhận chỉ giữ metadata.
3. Đối chiếu tên và ID, bấm Cho phép nhóm nếu muốn bot trả lời. Kiểm tra thêm công tắc phản hồi nhóm; hai điều kiện phải cùng bật.
4. Gửi tin text mới trong nhóm. Kiểm tra Công việc và outbox; không nhập group ID vào danh sách UID người dùng DM.

## Chọn chế độ trả lời cho từng DM/nhóm

Trong Quyền trò chuyện với bot, dùng cột Chế độ trả lời. Tag mới trả lời cần mention đúng UID bot do Zalo cung cấp; Im lặng chặn mọi phản hồi; Hóng chuyện xử lý mọi tin text được hỗ trợ. Chọn chế độ được lưu ngay, không cần khởi động lại.

Nhóm còn chịu công tắc toàn cục. Nếu chọn Tag nhưng bot không trả lời, kiểm tra tag thật trong ứng dụng Zalo, không chỉ gõ tên; DM thường không có metadata mention. Khi đổi chế độ, việc chưa chạy và phản hồi chưa gửi được kiểm tra lại. Tin/hành động đã gửi/thực hiện không thể thu hồi bằng đổi chế độ.
