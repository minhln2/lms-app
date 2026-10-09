/**
 * Tài liệu tải về (`/<hs>/materials/<môn>/<học phần>/<tên>`) phục vụ từ R2 `lms-kho`, khoá
 * `tai-lieu/<hs>/<môn>/<học phần>/<tên>` — ADR 0062. `scripts/day_tai_lieu_r2.py` đẩy từ
 * `dist/<hs>/materials/` TRƯỚC deploy, xoá tệp giáo viên đã gỡ SAU deploy.
 * Khoá R2 KHÔNG chứa `..`: tên có `..` (vd `Tuan 1..pdf`) nằm dưới khoá `Tuan 1.~.pdf` — `khoaR2`, xem hàm đó.
 *
 * Vì sao Worker mà không phải tệp tĩnh: tài liệu to tới ~100 MB (trần tệp tĩnh 25 MiB) và cần
 * HTTP Range (video tua được, PDF.js xin từng đoạn) mà tệp tĩnh bỏ qua Range (đo 2026-10-03,
 * xem worker/range.js). `wrangler.toml` `run_worker_first` có dòng cho đường tài liệu nên chỉ
 * đường này (cùng audio) chạy Worker trước tệp tĩnh. (Đừng chép nguyên mẫu glob vào chú thích
 * khối này: chuỗi "/" + "*" + "/" kết thúc chú thích.)
 *
 * ⚠ TRUYỀN THẲNG luồng R2 (`obj.body`), KHÔNG `arrayBuffer()`: Worker có ~128 MB RAM mà tệp tới
 * ~100 MB. Khác range.js (audio ≤ 250 KB nên đọc trọn rồi tự cắt). Có Range thì xin R2 ĐÚNG đoạn.
 *
 * Thiếu khoá → 404, KHÔNG lùi về ASSETS (public/ không còn tài liệu). Tên tệp không có hash nên
 * cache 1 giờ: giáo viên thay tệp cùng tên thì tối đa một giờ là thấy bản mới.
 * Chi phí mỗi lần mở: 1 lượt Worker + 2 thao tác đọc R2 (head + get); HEAD / 304 chỉ 1.
 */
import { khoDau, khoDoc, khoaHopLe } from "./kho.js";
import { docRange } from "./range.js";

const TL_RE = /^\/([^/]+)\/materials\/(.+)$/;
const CACHE = "public, max-age=3600";

/**
 * Đuôi tệp mà trình duyệt CHẠY được (trang/script) khi mở thẳng URL. Tài liệu nay phục vụ từ CHÍNH miền
 * của app (trước đây ở github.io — miền khác), mà miền này giữ token quản trị của bố mẹ trong
 * localStorage (templates/diem.html): một .html/.svg/.xml… giáo viên tải lên mà được trả đúng kiểu
 * `text/html` / `image/svg+xml` thì script trong đó chạy với quyền của app. Nên các đuôi này luôn trả
 * `application/octet-stream` + `content-disposition: attachment` (tải về, không hiển thị). Quyết theo ĐUÔI
 * của đoạn cuối khoá (không phân biệt hoa/thường), không tin content-type trong metadata R2.
 * ⚠ Danh sách này có ở HAI nơi — `scripts/day_tai_lieu_r2.py › DUOI_CHAY_MA` (đẩy lên R2 với kiểu
 * octet-stream); `tests/test_day_tai_lieu_r2.py` đọc file này và so hai danh sách. Một dòng, để test dò.
 */
export const DUOI_CHAY_MA = [".html", ".htm", ".xhtml", ".xht", ".shtml", ".svg", ".xml", ".xsl", ".xslt", ".rdf", ".wsdl", ".xpdl", ".js", ".mjs"];
const CHAY_MA = new Set(DUOI_CHAY_MA);

/** Khoá R2 → có phải tệp trình duyệt sẽ chạy như trang/script không (xét đuôi đoạn cuối). */
export function laTepChayMa(khoa) {
  const ten = khoa.slice(khoa.lastIndexOf("/") + 1);
  const i = ten.lastIndexOf(".");
  return i >= 0 && CHAY_MA.has(ten.slice(i).toLowerCase());
}

export const laTaiLieu = (pathname) => TL_RE.test(pathname);

/**
 * Khoá logic → khoá R2 THẬT: mọi `..` → `.~.`, LẶP tới khi hết `..` (`...` → `.~.~.`). Phép đổi tất định của
 * `scripts/day_tai_lieu_r2.py › khoa_r2` — script đẩy tệp `Tuan 1..pdf` dưới khoá `Tuan 1.~.pdf`, URL trên site
 * giữ tên gốc, nên Worker phải đổi y hệt để tìm đúng khoá.
 * Vì sao có phép đổi: wrangler đặt khoá không mã hoá vào đường dẫn API, Cloudflare từ chối mọi đường dẫn chứa `..`
 * (`r2 bulk put` → `403: Forbidden`; đo thật 2026-10-09: `a..b.txt` và `a%2E%2Eb.txt` đều 403, `a.~.b.txt` OK,
 * 31 tệp thật có `..` trong tên). Hai bên PHẢI giống nhau: tests/test_day_tai_lieu_r2.py (17) chạy hàm này qua node.
 * ⚠ Chỉ áp SAU `khoaHopLe`: đoạn `..` (thoát thư mục) phải bị từ chối 400, không được thành `.~.` rồi lọt.
 */
export function khoaR2(khoa) {
  while (khoa.includes("..")) khoa = khoa.replaceAll("..", ".~.");
  return khoa;
}

/** Pathname → khoá R2 (đã qua `khoaR2`: `..` giữa tên → `.~.`), hoặc null (URI `%` hỏng, có CẢ ĐOẠN `..`/`.`, ra ngoài `tai-lieu/`). */
export function khoaTaiLieu(pathname) {
  const m = TL_RE.exec(pathname);
  if (!m) return null;
  let khoa;
  try {
    khoa = `tai-lieu/${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`;
  } catch {
    return null;
  }
  return khoaHopLe(khoa) ? khoaR2(khoa) : null;
}

const loi = (status, msg) =>
  new Response(msg, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

function khopEtag(inm, etag) {
  if (!inm || !etag) return false;
  const bo = (x) => x.trim().replace(/^W\//, "");
  return inm.split(",").some((x) => x.trim() === "*" || bo(x) === bo(etag));
}

export async function phucVuTaiLieu(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method không hỗ trợ", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const khoa = khoaTaiLieu(new URL(request.url).pathname);
  if (!khoa) return loi(400, "Đường dẫn tài liệu không hợp lệ");
  if (!env.KHO) return loi(502, "Chưa nối kho R2");
  try {
    const dau = await khoDau(env, khoa);
    if (!dau) return loi(404, "Không có tài liệu này");
    const out = new Headers();
    dau.writeHttpMetadata(out);
    if (!out.has("content-type")) out.set("content-type", "application/octet-stream");
    // Đặt TRƯỚC mọi nhánh trả (200/206/304/416/HEAD) để cùng một bộ header; Range, ETag… giữ nguyên.
    if (laTepChayMa(khoa)) {
      out.set("content-type", "application/octet-stream");
      out.set("content-disposition", "attachment");
    }
    out.set("etag", dau.httpEtag);
    out.set("accept-ranges", "bytes");
    out.set("cache-control", CACHE);
    if (khopEtag(request.headers.get("if-none-match"), dau.httpEtag)) {
      return new Response(null, { status: 304, headers: out });
    }
    const total = dau.size;
    // If-Range: chỉ cắt khi ETag MẠNH còn khớp, không thì trả đủ tệp mới (RFC 9110).
    const ifRange = request.headers.get("if-range");
    const conCat = !ifRange || (ifRange === dau.httpEtag && !ifRange.startsWith("W/"));
    const r = conCat ? docRange(request.headers.get("range"), total) : null;
    if (r === "416") {
      out.set("content-range", `bytes */${total}`);
      out.set("content-length", "0");
      return new Response(null, { status: 416, headers: out });
    }
    const status = r ? 206 : 200;
    const dai = r ? r.end - r.start + 1 : total;
    if (r) out.set("content-range", `bytes ${r.start}-${r.end}/${total}`);
    out.set("content-length", String(dai));
    if (request.method === "HEAD") return new Response(null, { status, headers: out });
    const obj = await khoDoc(env, khoa, r ? { range: { offset: r.start, length: dai } } : undefined);
    if (!obj) return loi(404, "Không có tài liệu này");   // bị xoá giữa head() và get()
    return new Response(obj.body, { status, headers: out });
  } catch (e) {
    console.log("tai_lieu: R2 lỗi:", e && e.message);
    return loi(502, "Kho tài liệu đang lỗi, thử lại sau");
  }
}
