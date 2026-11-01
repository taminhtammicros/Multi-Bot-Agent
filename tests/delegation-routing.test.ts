import { test } from "node:test";
import assert from "node:assert/strict";
import {
  explicitlyRequestsOpenClaw,
  requiresOpenClawSupport,
} from "../src/engine.js";
test("explicit OpenClaw commands route in the service; identity/status/negative questions do not execute a handoff", () => {
  for (const text of [
    "kiểm tra giá Xăng hôm nay ,hãy giao việc cho Openclaw làm nhé, hiển thị chi tiết cách giao việc",
    "kiểm tra giá Xăng hôm nay, giao việc phù hợp cho Openclaw nhé",
    "Nhờ OpenClaw tra nguồn",
    "Cho Openclaw xử lý yêu cầu này",
  ])
    assert.equal(explicitlyRequestsOpenClaw(text), true, text);
  for (const text of [
    "OpenClaw hay Hermes đang trả lời?",
    "Đã giao việc cho Openclaw chưa?",
    "không cần giao cho Openclaw",
    "Đừng giao việc cho Openclaw",
    "Kiểm tra giá xăng",
  ])
    assert.equal(explicitlyRequestsOpenClaw(text), false, text);
});
test("analysis and fresh research requests require an enabled OpenClaw supporter", () => {
  for (const text of [
    "phân tích cổ phiếu VIC",
    "đánh giá nội dung báo cáo này",
    "tìm hiểu giá xăng hôm nay",
    "kiểm tra thông tin mới nhất về quy định",
    "tổng hợp và so sánh hai phương án",
  ])
    assert.equal(requiresOpenClawSupport(text), true, text);
  for (const text of ["chào em", "cảm ơn", "viết lời chào ngắn"])
    assert.equal(requiresOpenClawSupport(text), false, text);
});
