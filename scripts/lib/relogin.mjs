import { applyReach } from "./reach.mjs";

export async function withReloginNotice(event, input, config, output) {
  return applyReach(event, input, config, output);
}
