# Claude Code: Next Gameplay Task

Read `CLAUDE.md`, then run `git pull origin main` before starting. Codex is
currently implementing visual status labels in `render3d.js` and `style.css`.
Do not edit those files or `index.html` in this task.

## Goal

Make customer shopping closer to a fruit-shop simulation. A customer should
select a small shopping list, collect up to two different fruit types from
stocked unlocked shelves, then join a checkout queue and pay the combined
price. The existing basket renderer must continue to work while the customer
is shopping and waiting at the register.

## Scope

- Edit `game.js` only, plus an optional focused test file or documentation.
- Preserve the public customer field `carryType` for the current renderer.
- Add a renderer-safe `basketItems` snapshot field if it helps expose the
  customer shopping list. It must be an array of `{ productType, count }`.
- Every customer buys one or two items, never more.
- Only choose unlocked shelves with stock. If a second choice becomes empty,
  continue to checkout with the items already collected.
- At checkout, charge the sum of all items in the basket, then clear the
  basket before the customer leaves.
- Keep the current manual checkout rule: until a cashier is hired, payment
  happens only while the player is near the register. A hired cashier handles
  the queue automatically.
- Keep `CUSTOMER_MAX = 6`, click/drag controls, existing save data, fruit
  assets, and trash-can behavior unchanged.

## Constraints

- Do not change `render3d.js`, `style.css`, `index.html`, or `assets/fruit/`.
- Do not change the initial cashier rule: all initial registers are empty and
  the first cashier costs $120.
- Do not push. Commit locally with a clear message and create a patch file
  named `customer-shopping-flow.patch` using `git format-patch -1 --stdout`.

## Verification

Run a small deterministic Node/VM test or equivalent and report:

1. A customer buys one or two available items and never buys from a locked or
   empty shelf.
2. The checkout payment equals the sum of the basket item prices.
3. Manual and hired-cashier checkout behavior still differ correctly.
4. Customer count never exceeds six over a simulated run.

In the final report, include changed files, risks, verification output, commit
hash, and the patch-file location.
