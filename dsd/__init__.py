"""DSD director core (self-contained, official-comfy-only).

Layering (docs/27):
  L0 resources  -> plain strings, no embedded weights
  L1 DSD plan   -> dsd-shots/1 JSON (validated by dsd/plan.py)
  L2 executor   -> stateless: plan + resources -> frames/audio/report
  L3 handoff    -> continue / guide / off, official noise_mask only
"""
from .plan import PlanError, load_plan, validate_plan
from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

__all__ = [
    "PlanError", "load_plan", "validate_plan",
    "NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS",
]
