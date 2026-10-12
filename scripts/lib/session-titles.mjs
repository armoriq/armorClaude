import armoriqSdk from "@armoriq/sdk-dev";

const { claudeSessionTitle, MAX_BATCH_SNAPSHOTS } = armoriqSdk;
const MAX_TITLE_LENGTH = 200;

function cut(title) {
  const head = title.slice(0, MAX_TITLE_LENGTH);
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}

export const sameTitle = (a, b) => a?.title === b?.title && a?.titleUpdatedAt === b?.titleUpdatedAt;

export function sessionTitle(transcript, sessionId, seen, now = Date.now()) {
  const found = claudeSessionTitle(transcript);
  if (!found) return null;
  const title = cut(found.title);
  const firstSeen = seen?.title === title ? seen.titleUpdatedAt : new Date(now).toISOString();
  return {
    sessionId,
    title,
    titleSource: found.titleSource,
    titleUpdatedAt: found.titleUpdatedAt ?? firstSeen,
  };
}

export const markTitle = (state, sent) =>
  sameTitle(state.title, sent) ? { ...state, title: { ...state.title, sent: true } } : state;

export function titleBatches(titles) {
  const groups = [];
  for (let i = 0; i < titles.length; i += MAX_BATCH_SNAPSHOTS) {
    groups.push(titles.slice(i, i + MAX_BATCH_SNAPSHOTS));
  }
  return groups;
}
