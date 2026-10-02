/**
 * Kho file R2 dùng chung cho cả site (binding KHO, bucket lms-kho).
 *
 * Quyền quyết định theo TIỀN TỐ của khoá, khai một chỗ ở đây. Hôm nay chỉ có
 * `thu-am/` (bản thu giọng trẻ: đọc và ghi đều cần mã bí mật). Sau này chuyển tài
 * liệu / SGK sang R2 thì thêm dòng `tai-lieu/`, `sach/` với `doc: "cong-khai"` —
 * xem mục "Việc để sau" của spec tập đọc.
 *
 * ⚠ Khoá ngoài bảng thì TỪ CHỐI, không mặc định cho qua: một tiền tố gõ nhầm mà
 * được ghi là một file nằm ngoài mọi luật quyền.
 */
const QUYEN = [
  ["thu-am/", { doc: "ma", ghi: "ma" }],
];

export function khoQuyen(khoa) {
  const q = QUYEN.find(([t]) => typeof khoa === "string" && khoa.startsWith(t));
  return q ? q[1] : null;
}

function kiem(khoa) {
  if (!khoQuyen(khoa) || khoa.includes("..")) throw new Error("Khoá kho không hợp lệ: " + khoa);
}

export async function khoGhi(env, khoa, than, loai) {
  kiem(khoa);
  await env.KHO.put(khoa, than, { httpMetadata: { contentType: loai } });
}

export async function khoDoc(env, khoa) {
  kiem(khoa);
  return env.KHO.get(khoa);
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
