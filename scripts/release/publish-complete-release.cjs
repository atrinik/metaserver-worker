// Copyright (C) 2026 Atrinik contributors
"use strict";

// semantic-release owns version selection/tag creation. Its GitHub plugin first
// uploads to a draft; only this verifier may publish the completed release.
exports.publish = async function publish(_config, context) {
  const { publishCompleteRelease } = await import("./publish-complete-release.mjs");
  return publishCompleteRelease(context);
};
