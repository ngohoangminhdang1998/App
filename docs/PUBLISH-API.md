# Publish qua API (TedVerse)

Studio tab **Settings → Publish API**. Chọn engine **API (OAuth)** rồi **Publish** như bình thường.

## Có “free” không?

| Nền tảng | Tạo app | Phí API | Ghi chú |
|----------|---------|---------|---------|
| **YouTube** | [Google Cloud Console](https://console.cloud.google.com/) | Miễn phí trong quota (upload tốn ~1600 units/lần) | Bật **YouTube Data API v3**, OAuth consent, thêm redirect `http://127.0.0.1:8787/oauth/callback/youtube` |
| **Facebook Reels / Page video** | [Meta for Developers](https://developers.facebook.com/) | Không tính phí theo call cơ bản | Cần **Facebook Page**. Một số quyền (`pages_manage_posts`, `publish_video`) cần **App Review** cho production |
| **TikTok** | [TikTok for Developers](https://developers.tiktok.com/) | Miễn phí | **Content Posting API** cần đăng ký sản phẩm + **duyệt app**; redirect `http://127.0.0.1:8787/oauth/callback/tiktok` |

Không có phí “đăng bài từng video” kiểu trả tiền cho Google/Meta/TikTok, nhưng **không phải** “chỉ tạo app là xong” — đặc biệt TikTok và Meta Reels thường phải duyệt quyền.

## Redirect OAuth (bắt buộc)

Redirect phải **khớp từng ký tự** với URL TedVerse gửi lúc Connect. Mở **Settings → Publish API** — dòng **OAuth redirect** (hoặc sau Save settings) là nguồn đúng.

### Mặc định (không tunnel)

- YouTube: `http://127.0.0.1:8787/oauth/callback/youtube`
- Facebook: `http://127.0.0.1:8787/oauth/callback/facebook` — **Meta Login for Business thường từ chối `http://`** → dùng tunnel bên dưới
- TikTok: `http://127.0.0.1:8787/oauth/callback/tiktok`

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

1. Tạo app loại **Business** (hoặc phù hợp Page)
2. Thêm sản phẩm **Facebook Login for Business**
3. **App ID**, **App secret**, (tuỳ chọn) **Page ID**
4. **Connect Facebook** → cấp quyền Page
5. Upload qua Graph API resumable lên **Page** bạn chọn

Reels trên Page phụ thuộc chính sách Meta; clip dọc ngắn thường hiển thị dạng Reel.

## TikTok

1. App → **Content Posting API** (scope `video.upload`, `video.publish`)
2. **Client key** + **Client secret**
3. Sau khi được duyệt: **Connect TikTok**
4. Publish qua `post/publish/video/init`

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