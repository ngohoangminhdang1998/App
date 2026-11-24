# Legal pages (TikTok / developer consoles)

Sau khi bật **GitHub Pages** (xem bên dưới), dán URL vào TikTok Developer → App details:

| Ô TikTok | URL |
|----------|-----|
| **Privacy Policy URL** | `https://ngohoangminhdang1998.github.io/App/legal/privacy.html` |
| **Terms of Service URL** | `https://ngohoangminhdang1998.github.io/App/legal/terms.html` |
| **Web URL** (nếu hỏi) | `https://ngohoangminhdang1998.github.io/App/legal/` |

## Bật GitHub Pages (một lần)

1. Repo **App** trên GitHub → **Settings** → **Pages**
2. **Build and deployment** → Source: **Deploy from a branch**
3. Branch: **main**, folder: **`/docs`**
4. **Save** — đợi 1–3 phút, site lên tại `https://ngohoangminhdang1998.github.io/App/`

File legal nằm tại `docs/legal/` → path `/legal/privacy.html`.

## TikTok URL verification (đủ 3 ô đỏ)

Lỗi **This URL is not verified** = TikTok chưa thấy file xác minh + URL phải trả **200** (không 404).

### Trước hết: site phải sống

1. Merge branch `docs/tiktok-legal-pages` → `main` (PR trên GitHub).
2. **Settings → Pages** → Source: branch **main**, folder **`/docs`** → Save.
3. Mở `https://ngohoangminhdang1998.github.io/App/legal/privacy.html` — phải thấy trang, không 404.

### Verify trong TikTok (URL prefix — khuyên dùng với GitHub Pages)

1. App **Ua Gi Vay** → góc phải **URL properties** → **Verify properties** (tab Production).
2. Chọn **URL prefix** (không chọn Domain — bạn không sở hữu DNS `github.io`).
3. Nhập **đúng** (có slash cuối):

   `https://ngohoangminhdang1998.github.io/App/legal/`

4. **Verify** → TikTok cho **tải file** (tên dạng `tiktok….txt` — giữ **đúng tên**, đừng đổi).
5. Đặt file đó vào repo: `docs/legal/<tên-file-tiktok-cấp>.txt` (cùng thư mục với `privacy.html`).
6. Push lên `main`, đợi 1–2 phút, mở trình duyệt:

   `https://ngohoangminhdang1998.github.io/App/legal/<tên-file>.txt`

   Phải thấy nội dung text, không 404.

7. Quay lại TikTok **URL properties** → bấm **Verify** lại cho prefix đó.
8. Khi prefix đã **Verified**, 3 URL trong App details (Terms, Privacy, Web) — tất cả nằm dưới prefix `/App/legal/` — sẽ hết lỗi đỏ → **Save**.

**Lưu ý:** Redirect 301/302 làm verify fail. GitHub Pages trực tiếp file `.txt` thường OK.

Nếu repo đổi tên, cập nhật lại URL trong bảng trên.