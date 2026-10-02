/**
 * Luật của bản thu âm tập đọc — MỘT nguồn cho cả Worker lẫn trang.
 *
 * Worker `import` file này để tự tính "hoàn thành" (không tin cờ trình duyệt gửi).
 * Builder (`src/tapdoc.py`) đọc nguyên văn file, bỏ chữ `export `, nhúng vào
 * `tapdoc.html`. Vì vậy file này CHỈ được dùng cú pháp chạy được ở cả hai nơi:
 * không `import`, không API của Worker, và mọi thứ xuất ra đều bắt đầu bằng
 * `export const` hoặc `export function` ở đầu dòng.
 *
 * `lat`: nhật ký lật trang `[[ms trên trục bản thu, số trang], …]`.
 */
export const TD = {
  GHE_MIN: 1000,                 // lần ghé ngắn hơn là vuốt nhầm, bỏ
  O_LAI_MIN: 2000,               // ở lại ít nhất chừng này mới tính "đã đi qua" trang
  TI_LE: 0.6,                    // bản thu phải dài ≥ 60% thời lượng máy đọc
  DAI_MAX: 30 * 60 * 1000,       // 30 phút
  BYTE_MAX: 20 * 1024 * 1024,    // 20 MB cho cả bản thu
};

/** Nhật ký lật + tổng dài (ms) → các lần ghé `{trang, tu, den}`, đã bỏ lần < 1 s. */
export function tdGhe(lat, dai) {
  const a = (Array.isArray(lat) ? lat : [])
    .filter((x) => Array.isArray(x) && Number.isFinite(x[0]) && Number.isInteger(x[1]) &&
                   x[1] >= 1 && x[0] >= 0 && x[0] <= dai)
    .slice()
    .sort((p, q) => p[0] - q[0]);
  const out = [];
  for (let i = 0; i < a.length; i++) {
    const g = { trang: a[i][1], tu: a[i][0], den: i + 1 < a.length ? a[i + 1][0] : dai };
    if (g.den - g.tu < TD.GHE_MIN) continue;
    const c = out[out.length - 1];
    if (c && c.trang === g.trang) c.den = g.den;   // hai lần cùng trang, giữa là vuốt nhầm
    else out.push(g);
  }
  return out;
}

/** Bản thu đã "hoàn thành" chưa, và nếu chưa thì thiếu gì. */
export function tdHoanThanh(lat, dai, soTrang, daiMay) {
  // Đóng khi nghi ngờ: Worker dùng hàm này để KHÔNG tin cờ trình duyệt, nên số
  // trang hay thời lượng máy đọc thiếu/hỏng thì trả "chưa hoàn thành", không
  // để vòng lặp rỗng hay 0,6 × null = 0 biến thành "xong".
  const soOk = Number.isInteger(soTrang) && soTrang >= 1;
  const ghe = tdGhe(lat, dai);
  const thieu = [];
  if (soOk) {
    for (let p = 1; p <= soTrang; p++) {
      if (!ghe.some((g) => g.trang === p && g.den - g.tu >= TD.O_LAI_MIN)) thieu.push(p);
    }
  }
  const duDai = Number.isFinite(dai) && dai > 0 && Number.isFinite(daiMay) && daiMay > 0 &&
                dai >= TD.TI_LE * daiMay;
  return { xong: soOk && thieu.length === 0 && duDai, thieu, duDai };
}

/** Đang phát tới `ms` thì trang nào đang hiện. */
export function tdTrangLuc(ghe, ms) {
  let p = ghe.length ? ghe[0].trang : 1;
  for (const g of ghe) if (g.tu <= ms) p = g.trang;
  return p;
}

/** Người nghe lật tới `trang` → nhảy tới lần bé ở lại trang đó LÂU NHẤT. */
export function tdNhayToi(ghe, trang) {
  let b = null;
  for (const g of ghe) if (g.trang === trang && (!b || g.den - g.tu > b.den - b.tu)) b = g;
  return b ? b.tu : null;
}
