/**
 * Audio tập đọc (`/tap-doc/am/<hash>.mp3`) có hỗ trợ HTTP Range.
 *
 * Vì sao: tệp tĩnh của Workers KHÔNG nhận Range — đo 2026-10-03 trên site thật,
 * `Range: bytes=100-199` vẫn nhận 200 + đủ 52.800 byte, không có `Accept-Ranges`.
 * Thiếu Range thì Chromium không tua được (đặt 3,6 s rơi về 0,09 s): chạm một từ là
 * nghe lại cả lượt đánh vần từ đầu, thanh tua của bài đọc vô dụng; Safari iOS có thể
 * từ chối phát hẳn. `wrangler.toml` `[assets] run_worker_first = ["/tap-doc/am/*"]`
 * cho Worker chạy trước CHỈ ở đường này; mọi tệp tĩnh khác vẫn đi thẳng.
 *
 * Tệp công khai (như mọi tệp tĩnh) — không đòi mã. Chỉ xử lý MỘT khoảng; nhiều khoảng
 * thì trả 200 đủ tệp (RFC 9110 cho phép). Range sai cú pháp → bỏ qua, trả 200.
 */

const AM_RE = /^\/tap-doc\/am\/[0-9a-f]+\.mp3$/;
// Lưới dự phòng: không chắc `_headers` có áp lên phản hồi đi qua binding ASSETS hay
// không. Tên tệp là hash nội dung nên cache vĩnh viễn được (khớp dòng trong builder.py).
const CACHE_MAC_DINH = "public, max-age=31536000, immutable";

export const laAm = (pathname) => AM_RE.test(pathname);

/** → {start, end} | "416" | null (null = bỏ qua Range, trả đủ tệp). */
export function docRange(h, total) {
  if (!h) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(h);
  if (!m) return null;   // sai cú pháp hoặc nhiều khoảng (có dấu phẩy)
  const [, a, b] = m;
  if (a === "" && b === "") return null;
  if (a === "") {   // bytes=-n: n byte cuối
    const n = Number(b);
    if (n === 0 || total === 0) return "416";
    return { start: Math.max(0, total - n), end: total - 1 };
  }
  const start = Number(a);
  if (b !== "" && Number(b) < start) return null;
  if (start >= total) return "416";
  const end = b === "" ? total - 1 : Math.min(Number(b), total - 1);
  return { start, end };
}

export async function phucVuAm(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") return env.ASSETS.fetch(request);
  // Hỏi ASSETS KHÔNG kèm Range (nó vốn bỏ qua) — lấy đủ tệp rồi tự cắt.
  const h = new Headers(request.headers);
  h.delete("range");
  h.delete("if-range");
  const res = await env.ASSETS.fetch(new Request(request.url, { method: "GET", headers: h }));
  if (res.status !== 200) return res;   // 404, 304… đi nguyên

  const buf = await res.arrayBuffer();
  const total = buf.byteLength;
  const out = new Headers(res.headers);
  out.set("accept-ranges", "bytes");
  if (!out.has("cache-control")) out.set("cache-control", CACHE_MAC_DINH);
  out.delete("content-encoding");   // trả đúng byte đã cắt, không nén lại
  const head = request.method === "HEAD";

  // If-Range: chỉ cắt khi ETag MẠNH còn khớp, không thì trả đủ tệp mới (RFC 9110:
  // ETag yếu W/"…" không bao giờ khớp If-Range).
  const ifRange = request.headers.get("if-range");
  const etag = res.headers.get("etag");
  const khop = ifRange && etag && ifRange === etag && !etag.startsWith("W/");
  const r = ifRange && !khop ? null : docRange(request.headers.get("range"), total);

  if (r === "416") {
    out.set("content-range", `bytes */${total}`);
    out.set("content-length", "0");
    return new Response(null, { status: 416, headers: out });
  }
  if (!r) {
    out.set("content-length", String(total));
    return new Response(head ? null : buf, { status: 200, headers: out });
  }
  out.set("content-range", `bytes ${r.start}-${r.end}/${total}`);
  out.set("content-length", String(r.end - r.start + 1));
  return new Response(head ? null : buf.slice(r.start, r.end + 1), { status: 206, headers: out });
}
