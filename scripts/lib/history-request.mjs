import { completeHistorySync, pendingHistorySync } from "./backend-client.mjs";

/** The dashboard's pending request to upload this device's earlier history, or null. */
export async function historyRequest(config, deviceId, log) {
  const res = await pendingHistorySync(config, deviceId);
  if (res.ok) return res.requestedAt;
  log(`could not read the dashboard's history request (${res.reason}), syncing as usual`);
  return null;
}

/** Clears this user's progress and skipped hours once per request, so every earlier session-hour posts again. */
export function startHistory(state, requestedAt) {
  if (!requestedAt || state.history?.requestedAt === requestedAt) return false;
  state.sessions = {};
  delete state.skip;
  state.history = { requestedAt };
  return true;
}

export async function confirmHistory({ config, deviceId, state, report, requestedAt, log }) {
  if (!requestedAt || state.history?.requestedAt !== requestedAt || state.history.confirmed) return;
  if (report.left || report.failed) return;
  const res = await completeHistorySync(config, deviceId, requestedAt);
  if (res.ok) state.history.confirmed = true;
  log(
    res.ok
      ? "uploaded this device's earlier history as the dashboard asked"
      : `could not confirm the dashboard's history request (${res.reason}), retrying next run`
  );
}
