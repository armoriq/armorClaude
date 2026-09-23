"use strict";
// Vendored from @armoriq/sdk-dev 0.6.10 (dist/observability). SDK 0.8.x
// replaced this recorder with OtelSession; ArmorClaude keeps shipping the same
// JSON spans to POST /observability/spans until that port is done.
const recorder = require("./recorder.cjs");
const handle = require("./handle.cjs");
const schema = require("./schema.cjs");
module.exports = {
  ObservabilityRecorder: recorder.ObservabilityRecorder,
  __setObservabilitySinkForTests: recorder.__setObservabilitySinkForTests,
  startTrace: handle.startTrace,
  openSpan: handle.openSpan,
  closeSpan: handle.closeSpan,
  endTrace: handle.endTrace,
  recordPolicyCall: handle.recordPolicyCall,
  flushObservability: handle.flushObservability,
  isValidUuid: schema.isValidUuid,
};
