export type PhoneControlState = {
  state: "connected" | "phone_setup_required";
  detail?: string;
};

/** Maps the phone's implementation-neutral health response to an AI-facing setup state. */
export function phoneControlState(health: Record<string, unknown>): PhoneControlState {
  return health.phone_control_ready === true
    ? { state: "connected" }
    : { state: "phone_setup_required", detail: "电脑 AI 已连接，请先在手机中完成控制准备。" };
}
