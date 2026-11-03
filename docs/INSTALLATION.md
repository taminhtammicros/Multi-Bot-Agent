# Cài đặt trên máy mới

Hub có hai cách chạy. Chọn một cách cho ứng dụng; không chạy hai bản Hub cùng lúc trên cùng database hoặc cùng tài khoản Zalo.

| Cách chạy | Ứng dụng | PostgreSQL | Phù hợp khi |
|---|---|---|---|
| Native | Node.js trên máy | Docker Compose hoặc PostgreSQL native | Hermes/OpenClaw được cài trực tiếp trên máy, cần dùng endpoint localhost và Hermes guard |
| Docker | Container `app` | Container `db` | Muốn cài cả Hub và database bằng một lệnh Compose |

## Yêu cầu

- **Native:** Node.js 24 LTS trở lên. Nếu dùng PostgreSQL trong container, cần Docker Desktop/Engine có Docker Compose. Nếu dùng backup, cần `pg_dump` cùng major version với server PostgreSQL (Compose hiện dùng PostgreSQL 17).
- **Docker:** Docker Desktop hoặc Docker Engine có Compose. Image được build cho kiến trúc máy hiện tại.
- Cổng mặc định: Dashboard `3890`, PostgreSQL `55439`; cả hai chỉ publish trên loopback.
- Không cần cài Python, Hermes hay OpenClaw để chạy dashboard. Agent là thành phần tùy chọn.

## Native trên macOS/Linux, database bằng Docker

```sh
cp .env.example .env
npm ci
npm run db:up
npm start
```

Trên PowerShell, sao chép cấu hình bằng `Copy-Item .env.example .env`. Mặc định Compose dùng mật khẩu database local `hub_local_dev` và chỉ publish PostgreSQL trên `127.0.0.1`. Đây là cấu hình máy cá nhân; thay mật khẩu nếu dùng môi trường có nhiều người truy cập.

Mở `http://127.0.0.1:3890`. Mã quản trị được tạo tại `data/admin-token` ở lần chạy đầu. Chỉ mở một bản Hub cho database đó.

## Native với PostgreSQL native

1. Cài PostgreSQL và tạo database cùng user riêng.
2. Tạo `.env` từ `.env.example`, sau đó đặt `DATABASE_URL` đúng với database.
3. Cài dependency, build và chạy bản biên dịch:

```sh
npm ci
npm run build
npm run start:prod
```

Để tạo backup trong dashboard, cài PostgreSQL client có `pg_dump` cùng major version với server trên máy chạy Hub. Tiến trình backup dùng `DATABASE_URL`; không cần cài Docker CLI hoặc mount Docker socket.

## Docker Compose cho cả Hub và database

```sh
cp .env.example .env
```

Mở `.env` và đặt `POSTGRES_PASSWORD` thành mật khẩu hexadecimal ngẫu nhiên. Ví dụ trên macOS/Linux: `openssl rand -hex 32`. Sau đó chạy:

```sh
docker compose up --build -d
docker compose ps
docker compose logs -f app
```

Mở `http://127.0.0.1:3890`. Xem mã quản trị lần đầu bằng:

```sh
docker compose exec app cat /app/data/admin-token
```

Compose tạo các volume `hub_data`, `hub_backups` và `hub_postgres`. Chúng giữ session/khóa Hub, backup và database khi thay image hoặc khởi động lại. `docker compose down` không xóa volume; **không dùng `docker compose down -v`** nếu cần giữ dữ liệu.

Đổi cổng host bằng `APP_PORT` và `POSTGRES_PORT` trong `.env`. `APP_BIND_ADDRESS` mặc định là `127.0.0.1`; không đổi thành `0.0.0.0` nếu chưa cấu hình HTTPS, xác thực và firewall phù hợp. Khi đổi `POSTGRES_PORT` ở chế độ native, cập nhật `DATABASE_URL` cho khớp. Thay đổi `POSTGRES_PASSWORD` sau khi database đã được khởi tạo không tự đổi mật khẩu trong volume PostgreSQL; cần cập nhật user trong database theo quy trình quản trị PostgreSQL.

## Kết nối Agent

Hub cần gọi được endpoint API của Hermes/OpenClaw từ chính môi trường đang chạy app. Khi chạy native, endpoint local thường là `127.0.0.1`. Khi chạy trong container, `127.0.0.1` trỏ vào container Hub; Agent phải ở cùng Docker network hoặc có địa chỉ mà container Hub truy cập được. Không mở API Agent ra Internet.

Hermes guard hiện kiểm tra listener trên cùng hệ thống với Hub. Nếu dùng profile có giới hạn lệnh, giữ Hub và Hermes trên cùng máy native và xác nhận guard báo sẵn sàng. Khi Hermes ở container/máy khác, Hub sẽ không coi prompt là guard thay thế; không bật policy hạn chế cho đến khi có cấu hình guard phù hợp với topology đó.

## Đăng nhập Zalo trên máy mới

Mỗi cài đặt tự tạo admin token và encryption key. Đăng nhập dashboard, kết nối Zalo bằng QR và cấu hình Agent API key riêng. Session Zalo và credentials được lưu trong `data/` native hoặc volume `hub_data` của Docker. Không đưa `.env`, thư mục `data/`, database volume hay backup lên GitHub. Không chạy đồng thời một bản Hub khác với cùng tài khoản Zalo.

## Backup và restore

Nút backup trong dashboard và `npm run db:backup` gọi `pg_dump` bằng thông tin trong `DATABASE_URL`, lưu dump vào `backups/` với quyền file riêng. Docker image có PostgreSQL 17 client; native cần tự cài client cùng major version với server. Hãy sao chép backup ra nơi lưu trữ an toàn và bảo vệ encryption key tách biệt.

Trước khi phục hồi, dừng Hub và restore vào database mới để kiểm tra. Ví dụ:

```sh
createdb zalo_hub_restore
pg_restore --exit-on-error --no-owner --no-privileges \
  --dbname=postgres://USER:PASSWORD@HOST:PORT/zalo_hub_restore \
  backups/FILE.dump
```

Khi restore Docker, dùng `docker compose exec -T db` để chạy `createdb`/`pg_restore` trong container database; truyền dump vào stdin. Không restore đè database đang chạy nếu chưa có backup và kế hoạch quay lui. Phục hồi đầy đủ còn cần encryption key tương ứng; session Zalo chỉ nên phục hồi khi có chủ đích.

## Giới hạn cài đặt tự động

Core Hub chạy bằng Node.js. Các script kết nối/cài Hermes và cấu hình LaunchAgent dành cho máy cài Agent tương ứng; chúng không phải bước bắt buộc để chạy ứng dụng. Ưu tiên Docker trên Windows hiện chưa thay thế được Hermes guard cài trực tiếp trên máy.
