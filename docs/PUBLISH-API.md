# Publish qua API (TedVerse)

Studio tab **Settings → Publish API**. Chọn engine **API (OAuth)** rồi **Publish** như bình thường.

## Có “free” không?

| Nền tảng | Tạo app | Phí API | Ghi chú |
|----------|---------|---------|---------|
| **YouTube** | [Google Cloud Console](https://console.cloud.google.com/) | Miễn phí trong quota (upload tốn ~1600 units/lần) | Bật **YouTube Data API v3**, OAuth consent, thêm redirect `http://127.0.0.1:8787/oauth/callback/youtube` |
| **Facebook Reels / Page video** | [Meta for Developers](https://developers.facebook.com/) | Không tính phí theo call cơ bản | Cần **Facebook Page**. Một số quyền (`pages_manage_posts`, `publish_video`) cần **App Review** cho production |
| **TikTok** | [TikTok for Developers](https://developers.tiktok.com/) | Miễn phí | **Content Posting API** + **Login Kit**. Redirect loopback chỉ đăng ký tab **Desktop** (không phải **Web** — Web bắt `https://` only). |

Không có phí “đăng bài từng video” kiểu trả tiền cho Google/Meta/TikTok, nhưng **không phải** “chỉ tạo app là xong” — đặc biệt TikTok và Meta Reels thường phải duyệt quyền.

## Redirect OAuth (bắt buộc)

Redirect phải **khớp từng ký tự** với URL TedVerse gửi lúc Connect. Mở **Settings → Publish API** — dòng **OAuth redirect** (hoặc sau Save settings) là nguồn đúng.

### Mặc định (không tunnel)

- YouTube: `http://127.0.0.1:8787/oauth/callback/youtube`
- Facebook: `http://127.0.0.1:8787/oauth/callback/facebook` — **Meta Login for Business thường từ chối `http://`** → dùng tunnel bên dưới
- TikTok (Login Kit **Desktop**): `http://127.0.0.1:8787/oauth/callback/tiktok` — **không** dùng tab Web (`localhost` / `127.0.0.1` bị từ chối, báo “localhost is not supported”).

Đổi cổng Studio: `FLOW_MCP_PORT` (mặc định 8787).

### Facebook + HTTPS tunnel (`FLOW_MCP_OAUTH_PUBLIC_URL`)

Meta yêu cầu **HTTPS** trong Valid OAuth Redirect URIs. TedVerse vẫn chạy HTTP trên máy; tunnel public → local.

**1. Cloudflare Tunnel (miễn phí, nhanh)**

```bash
# Cài (macOS): brew install cloudflared
# Terminal 1 — Studio
cd /path/to/flow-mcp-main
npm run studio

# Terminal 2 — tunnel tới cổng Studio
cloudflared tunnel --url http://127.0.0.1:8787
```

Copy URL dạng `https://xxxx-yyyy.trycloudflare.com` (HTTPS, **không** slash cuối).

**2. Bật redirect public**

```bash
export FLOW_MCP_OAUTH_PUBLIC_URL=https://xxxx-yyyy.trycloudflare.com
# restart npm run studio cùng terminal hoặc export trước khi chạy
```

**3. Meta Developer**

- **Facebook Login for Business → Settings → Valid OAuth Redirect URIs**
- Thêm: `https://xxxx-yyyy.trycloudflare.com/oauth/callback/facebook`
- **Save**

**4. TedVerse**

- Restart studio **sau** khi export biến môi trường
- Settings → Publish API → redirect Facebook hiển thị URL **https** — phải giống Meta
- **Connect Facebook** — sau Allow, tab có thể mở URL tunnel (vẫn về máy bạn)

**5. Ngrok (thay cloudflared)**

```bash
ngrok http 8787
export FLOW_MCP_OAUTH_PUBLIC_URL=https://YOUR_ID.ngrok-free.app
```

**Lưu ý**

- Studio UI vẫn dùng `http://127.0.0.1:8787`; chỉ **OAuth callback** qua HTTPS.
- URL trycloudflare **đổi mỗi lần** chạy cloudflared — cập nhật lại Meta + env khi đổi tunnel.
- Giữ tunnel **mở** trong lúc Connect; có thể tắt sau khi đã lưu token trong `~/.flow-mcp/publish-api.json`.

## YouTube Shorts

1. Cloud project → APIs → enable **YouTube Data API v3**
2. Credentials → **OAuth client** (Desktop hoặc Web — web + redirect localhost)
3. Dán **Client ID** + **Client secret** trong Settings
4. **Connect Google / YouTube** → chọn kênh
5. Video **dọc, ≤60s** thường được Shorts Feed xử lý như Short; upload dùng API `videos.insert` (resumable)

Tùy chọn: `FLOW_MCP_YOUTUBE_MADE_FOR_KIDS=yes|no`

## Facebook (Page Reels / video)

1. Tạo app trên Meta → **App ID**, **App secret**, **Page ID** fanpage
2. [Graph API Explorer](https://developers.facebook.com/tools/explorer/) → user token → `GET me/accounts?fields=id,name,access_token` → copy **Page `access_token`**
3. Studio **Settings → Publish API** → dán **Page access token** → **Save settings** (không dùng OAuth Connect)
4. Upload qua Graph API resumable lên Page đã chọn

Reels trên Page phụ thuộc chính sách Meta; clip dọc ngắn thường hiển thị dạng Reel.

## TikTok

1. **Login Kit** → tab **Desktop** (không điền redirect ở tab **Web** — Web chỉ `https://`).
2. Redirect (Sandbox): `http://127.0.0.1:8787/oauth/callback/tiktok` (không dùng `localhost`).
3. **Content Posting API** + bật **Direct Post**; scopes `user.info.basic`, `video.upload`, `video.publish`.
4. **Sandbox** → **Target users** → Add account (nick bạn đăng bài).
5. TedVerse: Client key/secret → **Get token** → **Publish**.

Nếu Apply báo *localhost is not supported* dù đã dùng `127.0.0.1`: bạn đang ở tab **Web** — chuyển sang **Desktop**.

Tunnel HTTPS (Production Web): `export FLOW_MCP_TIKTOK_OAUTH_PUBLIC_URL=https://….trycloudflare.com` + redirect trên TikTok khớp Studio.

**Sandbox / app chưa audit:** TedVerse mặc định `privacy_level=SELF_ONLY` (chỉ mình bạn xem). Trong **app TikTok** → Cài đặt → **Privacy** → bật **Private account**, rồi Publish lại. Video lên kênh nhưng **không public** — sau khi đổi public + sửa privacy từng clip trên TikTok.

Sau **App review** (Production): `export FLOW_MCP_TIKTOK_PRIVACY=PUBLIC_TO_EVERYONE` và restart studio.

Nếu init trả lỗi quota/review, TikTok chưa bật posting cho app của bạn.

## Chế độ Browser vs API

- **Browser**: Playwright + Chrome Flow profile (cũ) — hỗ trợ **lên lịch** trên từng nền tảng
- **API**: upload HTTPS — chỉ **Publish now**; lên lịch vẫn dùng browser

Env override: `FLOW_MCP_PUBLISH_ENGINE=api` hoặc `browser`

Secrets lưu tại `~/.flow-mcp/publish-api.json` (quyền file 600). Không đưa secret vào MCP chat.

## Kiểm tra

1. `npm run build` (nếu có thể) + restart `npm run studio`
2. Settings → Save → Connect từng nền tảng
3. Publish tab → chọn film local → một platform → Publish Now