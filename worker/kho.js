/**
 * Kho file R2 dùng chung cho cả site (binding KHO, bucket lms-kho).
 *
 * Quyền quyết định theo TIỀN TỐ của khoá, khai một chỗ ở đây:
 *   · `thu-am/`     — bản thu giọng trẻ: đọc và ghi đều cần mã bí mật.
 *   · `tap-doc/am/` — audio máy đọc (tên = hash nội dung): ai cũng đọc được qua
 *     worker/range.js; chỉ `scripts/day_am_r2.sh` ghi, từ máy, bằng wrangler.
 *   · `tai-lieu/`   — tài liệu tải về (ADR 0062): ai cũng đọc được qua worker/tai_lieu.js;
 *     chỉ `scripts/day_tai_lieu_r2.py` ghi / xoá, từ máy, bằng wrangler.
 * Sau này chuyển SGK sang R2 thì thêm dòng `sach/` với `doc: "cong-khai"` — xem mục
 * "Việc để sau" của spec tập đọc.
 *
 * ⚠ Khoá ngoài bảng thì TỪ CHỐI, không mặc định cho qua: một tiền tố gõ nhầm mà
 * được ghi là một file nằm ngoài mọi luật quyền.
 */
const QUYEN = [
  ["thu-am/", { doc: "ma", ghi: "ma" }],
  ["tap-doc/am/", { doc: "cong-khai", ghi: "may" }],
  ["tai-lieu/", { doc: "cong-khai", ghi: "may" }],
];

export function khoQuyen(khoa) {
  const q = QUYEN.find(([t]) => typeof khoa === "string" && khoa.startsWith(t));
  return q ? q[1] : null;
}

// `..` xét theo ĐOẠN, KHÔNG theo chuỗi con: tên tài liệu thật có `..` giữa tên
// ("…denominator..pptx", ≥ 10 tệp CIE Maths 5) — chặn theo chuỗi con là 400 oan cả loạt đó.
export function khoaHopLe(khoa) {
  return !!khoQuyen(khoa) && !khoa.split("/").some((d) => d === ".." || d === ".");
}

function kiem(khoa) {
  if (!khoaHopLe(khoa)) throw new Error("Khoá kho không hợp lệ: " + khoa);
}

export async function khoGhi(env, khoa, than, loai) {
  kiem(khoa);
  await env.KHO.put(khoa, than, { httpMetadata: { contentType: loai } });
}

/** `tuyChon` chuyển thẳng cho R2 (vd `{ range: { offset, length } }` — worker/tai_lieu.js). */
export async function khoDoc(env, khoa, tuyChon) {
  kiem(khoa);
  return env.KHO.get(khoa, tuyChon);
}

export async function khoDau(env, khoa) {
  kiem(khoa);
  return env.KHO.head(khoa);
}

/** Mọi đối tượng dưới một tiền tố → [{khoa, size}] (đi hết các trang kết quả). */
export async function khoLietCo(env, tienTo) {
  kiem(tienTo);
  const out = [];
  let cursor;
  do {
    const r = await env.KHO.list({ prefix: tienTo, cursor });
    out.push(...r.objects.map((o) => ({ khoa: o.key, size: o.size })));
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return out;
}

/** Mọi khoá dưới một tiền tố. */
export async function khoLiet(env, tienTo) {
  return (await khoLietCo(env, tienTo)).map((o) => o.khoa);
}

/** Xoá theo lô: R2 nhận tối đa 1000 khoá mỗi lượt delete(). */
export async function khoXoa(env, khoas) {
  khoas.forEach(kiem);
  for (let i = 0; i < khoas.length; i += 1000) await env.KHO.delete(khoas.slice(i, i + 1000));
}
