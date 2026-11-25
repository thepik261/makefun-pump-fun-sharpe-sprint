// Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins (agent-fun/replay/v2).
// A fresh-launch sniper tuned for hourly Sharpe ratio, not raw PnL: small
// equal stakes, quick take-profits, tight stops, a trailing stop once a trade
// is ahead, and a short hold budget so capital keeps cycling through many
// coins. The grader runs `node /bot/main.ts`. The strategy lives in
// strategy.ts and the SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored
// byte for byte in vendor/makefun-bot.ts.

import { runBot } from './vendor/makefun-bot.ts';
import { bot } from './strategy.ts';

await runBot(bot);
