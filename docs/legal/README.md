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

## TikTok URL verification

Trên app TikTok, làm bước **Verify** theo hướng dẫn (file HTML hoặc meta). Với `github.io`, thường dùng **URL prefix verification**: TikTok cấp file tải về — đặt vào `docs/` (hoặc `docs/legal/`) rồi push, sau đó bấm verify.

Nếu repo đổi tên, cập nhật lại URL trong bảng trên.