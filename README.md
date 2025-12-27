# GalaSwap Trading Bot

Advanced trading bot that uses GalaSwap API and Binance API to execute arbitrage opportunities between both exchanges.

## Features

- **Arbitrage Strategy**: Identifies and executes profitable arbitrage opportunities between GalaSwap and Binance
- **Basic Swap Accepter**: Accepts swaps at rates better than market rate
- **Basic Swap Creator**: Creates and manages liquidity-providing swaps

## Quick Start

### Prerequisites

- [Docker](https://www.docker.com/get-started/)
- GalaChain wallet address and private key
- Binance API credentials (for arbitrage strategy)

### Installation

1. Clone the repository:
```bash
git clone https://github.com/GalaChain/galaswap-bot.git
cd galaswap-bot
```

2. Create a `.env` file with your credentials:
```env
MONGO_PASSWORD=your_mongo_password
GALA_WALLET_ADDRESS=your_gala_wallet_address
GALA_PRIVATE_KEY=your_gala_private_key

# Binance API (required for arbitrage)
BINANCE_ENABLED=true
BINANCE_API_KEY=your_binance_api_key
BINANCE_API_SECRET=your_binance_api_secret

# Optional: Discord/Slack webhooks for notifications
DISCORD_WEBHOOK_URI=your_discord_webhook_uri
DISCORD_ALERT_WEBHOOK_URI=your_discord_alert_webhook_uri
```

3. Run the bot:
```bash
docker compose up --build -d
```

4. View logs:
```bash
docker logs -f trading_bot-galaswap--bot-1
```

## Arbitrage Strategy

The arbitrage strategy exploits price differences between GalaSwap and Binance by executing trades on both platforms simultaneously.

### How It Works

**Forward Arbitrage (GalaSwap → Binance)**:
- Sells GALA on GalaSwap for GUSDC/GWETH
- Buys GALA on Binance using received USDT/ETH
- Profits from price difference

**Reverse Arbitrage (Binance → GalaSwap)**:
- Buys GALA on Binance using USDT
- Sells GALA on GalaSwap for GUSDC
- Profits from price difference

### Features

- Automatic profit calculation (accounts for all fees)
- Dynamic trade sizing (tries multiple sizes to find best opportunity)
- Liquidity handling (auto-fallback to alternative pairs)
- Circuit breaker (skips illiquid pairs after failures)
- Profit-only execution (only executes when profit >= 1 GALA)

### Configuration

Edit `src/strategies/arbitrage/arbitrage_strategy.ts`:

- `GALA_AMOUNT`: Maximum GALA to trade (default: 5000)
- `MIN_PROFIT_GALA`: Minimum profit to execute (default: 1 GALA)
- `ALLOW_LOSS_TRADES`: Set to `false` for profit-only (default: `false`)
- `TRADE_SIZE_OPTIONS`: Trade sizes to try (default: [1000, 2000, 3000, 4000, 5000])

### Binance Setup

1. Create Binance account and enable API access
2. Create API key with **Spot Trading** permissions
3. Add credentials to `.env` file (see above)

### Important Notes

- GalaSwap and Binance use separate wallets/accounts
- Bot executes trades on both platforms to complete arbitrage cycle
- Fee calculation includes: GalaSwap fees (0.05-1.00%), Binance fees (0.1% market, 0.02% maker), gas fees (0.5 GALA)

## Configuration Files

Configure strategies in the `config/` directory:

- `basic_swap_accepter.json`: Conditions for accepting swaps
- `basic_swap_creator.json`: Swap creation parameters
- `token_config.json`: Token price limits and project tokens

See the config files for detailed parameter descriptions.

## Running the Bot

**Start:**
```bash
docker compose up --build -d
```

**Stop:**
```bash
docker compose down
```

**Restart:**
```bash
docker compose restart bot
```

## Development

For development, install Node.js (v20.x.x) and run:
```bash
npm install
```

Add strategies in `src/strategies/` and import them in `src/bot_main.ts`.

## Disclaimer

This bot is provided "as is" without warranties. Trading cryptocurrencies involves risk of loss. Gala Games does not provide financial advice. You are responsible for compliance with local laws and regulations. Use at your own risk.

By using this bot, you acknowledge that you have read and agree to the terms outlined in the [LICENSE](./LICENSE) file.
