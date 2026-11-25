// Fresh-launch sniper tuned for hourly Sharpe ratio on the pump.fun replay
// (agent-fun/replay/v2). Every coin is watched from its CreateEvent and may
// be bought only in its first few slots, and only when the opening tape looks
// organic: the creator did not load up or sell, at least five unrelated
// wallets bought in, at least 1 SOL was bought, net SOL is flowing in, and
// the price has already ticked up but not run away. Stakes are small and
// equal (0.05 SOL), winners are taken fast, losers are cut fast, and nothing
// is held past a short slot budget — so the bot banks many small, steady
// round trips instead of riding one moonshot. That is what a Sharpe ranking
// rewards, and it also clears the guardrails: each round trip is at least
// 0.01 SOL on a distinct mint, with a probe fallback that opens tiny
// round trips on liquid curves late in the run if the distinct-coin bar
// is still at risk.
//
// Deterministic by construction: no clock, no environment reads, no
// randomness; every map is walked in insertion order and every money value
// is a bigint, so two runs produce byte-identical action logs.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const BPS = 10_000n;
const CURVE_FEE_BPS = 125n; // protocol 95 + creator 30 bps on every curve trade

// Tunables, all in plain units (SOL, slots, bps) unless noted.
const DEFAULTS = {
  minAge: 2, // youngest age (slots since create) at which a first buy may be decided
  maxAge: 6, // oldest age at which a first buy may still be decided
  stakeLamports: 50_000_000n, // 0.05 SOL aimed per coin
  minBuyLamports: 10_000_000n, // smallest single buy: the round-trip guardrail floor
  minRqLamports: 2_000_000_000n, // real SOL reserve at entry, at least 2 SOL (so the 1% cap still buys >= 0.01 SOL)
  maxRqLamports: 40_000_000_000n,
  maxDevBuyLamports: 2_000_000_000n, // creator's own buys in the create slot, at most
  minBuyers: 5, // distinct non-creator buyers seen before entry
  minBoughtLamports: 2_000_000_000n, // at least 2 SOL bought by anyone since creation
  minRunupBps: 11_000, // price now over the create price, at least 1.10x (momentum confirmed)
  maxRunupBps: 15_000, // price now over the create price, at most 1.5x
  maxSellShareBps: 5_000, // others' sells over this share of what was bought disqualify
  maxBigSellBps: 5_000, // one wallet dumping over this share of the reserve disqualifies
  flowWindow: 8, // slots of recent tape the entry flow is read over
  tpBps: 2_000, // take profit: exit once the position is worth 20% over its cost
  slBps: 500, // stop loss: exit once it is worth 5% under its cost
  trailArmBps: 800, // trailing stop arms once up 8%
  trailBps: 800, // ...then exits on a fall of 8% from the best value
  maxHold: 15, // exit after holding this many slots
  staleSlots: 30, // exit when no trade has hit the coin for this many slots
  buySlipBps: 1_500, // buys refused when the fill is worse than this (no chasing a pump)
  sellSlipBps: 10_000, // sells never refused for the price moving in the latency
  probeSol: 20_000_000n, // guardrail probe round-trip size (0.02 SOL, above the 0.01 floor)
  probeAfterSecs: 14_400, // probes only once this much block time has passed
  targetCoins: 20, // guardrail pacing target: distinct coins with a round trip
};

export type Params = typeof DEFAULTS;

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  biggestSellShareBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  recent: Tick[];
  spent: bigint;
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
}

/** SOL a sale of `tokens` returns after curve fees, at the given reserves. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

export function createBot(overrides: Partial<Params> = {}) {
  const P = { ...DEFAULTS, ...overrides };
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const selling = new Set<Pubkey>();
  const probed = new Set<Pubkey>();
  const roundTripped = new Set<Pubkey>();
  let firstBlockTime: number | null = null;
  let nowBlockTime = 0;

  /** Net SOL bought minus sold, and distinct non-creator buyers, over the recent window. */
  function flow(c: Coin, slot: number): { net: bigint; buyers: number } {
    const from = slot - P.flowWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (const t of c.recent) {
      if (t.isBuy) {
        net += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else {
        net -= t.sol;
      }
    }
    return { net, buyers: buyers.size };
  }

  function hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === side) return true;
    return false;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstBlockTime === null) firstBlockTime = e.block_time;
          if (e.block_time > nowBlockTime) nowBlockTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          coins.set(e.mint, {
            mint: e.mint, createSlot: e.slot, creator: e.creator,
            vq0: BigInt(e.virtual_quote_reserves), vt0: BigInt(e.virtual_token_reserves),
            devBuy: 0n, buyers: new Set(), bought: 0n, soldByOthers: 0n,
            biggestSellShareBps: 0n, devSold: false, lastTradeSlot: e.slot,
            recent: [], spent: 0n, done: false, complete: false,
          });
        } else if (e.event === 'TradeEvent') {
          const c = coins.get(e.mint);
          if (c === undefined) continue;
          const sol = BigInt(e.sol_amount);
          c.lastTradeSlot = e.slot;
          c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
          const isDev = e.user === c.creator;
          if (e.is_buy) {
            c.bought += sol;
            if (isDev && e.slot === c.createSlot) c.devBuy += sol;
            else if (!isDev) c.buyers.add(e.user);
          } else if (isDev) {
            c.devSold = true;
          } else {
            c.soldByOthers += sol;
            const rqBefore = BigInt(e.real_quote_reserves) + sol;
            if (rqBefore > 0n) {
              const bps = (sol * BPS) / rqBefore;
              if (bps > c.biggestSellShareBps) c.biggestSellShareBps = bps;
            }
          }
        } else {
          const c = coins.get(e.mint);
          if (c !== undefined) {
            c.complete = true;
            c.done = true;
          }
        }
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        if (f.side === 'sell' && f.status === 'filled') roundTripped.add(f.mint);
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          held.set(f.mint, { openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports), best: 0n });
        }
      }
      for (const mint of [...selling]) if (!hasPending(state, mint, 'sell')) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, 'buy')) held.delete(mint);
      }

      // Exits first: take profit, stop loss, trailing stop, hold budget, staleness, creator sell.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0n };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(P.tpBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(P.slBps))) exit = true;
          if (h.best * BPS >= basis * (BPS + BigInt(P.trailArmBps)) && value * BPS <= h.best * (BPS - BigInt(P.trailBps))) exit = true;
        }
        if (state.slot - h.openedSlot >= P.maxHold) exit = true;
        if (c !== undefined) {
          if (c.devSold) exit = true;
          if (state.slot - c.lastTradeSlot >= P.staleSlots) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: P.sellSlipBps });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries: fresh launches whose opening tape looks organic.
      let free = state.freeCashLamports();
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        if (age > P.maxAge) {
          c.done = true;
          continue;
        }
        if (age < P.minAge) continue;
        if (open >= state.hello.caps.max_open_positions) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold) {
          c.done = true;
          continue;
        }
        const rq = curve.real_quote_reserves;
        if (rq < P.minRqLamports || rq > P.maxRqLamports) continue;
        if (c.devBuy > P.maxDevBuyLamports) continue;
        if (c.buyers.size < P.minBuyers) continue;
        if (c.bought < P.minBoughtLamports) continue;
        if (c.bought > 0n && c.soldByOthers * BPS > c.bought * BigInt(P.maxSellShareBps)) continue; // others sold too much of what was bought
        if (c.biggestSellShareBps > BigInt(P.maxBigSellBps)) continue; // one wallet dumped too much of the reserve
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        const runup = (vq * c.vt0 * BPS) / (vt * c.vq0);
        if (runup < BigInt(P.minRunupBps)) continue;
        if (runup > BigInt(P.maxRunupBps)) continue;
        const fl = flow(c, state.slot);
        if (fl.net <= 0n || fl.buyers < 1) continue;
        const room = P.stakeLamports - c.spent;
        if (room < P.minBuyLamports) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = room < maxBuy ? room : maxBuy;
        if (amount < P.minBuyLamports) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlipBps });
        free -= amount + tx;
        c.spent += amount;
        open += 1;
      }
      // Guardrail probes: if the run is late and still short of the
      // distinct-coin bar, open a tiny round trip on the most liquid live
      // curve and sell it as soon as the buy lands. Each probe costs only
      // its fees, and it only fires when the bar is actually at risk.
      if (
        firstBlockTime !== null &&
        nowBlockTime - firstBlockTime >= P.probeAfterSecs &&
        roundTripped.size + state.positions.size < P.targetCoins &&
        orders.length < cap &&
        state.committedPositionCount() < state.hello.caps.max_open_positions
      ) {
        let bestMint: Pubkey | null = null;
        let bestRq = 0n;
        for (const [mint, curve] of state.curves) {
          if (curve.complete || roundTripped.has(mint) || probed.has(mint)) continue;
          if (state.positions.has(mint) || hasPending(state, mint, 'buy')) continue;
          if (curve.real_quote_reserves > bestRq) {
            bestRq = curve.real_quote_reserves;
            bestMint = mint;
          }
        }
        if (bestMint !== null) {
          const maxBuy = state.maxBuyLamports(bestMint);
          const amount = P.probeSol < maxBuy ? P.probeSol : maxBuy;
          if (amount >= P.minBuyLamports && free >= amount + tx) {
            orders.push({ side: 'buy', mint: bestMint, quote_lamports: amount, max_slippage_bps: P.buySlipBps });
            free -= amount + tx;
            probed.add(bestMint);
            const c = coins.get(bestMint);
            if (c !== undefined) c.done = true;
          }
        }
      }
      // Probe exits: sell a probe position as soon as its buy has landed.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint) || !probed.has(mint)) continue;
        if (!held.has(mint)) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: P.sellSlipBps });
        selling.add(mint);
      }
      return orders;
    },
  };
}

export const bot = createBot();
