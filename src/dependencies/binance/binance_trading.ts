import BigNumber from 'bignumber.js';
import { IBinanceApi, IBinanceOrder, IBinanceBalance, BinanceOrderSide, BinanceOrderType, IBinanceNewOrderParams } from './binance_api.js';
import { ILogger } from '../../types/types.js';

export interface IBinanceTrade {
  symbol: string;
  side: BinanceOrderSide;
  quantity: string;
  price?: string; // For limit orders
  type: BinanceOrderType;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
}

export interface IBinanceTradingConfig {
  enabled: boolean;
  minTradeAmount: number; // Minimum trade amount in quote currency (e.g., USDT)
  maxTradeAmount: number; // Maximum trade amount in quote currency
  defaultOrderType: BinanceOrderType;
  tradingPairs: readonly {
    baseAsset: string; // e.g., "GALA"
    quoteAsset: string; // e.g., "USDT"
    symbol: string; // e.g., "GALAUSDT"
    minNotional?: number; // Minimum order value
  }[];
}

export class BinanceTrading {
  constructor(
    private readonly binanceApi: IBinanceApi,
    private readonly config: IBinanceTradingConfig,
    private readonly logger?: ILogger,
  ) {}

  async getAvailableBalance(asset: string): Promise<BigNumber> {
    try {
      const balances = await this.binanceApi.getBalances();
      const balance = balances.get(asset);
      if (!balance) {
        return BigNumber(0);
      }
      return BigNumber(balance.free);
    } catch (err) {
      this.logger?.error({ message: `Failed to get Binance balance for ${asset}`, err });
      return BigNumber(0);
    }
  }

  async executeTrade(trade: IBinanceTrade): Promise<IBinanceOrder> {
    if (!this.config.enabled) {
      throw new Error('Binance trading is not enabled');
    }

    return this.executeTradeInternal(trade);
  }

  /**
   * Execute a trade for arbitrage purposes (bypasses enabled check)
   * This allows arbitrage strategy to execute trades even when general Binance trading is disabled
   */
  async executeTradeForArbitrage(trade: IBinanceTrade): Promise<IBinanceOrder> {
    this.logger?.info({
      message: 'Executing Binance trade for arbitrage (bypassing enabled check)',
      trade,
    });
    return this.executeTradeInternal(trade);
  }

  private async executeTradeInternal(trade: IBinanceTrade): Promise<IBinanceOrder> {
    // Validate trade amount
    const tradeAmount = trade.price
      ? BigNumber(trade.quantity).multipliedBy(trade.price)
      : BigNumber(trade.quantity);

    if (tradeAmount.isLessThan(this.config.minTradeAmount)) {
      throw new Error(
        `Trade amount ${tradeAmount.toString()} is below minimum ${this.config.minTradeAmount}`,
      );
    }

    if (tradeAmount.isGreaterThan(this.config.maxTradeAmount)) {
      throw new Error(
        `Trade amount ${tradeAmount.toString()} exceeds maximum ${this.config.maxTradeAmount}`,
      );
    }

    // Check balance
    const baseAsset = this.getBaseAsset(trade.symbol);
    const quoteAsset = this.getQuoteAsset(trade.symbol);

    if (trade.side === 'BUY') {
      const quoteBalance = await this.getAvailableBalance(quoteAsset);
      const requiredQuote = trade.price
        ? BigNumber(trade.quantity).multipliedBy(trade.price)
        : BigNumber(trade.quantity); // For market orders, quantity is in quote currency

      if (quoteBalance.isLessThan(requiredQuote)) {
        throw new Error(
          `Insufficient ${quoteAsset} balance. Required: ${requiredQuote.toString()}, Available: ${quoteBalance.toString()}`,
        );
      }
    } else {
      const baseBalance = await this.getAvailableBalance(baseAsset);
      if (baseBalance.isLessThan(trade.quantity)) {
        throw new Error(
          `Insufficient ${baseAsset} balance. Required: ${trade.quantity}, Available: ${baseBalance.toString()}`,
        );
      }
    }

    // Place order
    this.logger?.info({
      message: 'Placing Binance order',
      trade,
    });

    const orderParams: Omit<IBinanceNewOrderParams, 'timestamp'> = {
      symbol: trade.symbol,
      side: trade.side,
      type: trade.type,
    };

    if (trade.type === 'MARKET') {
      if (trade.side === 'BUY') {
        // For market buy, use quoteOrderQty (amount in quote currency)
        // Format quoteOrderQty to proper precision (usually 2-8 decimal places for USDT)
        orderParams.quoteOrderQty = this.formatQuantity(trade.quantity, 8);
      } else {
        // For market sell, use quantity (amount in base currency)
        // Format quantity based on symbol's stepSize
        orderParams.quantity = this.formatQuantityForSymbol(trade.quantity, trade.symbol);
      }
    } else if (trade.type === 'LIMIT') {
      if (!trade.price) {
        throw new Error('Price is required for limit orders');
      }
      orderParams.quantity = this.formatQuantityForSymbol(trade.quantity, trade.symbol);
      orderParams.price = this.formatPrice(trade.price, trade.symbol);
      orderParams.timeInForce = trade.timeInForce || 'GTC';
    }

    try {
      const order = await this.binanceApi.placeOrder(orderParams);
      this.logger?.info({
        message: 'Binance order placed successfully',
        orderId: order.orderId,
        symbol: order.symbol,
        side: order.side,
        status: order.status,
      });
      return order;
    } catch (err) {
      this.logger?.error({
        message: 'Failed to place Binance order',
        trade,
        err,
      });
      throw err;
    }
  }

  async cancelOrder(symbol: string, orderId: number): Promise<IBinanceOrder> {
    this.logger?.info({
      message: 'Canceling Binance order',
      symbol,
      orderId,
    });

    try {
      const canceledOrder = await this.binanceApi.cancelOrder(symbol, orderId);
      this.logger?.info({
        message: 'Binance order canceled successfully',
        orderId: canceledOrder.orderId,
        symbol: canceledOrder.symbol,
        status: canceledOrder.status,
      });
      return canceledOrder;
    } catch (err) {
      this.logger?.error({
        message: 'Failed to cancel Binance order',
        symbol,
        orderId,
        err,
      });
      throw err;
    }
  }

  async getOpenOrders(symbol?: string): Promise<readonly IBinanceOrder[]> {
    try {
      return await this.binanceApi.getOpenOrders(symbol);
    } catch (err) {
      this.logger?.error({
        message: 'Failed to get Binance open orders',
        symbol,
        err,
      });
      return [];
    }
  }

  private getBaseAsset(symbol: string): string {
    // Extract base asset from symbol (e.g., "GALA" from "GALAUSDT")
    const pair = this.config.tradingPairs.find((p) => p.symbol === symbol);
    return pair?.baseAsset || symbol.replace(/USDT|BTC|ETH|BNB$/, '');
  }

  private getQuoteAsset(symbol: string): string {
    // Extract quote asset from symbol (e.g., "USDT" from "GALAUSDT")
    const pair = this.config.tradingPairs.find((p) => p.symbol === symbol);
    return pair?.quoteAsset || 'USDT';
  }

  /**
   * Format quantity to proper precision based on symbol's stepSize
   * Common stepSizes: 1 (whole numbers), 0.1, 0.01, 0.001, etc.
   */
  private formatQuantityForSymbol(quantity: string, symbol: string): string {
    const qty = BigNumber(quantity);
    
    // Common stepSize values for popular pairs (fallback if exchange info not available)
    const stepSizeMap: Record<string, number> = {
      'GALAUSDT': 1,      // Whole numbers only
      'BTCUSDT': 0.00001, // 5 decimal places
      'ETHUSDT': 0.0001,  // 4 decimal places
      'BNBUSDT': 0.001,   // 3 decimal places
      'SOLUSDT': 0.01,    // 2 decimal places
      'ADAUSDT': 1,       // Whole numbers
      'DOGEUSDT': 1,      // Whole numbers
      'XRPUSDT': 1,       // Whole numbers
    };

    const stepSize = stepSizeMap[symbol] || 1; // Default to whole numbers if unknown
    
    // Calculate number of decimal places from stepSize
    const decimals = stepSize >= 1 ? 0 : Math.abs(Math.log10(stepSize));
    
    // Round down to nearest stepSize
    const rounded = BigNumber(Math.floor(qty.dividedBy(stepSize).toNumber())).multipliedBy(stepSize);
    
    return this.formatQuantity(rounded.toString(), decimals);
  }

  /**
   * Format quantity to specified decimal places (rounds down)
   */
  private formatQuantity(quantity: string, decimals: number): string {
    const qty = BigNumber(quantity);
    return qty.toFixed(decimals, BigNumber.ROUND_DOWN);
  }

  /**
   * Format price to proper precision (usually 2-8 decimal places)
   */
  private formatPrice(price: string, symbol: string): string {
    const priceNum = BigNumber(price);
    
    // Common price precision for popular pairs
    const pricePrecisionMap: Record<string, number> = {
      'GALAUSDT': 8,      // 8 decimal places
      'BTCUSDT': 2,       // 2 decimal places
      'ETHUSDT': 2,       // 2 decimal places
      'BNBUSDT': 2,       // 2 decimal places
      'SOLUSDT': 4,       // 4 decimal places
      'ADAUSDT': 6,       // 6 decimal places
      'DOGEUSDT': 8,      // 8 decimal places
      'XRPUSDT': 4,       // 4 decimal places
    };

    const precision = pricePrecisionMap[symbol] || 8; // Default to 8 if unknown
    return priceNum.toFixed(precision, BigNumber.ROUND_DOWN);
  }
}

