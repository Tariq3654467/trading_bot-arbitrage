import { MongoAcceptedSwapStore } from '../../dependencies/accepted_swap_store.js';
import { MongoCreatedSwapStore } from '../../dependencies/created_swap_store.js';
import {
  IGalaSwapApi,
  IGalaSwapToken,
  IRawSwap,
  ITokenBalance,
} from '../../dependencies/galaswap/types.js';
import { MongoPriceStore } from '../../dependencies/price_store.js';
import { IStatusReporter } from '../../dependencies/status_reporters.js';
import { ILogger } from '../../types/types.js';
import { ISwapStrategy } from '../swap_strategy.js';

interface IBinanceTradingPairConfig {
  baseAsset: string; // e.g., "GALA"
  quoteAsset: string; // e.g., "USDT"
  symbol: string; // e.g., "GALAUSDT"
  tradeAmount: number; // Trade amount in quote currency (e.g., 10 for $10)
  minNotional?: number; // Minimum order value
}

interface IBinanceTradingStrategyConfig {
  enabled: boolean;
  defaultTradeAmount: number; // Default trade amount in quote currency (e.g., 10 for $10)
  tradingPairs: IBinanceTradingPairConfig[]; // Array of trading pairs
  minPriceChangePercent?: number; // Minimum price change to trigger trade (optional)
  maxTradesPerHour?: number; // Rate limiting per pair (optional)
}

const defaultConfig: IBinanceTradingStrategyConfig = {
  enabled: true,
  defaultTradeAmount: 10, // $10 trades by default
  tradingPairs: [
    {
      baseAsset: 'GALA',
      quoteAsset: 'USDT',
      symbol: 'GALAUSDT',
      tradeAmount: 10,
      minNotional: 10,
    },
  ],
  minPriceChangePercent: 0, // No minimum price change required for testing
  maxTradesPerHour: 10, // Max 10 trades per hour per pair
};

// For testing: set to true to execute one trade immediately (bypasses cooldown)
// ⚠️ PRODUCTION: Set to false to enforce proper cooldowns
const FORCE_TEST_TRADE = false;

export class BinanceTradingStrategy implements ISwapStrategy {
  private lastTradeTime: Map<string, number> = new Map(); // Key: "symbol-SIDE" (e.g., "GALAUSDT-BUY")
  private tradesThisHour: Map<string, number> = new Map(); // Key: symbol, value: trade count
  private hourStartTime: number = Date.now();

  constructor(private readonly config: IBinanceTradingStrategyConfig = defaultConfig) {}

  async doTick(
    logger: ILogger,
    reporter: IStatusReporter,
    _selfUserId: string,
    _galaSwapApi: IGalaSwapApi,
    _createdSwapStore: MongoCreatedSwapStore,
    _acceptedSwapStore: MongoAcceptedSwapStore,
    _priceStore: MongoPriceStore,
    _ownBalances: readonly Readonly<ITokenBalance>[],
    _ownSwaps: readonly Readonly<IRawSwap>[],
    _tokenValues: readonly Readonly<IGalaSwapToken>[],
    options: {
      now?: Date;
      binanceApi?: import('../../dependencies/binance/binance_api.js').IBinanceApi | null;
      binanceTrading?: import('../../dependencies/binance/binance_trading.js').BinanceTrading | null;
      galaChainRouter?: import('../../dependencies/onchain/galachain_router.js').GalaChainRouter | null;
    },
  ): ReturnType<ISwapStrategy['doTick']> {
    // Always log that we're being called, even if disabled
    logger.info({
      enabled: this.config.enabled,
      strategyName: 'BinanceTradingStrategy',
    }, 'Binance trading strategy doTick called');

    if (!this.config.enabled) {
      logger.info('Binance trading strategy is disabled in config');
      return {
        swapsToTerminate: [],
        swapsToCreate: [],
        swapsToAccept: [],
      };
    }

    logger.info({
      enabled: this.config.enabled,
      tradingPairs: this.config.tradingPairs.length,
      defaultTradeAmount: this.config.defaultTradeAmount,
      hasBinanceTrading: !!options.binanceTrading,
      hasBinanceApi: !!options.binanceApi,
    }, 'Binance trading strategy tick started');

    if (!options.binanceTrading) {
      logger.warn('Binance trading not available in options - ensure BINANCE_ENABLED=true and API keys are set');
      return {
        swapsToTerminate: [],
        swapsToCreate: [],
        swapsToAccept: [],
      };
    }

    if (!options.binanceApi) {
      logger.warn('Binance API not available in options');
      return {
        swapsToTerminate: [],
        swapsToCreate: [],
        swapsToAccept: [],
      };
    }

    // Reset hourly trade counters if an hour has passed
    const now = Date.now();
    if (now - this.hourStartTime >= 3600000) {
      this.tradesThisHour.clear();
      this.hourStartTime = now;
      logger.info({ message: 'Binance trading hourly counters reset' });
    }

    // Process each trading pair
    for (const pair of this.config.tradingPairs) {
      try {
        // Check rate limiting for this pair
        const tradesThisHourForPair = this.tradesThisHour.get(pair.symbol) || 0;
        if (this.config.maxTradesPerHour && tradesThisHourForPair >= this.config.maxTradesPerHour) {
          logger.info({
            symbol: pair.symbol,
            tradesThisHour: tradesThisHourForPair,
            maxTradesPerHour: this.config.maxTradesPerHour,
          }, 'Binance trading rate limit reached for pair, skipping');
          continue;
        }

        const tradeAmount = pair.tradeAmount || this.config.defaultTradeAmount;

        // Get balances for this pair
        const quoteBalance = await options.binanceTrading.getAvailableBalance(pair.quoteAsset);
        const baseBalance = await options.binanceTrading.getAvailableBalance(pair.baseAsset);

        // Get current price
        const currentPrice = await options.binanceApi.getPrice(pair.symbol);
        if (!currentPrice) {
          logger.warn({ symbol: pair.symbol }, 'Could not get Binance price, skipping pair');
          continue;
        }

        const priceValue = Number(currentPrice.price);

        logger.info({
          symbol: pair.symbol,
          baseAsset: pair.baseAsset,
          quoteAsset: pair.quoteAsset,
          currentPrice: priceValue,
          baseBalance: baseBalance.toString(),
          quoteBalance: quoteBalance.toString(),
          tradeAmount,
        }, 'Processing Binance trading pair');

        // Execute BUY trade
        const buyKey = `${pair.symbol}-BUY`;
        const lastBuyTime = this.lastTradeTime.get(buyKey) || 0;
        const timeSinceLastBuy = now - lastBuyTime;
        const canBuy = quoteBalance.isGreaterThanOrEqualTo(tradeAmount);
        const buyCooldownPassed = FORCE_TEST_TRADE && tradesThisHourForPair === 0
          ? true
          : timeSinceLastBuy >= 300000; // 5 minutes cooldown

        if (canBuy && buyCooldownPassed) {
          try {
            logger.info({
              symbol: pair.symbol,
              side: 'BUY',
              tradeAmount,
              quoteAsset: pair.quoteAsset,
            }, 'Executing Binance BUY trade');

            const buyOrder = await options.binanceTrading.executeTrade({
              symbol: pair.symbol,
              side: 'BUY',
              type: 'MARKET',
              quantity: String(tradeAmount), // For MARKET BUY, this is quote currency amount
            });

            this.lastTradeTime.set(buyKey, now);
            this.tradesThisHour.set(pair.symbol, tradesThisHourForPair + 1);

            logger.info({
              orderId: buyOrder.orderId,
              symbol: buyOrder.symbol,
              side: buyOrder.side,
              status: buyOrder.status,
              executedQty: buyOrder.executedQty,
            }, 'Binance BUY order executed successfully');

            await reporter.sendAlert(
              `Binance BUY: ${buyOrder.executedQty} ${pair.baseAsset} for ${tradeAmount} ${pair.quoteAsset} (${pair.symbol}, Order ID: ${buyOrder.orderId})`,
            );
          } catch (error) {
            logger.error({ error, symbol: pair.symbol, side: 'BUY' }, 'Failed to execute Binance BUY trade');
          }
        }

        // Execute SELL trade
        const baseAmountForTrade = tradeAmount / priceValue;
        const sellKey = `${pair.symbol}-SELL`;
        const lastSellTime = this.lastTradeTime.get(sellKey) || 0;
        const timeSinceLastSell = now - lastSellTime;
        const canSell = baseBalance.isGreaterThanOrEqualTo(baseAmountForTrade);
        const sellCooldownPassed = FORCE_TEST_TRADE && tradesThisHourForPair === 0 && !this.lastTradeTime.has(buyKey)
          ? true
          : timeSinceLastSell >= 300000; // 5 minutes cooldown

        if (canSell && sellCooldownPassed) {
          try {
            logger.info({
              symbol: pair.symbol,
              side: 'SELL',
              baseAmount: baseAmountForTrade,
              quoteValue: tradeAmount,
              quoteAsset: pair.quoteAsset,
            }, 'Executing Binance SELL trade');

            const sellOrder = await options.binanceTrading.executeTrade({
              symbol: pair.symbol,
              side: 'SELL',
              type: 'MARKET',
              quantity: String(baseAmountForTrade), // For MARKET SELL, this is base currency amount
            });

            this.lastTradeTime.set(sellKey, now);
            this.tradesThisHour.set(pair.symbol, tradesThisHourForPair + 1);

            logger.info({
              orderId: sellOrder.orderId,
              symbol: sellOrder.symbol,
              side: sellOrder.side,
              status: sellOrder.status,
              executedQty: sellOrder.executedQty,
            }, 'Binance SELL order executed successfully');

            await reporter.sendAlert(
              `Binance SELL: ${sellOrder.executedQty} ${pair.baseAsset} for ~${tradeAmount} ${pair.quoteAsset} (${pair.symbol}, Order ID: ${sellOrder.orderId})`,
            );
          } catch (error) {
            logger.error({ error, symbol: pair.symbol, side: 'SELL' }, 'Failed to execute Binance SELL trade');
          }
        }
      } catch (error) {
        logger.error({ error, symbol: pair.symbol }, 'Error processing Binance trading pair');
      }
    }

    // This strategy doesn't create/accept/terminate GalaSwap swaps
    return {
      swapsToTerminate: [],
      swapsToCreate: [],
      swapsToAccept: [],
    };
  }
}

