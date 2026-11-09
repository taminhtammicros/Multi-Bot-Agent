# Bridge Zalo, Telegram và Teams Personal trên Local Host

Dashboard và Bridge chạy trong ứng dụng local trên `http://127.0.0.1:3890`. PostgreSQL dùng chung trong local Hub để lưu phòng, thành viên, hàng đợi gửi và lịch sử giao nhận. Adapter Zalo, Telegram và Teams đưa tin vào cùng phòng; tin do chính bot gửi được nhận diện để tránh chuyển vòng.

## Khởi chạy

Trên máy đã cài Node.js 22+, PostgreSQL và dependencies của dự án:

```sh
npm install
DATABASE_URL=postgresql:///zalo_hub_local HOST=127.0.0.1 PORT=3890 npm run dev
```

Mở `http://127.0.0.1:3890/#channels` và đăng nhập bằng mã quản trị trong `data/admin-token`. `DATABASE_URL` cần trỏ tới database local mà Hub đang dùng; không tạo database mới nếu muốn giữ phiên Zalo và cấu hình đã có.

## Tạo phòng Zalo–Telegram

1. Kết nối tài khoản Zalo và Telegram trong trang **Kênh & Bridge**.
2. Thêm bot Telegram vào nhóm. Tắt Group Privacy trong BotFather hoặc cấp bot làm quản trị viên, rồi gửi `/bridge` trong nhóm để Hub nhận diện.
3. Cấp quyền cho nhóm Zalo trong danh sách DM & Nhóm.
4. Chọn hai nhóm, tạo Bridge ở trạng thái tạm dừng, kiểm tra đúng tên/ID rồi bấm **Bật**.

Bridge chuyển tin mới theo chiều đã chọn. Văn bản, link, ảnh và file Telegram/Zalo được chuyển qua hàng đợi lưu bền; nếu kênh đích không xác nhận được lượt gửi, trạng thái cần đối soát và Hub không tự gửi lặp.

## Thêm Teams Personal đang chạy trên Brave VPS

Local Hub điều khiển Brave trên VPS qua Chrome DevTools Protocol (CDP). Chỉ bind CDP trên loopback VPS và dùng SSH port forwarding; không mở cổng CDP ra Internet.

1. Bật Remote Debugging cho Brave trên VPS và giữ Brave đăng nhập Teams Personal.
2. Trên VPS, đọc cổng và đường dẫn CDP:

   ```sh
   cat ~/.config/BraveSoftware/Brave-Browser/DevToolsActivePort
   ```

   Dòng đầu là cổng, dòng thứ hai là đường dẫn WebSocket.
3. Trên máy chạy Local Hub, tạo tunnel thay `<CDP_PORT>` và `<VPS_HOST>` bằng giá trị thật:

   ```sh
   ssh -N -L 127.0.0.1:9222:127.0.0.1:<CDP_PORT> ubuntu@<VPS_HOST>
   ```

4. Đặt `TEAMS_CDP_ENDPOINT=http://127.0.0.1:9222` trong `.env`, khởi động lại Hub, mở **Kênh & Bridge** và bấm **Kết nối Brave**. Xác nhận đúng tài khoản, rồi lưu tên Teams.
5. Mở Teams/đăng nhập nếu cần. Sao chép URL cuộc trò chuyện Teams Personal, thêm chat đó vào phòng Zalo–Telegram ở trạng thái tạm dừng, kiểm tra tên và URL, rồi bật thành viên Teams.

Teams Personal dùng giao diện web và có thể cần xác nhận attach ở Brave. Adapter hiện chuyển văn bản; ảnh và file Teams chưa được hỗ trợ. Teams bridge phụ thuộc phiên Brave đăng nhập và SSH tunnel đang hoạt động. Khi tunnel hoặc Brave ngắt, các lượt gửi không được xác nhận sẽ hiện lỗi/đối soát trong trạng thái phòng.

## Trạng thái và giới hạn giao nhận

- Mỗi phòng có hàng đợi gửi tuần tự, receipt của kênh đích và nhật ký để kiểm tra.
- Khi đích đã nhận tin nhưng receipt bị mất, trạng thái cần đối soát; chỉ gửi lại sau khi người vận hành kiểm tra chat đích để tránh tin trùng.
- Bridge không đồng bộ lịch sử cũ, thành viên nhóm, reaction hoặc thread; chỉ chuyển tin mới sau khi bật.
- PostgreSQL local là nguồn trạng thái chung cho các adapter trong cùng Hub. Nếu chạy nhiều bản Hub đồng thời trên cùng tài khoản Zalo/Telegram, cần cấu hình fencing/leader trước khi vận hành để tránh hai tiến trình cùng nhận và gửi.
