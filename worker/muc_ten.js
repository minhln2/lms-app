/**
 * Nhãn NĂM MỨC thành thạo 0..4 — MỘT nguồn cho MỌI môn (A9, quyết định chủ dự án 2026-11-06): Toán 6 (worker/toan_diem.js, templates/_toan.html), Bài tập Math 5
 * (worker/bai_tap.js re-export), Bài tập ESL 5 (worker/bai_tap_esl.js `nhanMuc`), khu bố mẹ (templates/quantri_hoc_tap.html), trang con ôn tập. Bộ của Toán 6
 * (toan/SPEC.md: «Vững» đổi thành «Học bá» ngày 2026-10-24). Chỉ là CHỮ — tiêu chí tính mức của từng môn (mucKt, mucDang…) không đổi.
 * Hàm thuần, không import. Builder chép sang dist/assets/muc_ten.<hash>.js và viết lại đường import trong bai_tap.js / bai_tap_esl.js
 * (tests/test_muc_ten_js.mjs chốt mọi chỗ khai nhãn — kể cả hằng nội tuyến trong template — bằng đúng bộ này).
 */
export const TEN_MUC = Object.freeze(["Chưa học", "Đang học", "Làm được", "Thành thạo", "Học bá"]);
