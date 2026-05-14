"""
Per-million-token pricing in cents — mirror packages/spec/src/pricing.ts.

Kept in sync with the TS table on purpose: a step priced by the Python
SDK should match the same step priced by ``spool inspect`` to the cent.
Unknown models fall back to ``PRICING_FALLBACK`` and the step is tagged
``cost:approx``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple


@dataclass(frozen=True)
class ModelPricing:
    model: str
    input_per_million_cents: float
    output_per_million_cents: float
    cached_read_per_million_cents: float
    # 5-minute ephemeral cache writes (~1.25× input)
    cache_creation_per_million_cents: float
    # 1-hour ephemeral cache writes (~2× input)
    cache_creation_1h_per_million_cents: Optional[float] = None


PRICING: List[ModelPricing] = [
    ModelPricing("claude-opus-4-7", 1500, 7500, 150, 1875, 3000),
    ModelPricing("claude-opus-4-6", 1500, 7500, 150, 1875, 3000),
    ModelPricing("claude-opus-4-5", 1500, 7500, 150, 1875, 3000),
    ModelPricing("claude-sonnet-4-6", 300, 1500, 30, 375, 600),
    ModelPricing("claude-sonnet-4-5", 300, 1500, 30, 375, 600),
    ModelPricing("claude-haiku-4-5-20251001", 80, 400, 8, 100, 160),
]

PRICING_FALLBACK = ModelPricing("unknown", 1500, 7500, 150, 1875, 3000)


def pricing_for(model: str) -> Tuple[ModelPricing, bool]:
    """Return ``(pricing, approx)``. ``approx=True`` when fallback is used."""
    for row in PRICING:
        if model == row.model or model.startswith(row.model):
            return row, False
    return PRICING_FALLBACK, True


def cost_cents(model: str, usage: Dict[str, int]) -> Tuple[float, bool]:
    """
    Compute fractional-cent cost for one step from a token-usage breakdown.

    ``usage`` keys: ``input``, ``output``, ``cached_read``,
    ``cache_creation`` (5m), ``cache_creation_1h`` (optional).

    The 1h cache rate falls back to 2× input price when a model entry
    doesn't specify it explicitly — same formula as the TS side.
    """
    pricing, approx = pricing_for(model)
    cache1h_rate = (
        pricing.cache_creation_1h_per_million_cents
        if pricing.cache_creation_1h_per_million_cents is not None
        else pricing.input_per_million_cents * 2
    )
    cost = (
        (usage.get("input", 0) * pricing.input_per_million_cents) / 1_000_000
        + (usage.get("output", 0) * pricing.output_per_million_cents) / 1_000_000
        + (usage.get("cached_read", 0) * pricing.cached_read_per_million_cents)
        / 1_000_000
        + (
            usage.get("cache_creation", 0)
            * pricing.cache_creation_per_million_cents
        )
        / 1_000_000
        + (usage.get("cache_creation_1h", 0) * cache1h_rate) / 1_000_000
    )
    return cost, approx
