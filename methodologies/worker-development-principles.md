# Worker Development Principles

For software-project creation or substantial modification whose topology is not
fixed, choose the smallest maintainable structure that follows the selected
ecosystem's established conventions before the first mutation.

Separate independently evolving responsibilities into coherent modules or
artifacts, while keeping trivial or inseparable concerns together; choosing
this topology implements the assigned outcome and does not broaden it. Create
the complete set in dependency order, keep one source of truth for shared data
and behavior, and connect every part through explicit interfaces or references.
Do not choose `return_result` until all selected parts and their connections
exist.
