// Copyright (C) 2026 Atrinik contributors
// GitHub supplies artifact runtime credentials only to this trusted Node action.
// The controller subprocess allowlists keep them out of selected source tooling.
import { runPromotionDelivery } from "./production-promotion.mjs";
process.exitCode = await runPromotionDelivery();
