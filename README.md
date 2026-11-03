# Zalo Agent Hub

Dashboard tiếng Việt để quản lý một tài khoản Zalo, Hermes và OpenClaw. Giao diện tối tham khảo bố cục SMART-BOT; mã ứng dụng được xây riêng trong workspace này. Không sao chép session, API key hoặc dữ liệu từ dự án tham khảo.

## Chạy trên máy hiện tại

Yêu cầu: Node.js >=22, Docker Compose. Các cổng riêng của dự án: dashboard `3890`, PostgreSQL `55439`.

```sh
npm ci
cp .env.example .env
npm run db:up
npm start
```

Mở **http://127.0.0.1:3890**. Đọc mã đăng nhập trong file `data/admin-token` trên máy; mã được tạo ở lần chạy đầu và không in ra log. Có thể xem bằng trình soạn thảo. Dashboard chỉ bind loopback mặc định.

Trong **Kết nối**:

1. Cấu hình Hermes hoặc OpenClaw: API base URL kết thúc bằng `/v1`, agent target/model, Bearer token, bật kết nối, lưu và kiểm tra.
2. Nếu chỉ bật một agent, agent đó làm Main. Nếu cả hai khả dụng, mặc định ưu tiên Hermes.
3. Thử hội thoại trong **Hội thoại → Chat thử mới** trước khi bật Zalo.
4. Bấm **Kết nối Zalo**, tạo QR, quét và xác nhận trên điện thoại.
5. Bấm **Quản lý quyền chat** hoặc **Phân quyền** trên thẻ Zalo. Danh sách hiện tên hiển thị, UID thực tế, lần nhắn gần nhất và quyền hiện tại. Người mới nhắn bot một lần sẽ xuất hiện ở bộ lọc **Chưa cấp quyền**; bấm **Cho phép DM**, rồi nhờ họ gửi tin mới. Có thể tìm tên/UID, sao chép UID, thêm UID thủ công và thu hồi quyền. **Cài đặt nhóm & UID** giữ phần cấu hình nhóm nâng cao. Danh sách trống từ chối tất cả. Nhóm mặc định tắt; khi bật, bot xử lý mọi tin text trong nhóm được cho phép (chưa có mention-only).

Không chạy plugin Zalo khác hay Zalo Web cùng tài khoản với bridge này. Tích hợp tài khoản cá nhân dùng API không chính thức và có rủi ro bị hạn chế tài khoản.

### API agent

- Hermes: bật API Server ở bản cài của anh, đặt `API_SERVER_ENABLED=true`, `API_SERVER_KEY`, chạy gateway. Mặc định `http://127.0.0.1:8642/v1`, target `hermes-agent`.
- OpenClaw: bật endpoint Chat Completions và xác thực gateway. Mặc định `http://127.0.0.1:18789/v1`, target `openclaw`; có thể chọn target agent theo cấu hình bản cài.
- Kiểm tra kết nối dùng `GET /v1/models`; thao tác này không chứng minh toàn bộ tools đã hoạt động. Chat thử là bước nghiệm thu API thực tế.
- Adapter dùng `POST /v1/chat/completions`, không truyền định danh phiên cố định; gửi lịch sử từ PostgreSQL vào mỗi lượt. Phải kiểm chứng bản cài thực tế không tự ghép bộ nhớ/phiên ngoài ý muốn.
- Hermes yêu cầu giao OpenClaw bằng JSON `{"action":"delegate_openclaw","task":"..."}`. Dịch vụ lưu nhiệm vụ con, gọi OpenClaw, rồi trả kết quả để Hermes tổng hợp. Một cấp giao việc, không vòng lặp.
- Chỉ cấu hình endpoint tin cậy: agent có thể có quyền công cụ trên máy đang chạy nó. Ứng dụng không cài, sửa hay khởi động lại agent hiện có.

Tài liệu nguồn:
- https://github.com/RFS-ADRENO/zca-js
- https://docs.openclaw.ai/gateway/openai-http-api
- https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server

## Duy trì kết nối Zalo

Dịch vụ có bộ giám sát riêng (`src/zalo-recovery.ts`), không phụ thuộc số lần retry hữu hạn của SDK. SDK vẫn thực hiện heartbeat giao thức Zalo; ứng dụng không gửi tin nhắn giả để giữ kết nối.

- Sau ngắt WebSocket (ví dụ mã 1006), đăng nhập lại bằng cookie/IMEI đã lưu; không tự tạo QR mới và không xóa lịch sử/allowlist.
- Thời gian chờ tăng dần từ khoảng 2 giây tới tối đa 60 giây, có jitter; chỉ đặt một lịch retry. Kết nối ổn định 60 giây mới đặt lại số lần thử.
- Watchdog 30 giây cho đăng nhập/handshake; các request HTTP của phiên phục hồi có timeout 20 giây và có thể bị hủy. Kết quả từ lượt cũ bị loại bỏ, không tạo listener thứ hai.
- Tắt retry của SDK để tránh hai bộ retry cạnh tranh nhau. Kiểm tra update SDK không nằm trong đường đăng nhập; cập nhật thư viện qua dependency đã khóa của dự án.
- Mã 3000: dừng tự thử để tránh giành phiên với Zalo Web/bridge khác. Đóng phiên khác rồi bấm **Kết nối lại**.
- Mã 3003: phiên bị đá, cần đăng nhập QR. Phiên hết hạn hoặc bị thu hồi có thể cần QR; việc thử lại không vượt qua được yêu cầu đăng nhập của Zalo.
- Đăng xuất chủ động hoặc dừng dịch vụ hủy lịch phục hồi. Phiên cập nhật được ghi file mã hóa bằng thao tác thay thế nguyên tử để tránh file bị ghi dở.
- Dashboard có mục **Duy trì kết nối Zalo**: trạng thái, lần kết nối/ngắt gần nhất, mã đóng, số lần thử, lần thử tiếp theo và nút kết nối lại. Chỉ số tính theo tiến trình hiện tại; sự kiện được ghi vào nhật ký database.

Không bảo đảm tin trong khoảng mất kết nối sẽ được Zalo phát lại; ứng dụng không tự thực hiện lại tin cũ để tránh lặp tác vụ.

## Quản lý quyền DM và nhóm trực quan

- UID luôn được giữ dưới dạng chuỗi, không chuyển sang số JavaScript; tránh sai các UID 19 chữ số.
- Bảng `zalo_contacts` giữ metadata người gửi theo tài khoản bot: tên, UID, thời điểm và số lượt nhận. Không lưu nội dung DM bị từ chối vào lịch sử hội thoại, không chuyển sang agent.
- Tên hiển thị do người gửi cung cấp, không phải bằng chứng xác thực danh tính. Đối chiếu đúng UID trước khi cấp quyền.
- Cấp/thu hồi quyền cập nhật allowlist hiện có bằng transaction và khóa hàng; giữ nguyên cấu hình nhóm. Áp dụng ngay, không cần restart.
- Thêm quyền không phát lại tin đã bị chặn: người dùng gửi tin mới để bắt đầu.
- Thu hồi chặn tin mới và hủy phản hồi còn chờ gửi. Không hủy tác vụ agent đã bắt đầu, không thu hồi tin đã gửi thành công.
- Metadata được lưu qua các lần khởi động lại. Người chưa nhắn bot có thể thêm bằng UID thủ công; chưa có đồng bộ toàn bộ danh bạ Zalo.
- API quản trị: `GET /api/zalo/contacts`, `PUT /api/zalo/contacts/:uid/access` với `{accountId,allowed}`. Yêu cầu đăng nhập và từ chối thao tác nếu tài khoản bot đã thay đổi.
- Bộ kiểm thử giao diện riêng: `npm run test:contacts-browser` (cần ứng dụng đang chạy và Playwright/CHROME_PATH). Các thao tác cấp/thu hồi trong bài kiểm thử được giả lập, không đổi allowlist thật.

### Nhóm Zalo

Danh sách **Quyền trò chuyện với bot** có bộ lọc **Người dùng / Nhóm / DM & Nhóm** và trạng thái được phép/chưa cấp quyền. Đây là danh sách điểm nhận/gửi đã được ghi nhận hoặc thêm ID; lịch sử tin nhắn nằm ở mục Hội thoại.

- `zalo_groups` lưu ID, tên, số thành viên và lượt nhận theo tài khoản bot. Không dùng tên người gửi làm tên nhóm.
- Nhóm được phát hiện qua tin nhóm, sự kiện nhóm (bao gồm thêm bot) và đồng bộ membership khi kết nối. Nút **Đồng bộ nhóm** gọi `getAllGroups`/`getGroupInfo`, chỉ lấy metadata, không đọc lịch sử hay cấp quyền.
- Cấp quyền bằng **Cho phép nhóm**. Chỉ phản hồi khi nhóm nằm trong `allowGroups` **và** công tắc **Bật phản hồi trong các nhóm đã cấp quyền** được bật. Đồng bộ/thêm metadata không tự bật công tắc hoặc thêm allowlist.
- DM và nhóm dùng quyền riêng, kể cả khi chuỗi ID trùng nhau. API nhóm: `PUT /api/zalo/groups/:uid/access`, `PUT /api/zalo/groups-enabled`, `POST /api/zalo/groups/sync`; đều yêu cầu đăng nhập quản trị.
- Khi nhóm đã được cho phép, chế độ trên dòng quyết định xử lý mọi tin text hay chỉ tin tag bot. Tin đã bị chặn không được phát lại sau khi cấp quyền.
- Có thể thêm ID thủ công với loại **Nhóm**. Chưa có chức năng tự tham gia nhóm hay gửi lời chào khi bot được thêm vào.

### Ba chế độ trả lời trên từng dòng

Cột **Chế độ trả lời** áp dụng riêng cho từng DM/nhóm và lưu trong `zalo_reply_rules`:

| Chế độ | Hành vi |
|---|---|
| Tag mới trả lời | Chỉ xử lý tin có @mention đúng UID bot trong metadata Zalo. Gõ tên bot thường, tag người khác hoặc @all không kích hoạt. DM thông thường không có mention sẽ không được trả lời. |
| Im lặng | Không xếp việc cho agent và không gửi phản hồi. Vẫn ghi nhận metadata người gửi/nhóm để quản trị. |
| Hóng chuyện | Xử lý mọi tin text được hỗ trợ, trừ tin của chính bot để tránh vòng lặp. |

- Chọn Tag/Hóng sẽ cấp quyền tương ứng cho dòng đó; chọn Im lặng thu hồi quyền và giữ dòng trong danh sách để bật lại. Không thay đổi dòng khác hay công tắc nhóm toàn cục.
- Công tắc nhóm là điều kiện toàn cục: khi tắt, mọi nhóm đều không được phản hồi, bất kể chế độ trên dòng.
- Khi nâng cấp, các ID đang được cấp quyền giữ hành vi cũ (Hóng chuyện); các ID chưa được phép là Im lặng. Không tự chuyển nhóm đang chạy sang Tag.
- Chế độ được kiểm tra khi nhận tin, trước khi thực thi việc chờ và ngay trước khi gửi phản hồi. Đổi sang Im lặng hoặc Tag sẽ hủy các phản hồi chờ không phù hợp; không thu hồi tin đã gửi và không hủy hành động agent đã thực hiện.
- Metadata kích hoạt (`bot_mentioned`, `source_account_id`) đi cùng tin gốc để kiểm tra lại chính xác trước khi gửi. Tin bị lọc không tự chạy lại khi đổi chế độ.
- API: `PUT /api/zalo/reply-mode/:kind/:uid`, body `{accountId,mode}`; `kind` là `dm`/`group`, `mode` là `mention`/`silent`/`all`. Yêu cầu đăng nhập và đúng tài khoản bot hiện tại.
- Nút Cho phép/Thu hồi cũ vẫn là lối tắt sang Hóng chuyện/Im lặng. Trình sửa allowlist nâng cao giữ chế độ Tag của các ID không thay đổi quyền.

## Dữ liệu chung và cách xử lý

PostgreSQL giữ hội thoại, bộ nhớ theo hội thoại, nhiệm vụ cha/con, lượt chạy, inbox logic qua messages/tasks, outbox và nhật ký. Tin nhận và nhiệm vụ được ghi trong cùng transaction, chống trùng bằng external message ID. Mỗi lượt có idempotency key gửi agent, nhưng không dựa vào đó để khẳng định mọi phiên bản agent thực hiện đúng một lần.

Ngữ cảnh hiện tại gồm **60 tin gần nhất**, tối đa 30 mục bộ nhớ đã xác nhận và 10 kết quả công việc gần đây, luôn giới hạn theo hội thoại. Lịch sử đầy đủ vẫn nằm trong database. Chưa có tóm tắt tự động cho hội thoại rất dài; dùng **Bộ nhớ chung** để lưu các quyết định cần giữ lâu dài. Không tuyên bố hai agent suy luận giống hệt nhau.

Hàng đợi xử lý tối đa hai hội thoại song song, giữ một lượt đang chạy trong mỗi hội thoại và đúng thứ tự. Công việc `review` được giữ để đối soát và không tự chạy lại, nhưng không khóa câu hỏi mới. Ngữ cảnh nhắc agent không lặp hành động chưa rõ kết quả. Outbox gửi độc lập với các lượt AI chạy lâu; lỗi AI có thông báo riêng cho người dùng Zalo. Tác vụ không có Main khả dụng vẫn nằm trong hàng đợi. Nhấn tạm dừng chỉ chặn lượt mới, không hủy tác vụ đã gửi agent và không chặn outbox gửi kết quả.

## Failover và BCP hiện có

- Kiểm tra agent mỗi 10 giây; ngưỡng lỗi mặc định 3.
- Khi Main không khả dụng, chọn agent còn hoạt động cho lượt tiếp theo.
- Lỗi thực thi cũng được ghi nhận; đủ ngưỡng sẽ mở thời gian nghỉ 30 giây trước khi thử health lại.
- Hermes phải ổn định trong cửa sổ phục hồi (mặc định 60 giây) trước khi lấy lại Main trong chế độ tự động.
- Không đổi Main giữa lượt đang chạy. Timeout thực thi hiện 180 giây.
- Timeout/lỗi không rõ đã thực hiện chưa: `review`, không tự chuyển cùng tác vụ sang agent khác. Người quản trị đối soát rồi kết thúc hoặc cho chạy lại.
- Khởi động lại: công việc đang chạy và gửi tin đang dở được chuyển sang `review`; công việc chưa chạy giữ `queued`.
- Khóa advisory PostgreSQL cho phép một worker/bridge trên database. Mất kết nối giữ khóa làm tiến trình thoát để tránh chạy song song.
- Mã thế hệ Main kiểm tra trước khi ghi kết quả; đây chưa phải cơ chế fencing cho các hành động bên ngoài của agent.
- API key và session Zalo được mã hóa AES-256-GCM. Khóa nằm trong `data/encryption-key` hoặc biến môi trường. Cookie quản trị HttpOnly, SameSite Strict, phiên 12 giờ; đăng xuất/khởi động lại làm mất phiên trình duyệt.

### Sao lưu

Bấm **Main & BCP → Tạo backup**, hoặc:

```sh
npm run db:backup
```

Script dùng `pg_dump` trong dịch vụ Compose `db`, tạo dump định dạng custom vào `backups/` với quyền riêng. **Chỉ hỗ trợ database Compose cục bộ hiện tại**, không tự sao lưu DATABASE_URL bên ngoài. Backup chưa tự lên lịch và chưa sao chép ra máy khác.

Để phục hồi đầy đủ cần:

- Dump PostgreSQL.
- Khóa mã hóa đúng (`data/encryption-key` hoặc giá trị ENCRYPTION_KEY từ hệ thống quản lý secrets).
- Session Zalo mã hóa `data/zalo-session` nếu muốn thử phục hồi đăng nhập.
- Cấu hình môi trường và mã quản trị (hoặc đặt lại mã quản trị).

Lưu khóa tách khỏi dump. Không commit các mục này vào Git.

Quy trình phục hồi và phạm vi BCP: [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Kiểm tra

```sh
npm run check
npm test
```

Tạo database kiểm thử riêng, tuyệt đối không dùng database hội thoại thật:

```sh
docker compose exec -T db createdb -U hub zalo_hub_test
DATABASE_URL=postgres://hub:hub_local_dev@127.0.0.1:55439/zalo_hub_test npm run test:integration
```

Kiểm tra trình duyệt khi ứng dụng đang chạy:

```sh
npx playwright install chromium
npm run test:browser
```

Có thể đặt `CHROME_PATH` trỏ đến Chromium có sẵn. Screenshot lưu trong `test-results/`, không đưa vào Git. Kiểm thử tích hợp sử dụng API agent giả lập, không gửi tin Zalo hay thực hiện hành động bằng agent thật.

## Cấu trúc

Cấu hình tính cách, tri thức, model, chất lượng, màu/emoji, quyền lệnh và lời chào theo từng nhóm/DM: xem [hướng dẫn cấu hình hội thoại](docs/CHAT-PROFILES.md).

Kết nối OpenClaw đã cài trên máy bằng gateway riêng cho Hub: xem [hướng dẫn OpenClaw](docs/OPENCLAW.md), chạy `npm run openclaw:connect`.

- `src/server.ts`: dashboard API, đăng nhập, cấu hình, timer.
- `src/engine.ts`: hàng đợi, ngữ cảnh, giao việc, ghi kết quả.
- `src/agents.ts`: adapter API, health check, chọn Main.
- `src/zalo.ts`: QR, listener, quyền truy cập, outbox.
- `src/contacts.ts`: ghi nhận người gửi, danh sách DM và cấp/thu hồi quyền.
- `src/schema.sql`: schema và migration idempotent ban đầu.
- `public/`: dashboard responsive, không cần bước build.
- `tests/`: unit và integration trên database riêng.

TypeScript có mapping kiểu trực tiếp đến `zca-js/dist/index.d.ts` vì declaration gốc của zca-js dùng directory export không tương thích NodeNext. Runtime vẫn import package `zca-js` bình thường.

## Phần chưa hoàn thành để đạt BCP production

Database HA, máy dịch vụ dự phòng, fencing nhiều máy, nhật ký tin nhận khi database lỗi, backup ngoài máy/PITR, cảnh báo ngoài dashboard và diễn tập RTO/RPO chưa được triển khai. Chưa diễn tập end-to-end với hai agent thật. Media, phân quyền nhiều quản trị viên, tóm tắt tự động và các lệnh quản trị trong Zalo là giai đoạn tiếp theo. Hội thoại có giới hạn lệnh hiện chỉ được chạy trên Hermes local có guard; chưa thể chuyển các lượt đó sang OpenClaw.

### Trí nhớ riêng theo nhóm

Nhóm Zalo dùng kho `group_*` có RLS và model suy luận trực tiếp, không dùng session/bộ nhớ/công cụ agent chung. Bot có thể ghi nhận tin không tag trong nhóm được cho phép, lọc nhiễu, phân topic và tổng hợp định kỳ; quản trị xem/sửa tại **Cấu hình riêng → Trí nhớ & Topic**. DM giữ luồng Hermes/OpenClaw hiện tại. Chạy `npm run brain:setup` để cấu hình model từ custom provider đang có và `npm run brain:import` để nhập lịch sử xác định được nguồn. Xem [hướng dẫn và ranh giới bảo mật](docs/GROUP-BRAIN.md), [tiến độ triển khai](docs/GROUP-BRAIN-TODO.md).
