import BigNumber from 'bignumber.js';
import { MongoAcceptedSwapStore } from '../../dependencies/accepted_swap_store.js';
import { IBinanceApi } from '../../dependencies/binance/binance_api.js';
import { BinanceTrading } from '../../dependencies/binance/binance_trading.js';
import { MongoCreatedSwapStore } from '../../dependencies/created_swap_store.js';
import {
  IGalaSwapApi,
  IGalaSwapToken,
  IRawSwap,
  ITokenBalance,
} from '../../dependencies/galaswap/types.js';
import { GalaChainRouter } from '../../dependencies/onchain/galachain_router.js';
import { MongoPriceStore } from '../../dependencies/price_store.js';
import { IStatusReporter } from '../../dependencies/status_reporters.js';
import { ILogger } from '../../types/types.js';
import { ISwapStrategy, ISwapToAccept, ISwapToCreate, ISwapToTerminate } from '../swap_strategy.js';

/**
 * Spatial Arbitrage Strategy
 * 
 * Goal: Find price differences between GalaSwap and Binance to net 10-30 GALA profit
 * 
 * Strategy:
 * 1. Sell GALA on GalaSwap for GWETH
 * 2. Convert GWETH value to ETH value
 * 3. Buy GALA on Binance with that ETH value
 * 4. Net profit = (GALA received on Binance) - (GALA sold on GalaSwap) - (Fees)
 * 
 * Execution: Only execute if profit >= MIN_PROFIT_GALA (default: 1 GALA)
 */
export class ArbitrageStrategy implements ISwapStrategy {
  private readonly GALA_AMOUNT: number = 5000; // Maximum amount of GALA to trade
  private readonly MIN_PROFIT_GALA: number = 1; // Minimum profit in GALA to execute (any positive profit)
  private readonly MAX_PROFIT_GALA: number = 30; // Maximum expected profit
  private readonly BINANCE_FEE_RATE: number = 0.001; // 0.1% trading fee
  private readonly GALA_SWAP_FEE_RATE: number = 0.003; // 0.3% swap fee (estimate)
  private readonly GAS_FEE_GALA: number = 1; // Estimated gas fee in GALA (reduced from 5 - actual gas is typically < 1 GALA)
  private readonly MIN_GALA_AMOUNT: number = 1000; // Minimum amount to attempt (to avoid CONFLICT errors)
  // Try different trade sizes to find profitable opportunities (smaller sizes = less slippage)
  private readonly TRADE_SIZE_OPTIONS: number[] = [1000, 2000, 3000, 4000, 5000]; // Try smaller sizes first
  
  // Alternative pairs to try if GALA/GWETH has insufficient liquidity
  private readonly ALTERNATIVE_PAIRS = [
    { galaToken: 'GALA', receivingToken: 'GUSDC', binanceSymbol: 'GALAUSDT', description: 'GALA/GUSDC → GALA/USDT' },
    { galaToken: 'GALA', receivingToken: 'GUSDT', binanceSymbol: 'GALAUSDT', description: 'GALA/GUSDT → GALA/USDT' },
  ];
  
  private lastArbitrageCheck: number = 0;
  private readonly ARBITRAGE_CHECK_INTERVAL: number = 60000; // Check every 60 seconds

  async doTick(
    logger: ILogger,
    reporter: IStatusReporter,
    _selfUserId: string,
    _galaSwapApi: IGalaSwapApi,
    _createdSwapStore: MongoCreatedSwapStore,
    _acceptedSwapStore: MongoAcceptedSwapStore,
    _priceStore: MongoPriceStore,
    ownBalances: readonly Readonly<ITokenBalance>[],
    _ownSwaps: readonly Readonly<IRawSwap>[],
    _tokenValues: readonly Readonly<IGalaSwapToken>[],
    options: {
      now?: Date;
      binanceApi?: IBinanceApi | null;
      binanceTrading?: BinanceTrading | null;
      galaDeFiApi?: any;
      galaChainRouter?: GalaChainRouter | null;
    },
  ): Promise<{
    swapsToTerminate: readonly Readonly<ISwapToTerminate>[];
    swapsToAccept: readonly Readonly<ISwapToAccept>[];
    swapsToCreate: readonly Readonly<ISwapToCreate>[];
  }> {
    const now = options.now?.getTime() || Date.now();
    
    // Rate limit arbitrage checks
    if (now - this.lastArbitrageCheck < this.ARBITRAGE_CHECK_INTERVAL) {
      return {
        swapsToTerminate: [],
        swapsToAccept: [],
        swapsToCreate: [],
      };
    }
    
    this.lastArbitrageCheck = now;

    // Check if required dependencies are available
    if (!options.binanceApi || !options.binanceTrading || !options.galaChainRouter) {
      logger.debug(
        {
          hasBinanceApi: !!options.binanceApi,
          hasBinanceTrading: !!options.binanceTrading,
          hasGalaChainRouter: !!options.galaChainRouter,
        },
        'Arbitrage strategy: missing required dependencies',
      );
      return {
        swapsToTerminate: [],
        swapsToAccept: [],
        swapsToCreate: [],
      };
    }
    
    logger.debug('Arbitrage strategy: checking for opportunities');

    // Check if we have enough GALA balance
    const galaBalance = ownBalances.find((b) => b.collection === 'GALA');
    const availableGala = galaBalance ? BigNumber(galaBalance.quantity) : BigNumber(0);
    
    // Use available balance, but ensure it meets minimum requirements
    const tradeAmount = BigNumber.min(availableGala, BigNumber(this.GALA_AMOUNT)).toNumber();
    
    if (!galaBalance || availableGala.isLessThan(this.MIN_GALA_AMOUNT)) {
      logger.debug(
        {
          availableBalance: availableGala.toString(),
          minRequired: this.MIN_GALA_AMOUNT,
          configuredAmount: this.GALA_AMOUNT,
        },
        'Arbitrage strategy: insufficient GALA balance (below minimum)',
      );
      return {
        swapsToTerminate: [],
        swapsToAccept: [],
        swapsToCreate: [],
      };
    }
    
    logger.info(
      {
        availableBalance: availableGala.toString(),
        configuredAmount: this.GALA_AMOUNT,
      },
      'Arbitrage strategy: checking opportunity with available balance',
    );

    try {
      // Try different trade sizes (smaller first to reduce slippage)
      // Sort sizes in ascending order and filter to available balance
      const validSizes = this.TRADE_SIZE_OPTIONS
        .filter(size => size <= availableGala.toNumber() && size >= this.MIN_GALA_AMOUNT)
        .sort((a, b) => a - b);
      
      let bestOpportunity: {
        receivingTokenAmount: number;
        galaBuyableOnBinance: number;
        totalFees: number;
        netProfit: number;
        pair: string;
        tradeAmount: number;
        direction?: 'GalaSwap->Binance' | 'Binance->GalaSwap';
      } | null = null;

      // Track all opportunities for summary logging
      const allOpportunities: Array<{
        tradeSize: number;
        netProfit: number;
        pair: string;
        direction: string;
      }> = [];

      // Try each trade size to find the most profitable opportunity
      for (const tradeSize of validSizes) {
        logger.debug(
          {
            tradeSize,
            availableBalance: availableGala.toString(),
          },
          'Trying arbitrage with trade size',
        );

        // Try GALA/GWETH first (primary pair)
        // Note: GWETH pool has very low liquidity, so we try smaller amounts first
        let arbitrageOpportunity = await this.checkArbitrageOpportunity(
          logger,
          options.binanceApi,
          options.galaChainRouter,
          tradeSize,
          'GALA',
          'GWETH',
          'GALAETH',
          'ETHUSDT',
        );

        // If GALA/GWETH fails due to liquidity, try even smaller amounts for GWETH
        // GWETH pool has very low liquidity, so we need to try smaller sizes
        if (!arbitrageOpportunity && tradeSize >= 500) {
          const smallerSizes = [100, 200, 300, 400, 500].filter(s => s <= availableGala.toNumber() && s < tradeSize);
          for (const smallerSize of smallerSizes) {
            logger.debug(
              {
                originalSize: tradeSize,
                tryingSmaller: smallerSize,
                reason: 'GWETH pool has low liquidity, trying smaller amount',
              },
              'Trying smaller trade size for GWETH due to liquidity constraints',
            );
            
            arbitrageOpportunity = await this.checkArbitrageOpportunity(
              logger,
              options.binanceApi,
              options.galaChainRouter,
              smallerSize,
              'GALA',
              'GWETH',
              'GALAETH',
              'ETHUSDT',
            );
            
            if (arbitrageOpportunity) {
              logger.info(
                {
                  originalSize: tradeSize,
                  successfulSize: smallerSize,
                  reason: 'GWETH pool can only handle smaller trades',
                },
                'Found GWETH opportunity with smaller trade size',
              );
              break; // Found a working size, stop trying smaller ones
            }
          }
        }

        // If GALA/GWETH still fails due to liquidity, try alternative pairs
        if (!arbitrageOpportunity) {
          for (const pair of this.ALTERNATIVE_PAIRS) {
            logger.debug(
              {
                pair: pair.description,
                tradeSize,
              },
              'Trying alternative arbitrage pair due to GALA/GWETH liquidity issues',
            );
            
            arbitrageOpportunity = await this.checkArbitrageOpportunity(
              logger,
              options.binanceApi,
              options.galaChainRouter,
              tradeSize,
              pair.galaToken,
              pair.receivingToken,
              pair.binanceSymbol,
              'USDT', // For stablecoins, we use USDT directly
            );
            
            if (arbitrageOpportunity) {
              logger.info(
                {
                  pair: pair.description,
                  netProfit: arbitrageOpportunity.netProfit,
                  tradeSize,
                },
                'Found arbitrage opportunity with alternative pair',
              );
              break; // Found a working pair, stop trying others
            }
          }
        }

        // Track all opportunities (even unprofitable ones) for summary
        if (arbitrageOpportunity) {
          allOpportunities.push({
            tradeSize,
            netProfit: arbitrageOpportunity.netProfit,
            pair: arbitrageOpportunity.pair,
            direction: 'GalaSwap->Binance',
          });
        }

        // If we found a profitable opportunity, compare it with the best one so far
        if (arbitrageOpportunity && arbitrageOpportunity.netProfit > 0) {
          if (!bestOpportunity || arbitrageOpportunity.netProfit > bestOpportunity.netProfit) {
            bestOpportunity = {
              ...arbitrageOpportunity,
              tradeAmount: tradeSize,
              direction: 'GalaSwap->Binance',
            };
            logger.info(
              {
                tradeSize,
                netProfit: arbitrageOpportunity.netProfit,
                pair: arbitrageOpportunity.pair,
                direction: 'GalaSwap->Binance',
              },
              'Found profitable arbitrage opportunity',
            );
          }
        }
      }

      // Check reverse direction: Binance -> GalaSwap (if GALA is cheaper on Binance)
      // This requires USDT balance on Binance, so we'll check that first
      try {
        const binanceBalances = await options.binanceApi.getBalances();
        const usdtBalance = binanceBalances.get('USDT');
        const availableUsdt = usdtBalance ? parseFloat(usdtBalance.free) : 0;
          
        if (availableUsdt >= 10) { // Need at least $10 USDT to try reverse arbitrage
          logger.debug(
            {
              availableUsdt: availableUsdt.toFixed(2),
            },
            'Checking reverse arbitrage direction (Binance->GalaSwap)',
          );

          // Try reverse direction for each trade size
          for (const tradeSize of validSizes) {
            // Calculate how much USDT we need for this trade size
            const galaPriceResponse = await options.binanceApi.getPrice('GALAUSDT');
            if (!galaPriceResponse) continue;
            
            const galaPriceUsdt = Number(galaPriceResponse.price);
            const usdtNeeded = tradeSize * galaPriceUsdt;
            
            if (usdtNeeded > availableUsdt) continue; // Skip if not enough USDT

            // Check reverse arbitrage: Buy GALA on Binance, sell on GalaSwap
            const reverseOpportunity = await this.checkReverseArbitrageOpportunity(
              logger,
              options.binanceApi,
              options.galaChainRouter,
              tradeSize,
              usdtNeeded,
            );

            if (reverseOpportunity) {
              allOpportunities.push({
                tradeSize,
                netProfit: reverseOpportunity.netProfit,
                pair: reverseOpportunity.pair,
                direction: 'Binance->GalaSwap',
              });

              if (reverseOpportunity.netProfit > 0) {
                if (!bestOpportunity || reverseOpportunity.netProfit > bestOpportunity.netProfit) {
                  bestOpportunity = {
                    ...reverseOpportunity,
                    tradeAmount: tradeSize,
                    direction: 'Binance->GalaSwap',
                  };
                  logger.info(
                    {
                      tradeSize,
                      netProfit: reverseOpportunity.netProfit,
                      pair: reverseOpportunity.pair,
                      direction: 'Binance->GalaSwap',
                    },
                    'Found profitable reverse arbitrage opportunity',
                  );
                }
              }
            }
          }
        } else {
          logger.debug(
            {
              availableUsdt: availableUsdt.toFixed(2),
              minRequired: 10,
            },
            'Skipping reverse arbitrage: insufficient USDT balance on Binance',
          );
        }
      } catch (error) {
        logger.warn(
          {
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to check reverse arbitrage direction (Binance->GalaSwap)',
        );
      }

      const arbitrageOpportunity = bestOpportunity;

      // Only execute if profit is positive and meets minimum threshold
      // This ensures we NEVER execute trades with 0 or negative profit
      if (arbitrageOpportunity && arbitrageOpportunity.netProfit > 0 && arbitrageOpportunity.netProfit >= this.MIN_PROFIT_GALA) {
        logger.info(
          {
            netProfit: arbitrageOpportunity.netProfit,
            galaAmount: arbitrageOpportunity.tradeAmount,
            receivingTokenAmount: arbitrageOpportunity.receivingTokenAmount,
            galaBuyableOnBinance: arbitrageOpportunity.galaBuyableOnBinance,
            fees: arbitrageOpportunity.totalFees,
            pair: arbitrageOpportunity.pair,
          },
          'Arbitrage opportunity found! Executing trades...',
        );

        await reporter.sendAlert(
          `🚀 Arbitrage Opportunity: ${arbitrageOpportunity.netProfit.toFixed(2)} GALA profit (${arbitrageOpportunity.tradeAmount} GALA trade)`,
        );

        // Execute arbitrage trades
        await this.executeArbitrage(
          logger,
          options.binanceApi,
          options.binanceTrading,
          options.galaChainRouter,
          arbitrageOpportunity,
          arbitrageOpportunity.tradeAmount,
        );
      } else if (arbitrageOpportunity) {
        logger.info(
          {
            netProfit: arbitrageOpportunity.netProfit.toFixed(4),
            minRequired: this.MIN_PROFIT_GALA,
            galaAmount: arbitrageOpportunity.tradeAmount,
            note: arbitrageOpportunity.netProfit <= 0 
              ? 'Trade would result in LOSS - not executing' 
              : 'Profit below minimum threshold',
          },
          'Arbitrage opportunity found but not profitable enough',
        );
      } else {
        // Log summary of all opportunities checked
        if (allOpportunities.length > 0) {
          const bestUnprofitable = allOpportunities.reduce((best, opp) => 
            opp.netProfit > best.netProfit ? opp : best
          );
          
          logger.info(
            {
              opportunitiesChecked: allOpportunities.length,
              bestOpportunity: {
                tradeSize: bestUnprofitable.tradeSize,
                netProfit: bestUnprofitable.netProfit.toFixed(4),
                pair: bestUnprofitable.pair,
                direction: bestUnprofitable.direction,
              },
              minRequiredProfit: this.MIN_PROFIT_GALA,
              note: 'All opportunities are unprofitable (would result in losses). Bot is correctly protecting funds by not executing.',
            },
            'Arbitrage check complete: No profitable opportunities found',
          );
        } else {
          logger.info(
            {
              checkedSizes: validSizes,
              availableBalance: availableGala.toString(),
              note: 'No arbitrage opportunities found (likely due to liquidity issues or price parity)',
            },
            'No arbitrage opportunities found across all trade sizes',
          );
        }
      }
    } catch (error) {
      logger.error(
        {
          error,
        },
        'Failed to check arbitrage opportunity',
      );
    }

    return {
      swapsToTerminate: [],
      swapsToAccept: [],
      swapsToCreate: [],
    };
  }

  /**
   * Check for arbitrage opportunity between GalaSwap and Binance
   * @param receivingToken - Token to receive on GalaSwap (GWETH, GUSDC, or GUSDT)
   * @param binanceSymbol - Binance symbol to use (GALAETH, GALAUSDT)
   * @param quoteCurrency - Quote currency for price conversion (ETHUSDT, USDT)
   */
  private async checkArbitrageOpportunity(
    logger: ILogger,
    binanceApi: IBinanceApi,
    galaChainRouter: GalaChainRouter,
    galaAmount: number,
    galaToken: string = 'GALA',
    receivingToken: string = 'GWETH',
    _binanceSymbol: string = 'GALAETH', // Parameter kept for future use but not currently needed
    quoteCurrency: string = 'ETHUSDT',
  ): Promise<{
    receivingTokenAmount: number;
    galaBuyableOnBinance: number;
    totalFees: number;
    netProfit: number;
    pair: string;
  } | null> {
    try {
      // Step 1: Get GalaSwap quote - How much receivingToken do we get for GALA?
      const galaTokenKey = {
        collection: galaToken,
        category: 'Unit',
        type: 'none',
        additionalKey: 'none',
      };
      const receivingTokenKey = {
        collection: receivingToken,
        category: 'Unit',
        type: 'none',
        additionalKey: 'none',
      };
      
      logger.info(
        {
          tokenIn: `${galaToken}|Unit|none|none`,
          tokenOut: `${receivingToken}|Unit|none|none`,
          amountIn: galaAmount,
          pair: `${galaToken}/${receivingToken}`,
        },
        `Getting GalaSwap quote for ${galaToken} -> ${receivingToken}`,
      );

      let galaSwapQuote;
      try {
        galaSwapQuote = await galaChainRouter.getQuote(
          galaTokenKey,
          receivingTokenKey,
          String(galaAmount),
        );
      } catch (error: any) {
        // Handle CONFLICT errors - distinguish between different types
        if (error?.code === 409 || error?.key === 'CONFLICT') {
          const errorMessage = error.message || error.key || 'Unknown CONFLICT error';
          const isLiquidityIssue = errorMessage.toLowerCase().includes('liquidity') || 
                                   errorMessage.toLowerCase().includes('not enough');
          
          if (isLiquidityIssue) {
            logger.warn(
              {
                galaAmount,
                pair: `${galaToken}/${receivingToken}`,
                error: errorMessage,
                note: receivingToken === 'GWETH' 
                  ? 'GWETH pool has very low liquidity - this is expected. Try smaller amounts or use alternative pairs (GUSDC/GUSDT).'
                  : 'Pool has insufficient liquidity for this trade size',
              },
              'GalaSwap quote failed: insufficient liquidity in pool',
            );
          } else {
            logger.warn(
              {
                galaAmount,
                pair: `${galaToken}/${receivingToken}`,
                error: errorMessage,
              },
              'GalaSwap quote failed with CONFLICT - amount may be too small',
            );
          }
        } else {
          logger.error(
            {
              galaAmount,
              error,
            },
            'Failed to get GalaSwap quote',
          );
        }
        return null;
      }

      if (!galaSwapQuote) {
        logger.warn('Failed to get GalaSwap quote (null response)');
        return null;
      }

      const receivingTokenAmount = Number(galaSwapQuote.amountOut);
      logger.info(
        {
          galaAmount,
          receivingTokenAmount,
          receivingToken,
        },
        'GalaSwap quote received',
      );

      // Step 2: Get Binance prices
      // For GWETH: we need ETH/USDT and GALA/USDT prices
      // For GUSDC/GUSDT: we only need GALA/USDT price (stablecoins are 1:1 with USDT, so price = 1.0)
      const isStablecoin = receivingToken === 'GUSDC' || receivingToken === 'GUSDT';
      
      let quotePriceUsdt: number;
      if (isStablecoin) {
        // Stablecoins are 1:1 with USDT, no need to fetch price
        quotePriceUsdt = 1.0;
      } else {
        // For GWETH, fetch ETH/USDT price
        const quotePriceResponse = await binanceApi.getPrice(quoteCurrency);
        if (!quotePriceResponse) {
          logger.warn(
            {
              quoteCurrency,
            },
            'Failed to get Binance quote price',
          );
          return null;
        }
        quotePriceUsdt = Number(quotePriceResponse.price);
      }

      // Always need GALA/USDT price
      const galaPriceResponse = await binanceApi.getPrice('GALAUSDT');
      if (!galaPriceResponse) {
        logger.warn(
          {
            missingPrice: 'GALAUSDT',
          },
          'Failed to get Binance GALA price',
        );
        return null;
      }

      const galaPriceUsdt = Number(galaPriceResponse.price);

      logger.info(
        {
          quoteCurrency,
          quotePriceUsdt,
          galaPriceUsdt,
        },
        'Binance prices retrieved',
      );

      // Step 3: Calculate how much GALA we can buy on Binance
      // For GWETH: receivingTokenAmount * ethPriceUsdt = USDT value, then / galaPriceUsdt
      // For GUSDC/GUSDT: receivingTokenAmount = USDT value (1:1), then / galaPriceUsdt
      let usdtValue: number;
      if (receivingToken === 'GWETH') {
        // GWETH is 1:1 with ETH
        usdtValue = receivingTokenAmount * quotePriceUsdt;
      } else {
        // GUSDC/GUSDT are 1:1 with USDT
        usdtValue = receivingTokenAmount;
      }
      const galaBuyableOnBinance = usdtValue / galaPriceUsdt;

      logger.info(
        {
          receivingTokenAmount,
          receivingToken,
          usdtValue,
          galaBuyableOnBinance,
        },
        'Calculated GALA buyable on Binance',
      );

      // Step 4: Calculate fees
      // GalaSwap fee: 0.3% of GALA amount
      const galaSwapFee = galaAmount * this.GALA_SWAP_FEE_RATE;
      
      // Binance trading fee: 0.1% of trade value
      const binanceFee = galaBuyableOnBinance * this.BINANCE_FEE_RATE;
      
      // Gas fee (fixed estimate)
      const gasFee = this.GAS_FEE_GALA;
      
      const totalFees = galaSwapFee + binanceFee + gasFee;

      // Step 5: Calculate net profit
      // Net profit = (GALA received on Binance) - (GALA sold on GalaSwap) - (All Fees)
      const netProfit = galaBuyableOnBinance - galaAmount - totalFees;

        logger.info(
          {
            galaSold: galaAmount,
            galaReceived: galaBuyableOnBinance,
            galaSwapFee,
            binanceFee,
            gasFee,
            totalFees,
            netProfit,
          },
          'Arbitrage calculation complete',
        );

      return {
        receivingTokenAmount,
        galaBuyableOnBinance,
        totalFees,
        netProfit,
        pair: `${galaToken}/${receivingToken}`,
      };
    } catch (error) {
      logger.error(
        {
          error,
        },
        'Error checking arbitrage opportunity',
      );
      return null;
    }
  }

  /**
   * Check reverse arbitrage opportunity: Buy GALA on Binance, sell on GalaSwap
   * This is profitable when GALA is cheaper on Binance than on GalaSwap
   */
  private async checkReverseArbitrageOpportunity(
    logger: ILogger,
    binanceApi: IBinanceApi,
    galaChainRouter: GalaChainRouter,
    galaAmount: number,
    usdtNeeded: number,
  ): Promise<{
    receivingTokenAmount: number;
    galaBuyableOnBinance: number;
    totalFees: number;
    netProfit: number;
    pair: string;
  } | null> {
    try {
      // Step 1: Get GALA price on Binance
      const galaPriceResponse = await binanceApi.getPrice('GALAUSDT');
      if (!galaPriceResponse) {
        return null;
      }
      const galaPriceUsdt = Number(galaPriceResponse.price);

      // Step 2: Calculate cost to buy GALA on Binance (including fees)
      const binanceBuyFee = galaAmount * this.BINANCE_FEE_RATE;
      const totalCostUsdt = usdtNeeded + binanceBuyFee;

      // Step 3: Get quote from GalaSwap: How much token do we get for selling GALA?
      // Try GALA -> GUSDC first (most liquid)
      const galaTokenKey = {
        collection: 'GALA',
        category: 'Unit',
        type: 'none',
        additionalKey: 'none',
      };
      
      const receivingTokenKey = {
        collection: 'GUSDC',
        category: 'Unit',
        type: 'none',
        additionalKey: 'none',
      };

      let galaSwapQuote;
      try {
        galaSwapQuote = await galaChainRouter.getQuote(
          galaTokenKey,
          receivingTokenKey,
          String(galaAmount),
        );
      } catch (error: any) {
        logger.debug(
          {
            galaAmount,
            error: error?.message || error?.key,
          },
          'Failed to get GalaSwap quote for reverse arbitrage',
        );
        return null;
      }

      if (!galaSwapQuote) {
        return null;
      }

      const receivingTokenAmount = Number(galaSwapQuote.amountOut);
      // GUSDC is 1:1 with USDT, so this is the USDT value we get
      const usdtReceived = receivingTokenAmount;

      // Step 4: Calculate fees
      const galaSwapFee = galaAmount * this.GALA_SWAP_FEE_RATE;
      const gasFee = this.GAS_FEE_GALA;
      const totalFees = binanceBuyFee + galaSwapFee + gasFee;

      // Step 5: Calculate net profit
      // Net profit = (USDT received from GalaSwap) - (USDT spent on Binance) - (All Fees)
      const netProfit = usdtReceived - totalCostUsdt - totalFees;
      
      // Convert profit to GALA for consistency
      const netProfitGala = netProfit / galaPriceUsdt;

      logger.info(
        {
          direction: 'Binance->GalaSwap',
          galaBought: galaAmount,
          usdtSpent: totalCostUsdt.toFixed(4),
          usdtReceived: usdtReceived.toFixed(4),
          receivingToken: 'GUSDC',
          receivingTokenAmount: receivingTokenAmount.toFixed(4),
          binanceFee: binanceBuyFee.toFixed(4),
          galaSwapFee: galaSwapFee.toFixed(4),
          gasFee,
          totalFees: totalFees.toFixed(4),
          netProfitUsdt: netProfit.toFixed(4),
          netProfitGala: netProfitGala.toFixed(4),
        },
        'Reverse arbitrage calculation complete',
      );

      return {
        receivingTokenAmount,
        galaBuyableOnBinance: galaAmount, // We bought this amount
        totalFees,
        netProfit: netProfitGala, // Return profit in GALA for consistency
        pair: 'GALA/GUSDC',
      };
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        'Error checking reverse arbitrage opportunity',
      );
      return null;
    }
  }

  /**
   * Execute arbitrage trades simultaneously
   */
  private async executeArbitrage(
    logger: ILogger,
    binanceApi: IBinanceApi,
    binanceTrading: BinanceTrading,
    galaChainRouter: GalaChainRouter,
    opportunity: {
      receivingTokenAmount: number;
      galaBuyableOnBinance: number;
      totalFees: number;
      netProfit: number;
      pair: string;
    },
    galaAmount: number,
  ): Promise<void> {
    try {
      logger.info(
        {
          netProfit: opportunity.netProfit,
        },
        'Starting arbitrage execution',
      );

      // Step 1: Execute GalaSwap trade (Sell GALA for receiving token)
      // Parse the pair to determine receiving token
      const pairParts = opportunity.pair.split('/');
      const receivingToken = pairParts[1] || 'GWETH'; // e.g., 'GWETH', 'GUSDC', 'GUSDT' (default to GWETH if parsing fails)
      
      logger.info(
        {
          tokenIn: 'GALA|Unit|none|none',
          tokenOut: `${receivingToken}|Unit|none|none`,
          amountIn: galaAmount,
          pair: opportunity.pair,
        },
        `Executing GalaSwap trade: Selling GALA for ${receivingToken}`,
      );

      const galaSwapResult = await galaChainRouter.requestSwap({
        offered: [
          {
            quantity: String(galaAmount),
            tokenInstance: {
              collection: 'GALA',
              category: 'Unit',
              type: 'none',
              additionalKey: 'none',
            },
          },
        ],
        wanted: [
          {
            quantity: String(opportunity.receivingTokenAmount),
            tokenInstance: {
              collection: receivingToken,
              category: 'Unit',
              type: 'none',
              additionalKey: 'none',
            },
          },
        ],
      });

      logger.info(
        {
          transactionId: galaSwapResult.transactionId,
          status: galaSwapResult.status,
        },
        'GalaSwap trade executed',
      );

      // Step 2: Execute Binance trade (Buy GALA)
      // For GWETH: Use GALAETH pair
      // For GUSDC/GUSDT: Use GALAUSDT pair
      
      if (receivingToken === 'GWETH') {
        // Try GALAETH pair first (if available)
        try {
          const galaEthPrice = await binanceApi.getPrice('GALAETH');
          if (galaEthPrice) {
            // GALAETH pair exists - calculate how much GALA we can buy with the ETH
            const ethAmount = opportunity.receivingTokenAmount; // GWETH is 1:1 with ETH
          const galaEthPriceValue = Number(galaEthPrice.price);
          
          // For GALAETH pair, buying GALA with ETH means:
          // amountInETH / price = amountOutGALA
          const galaAmountToBuy = ethAmount / galaEthPriceValue;

          logger.info(
            {
              symbol: 'GALAETH',
              side: 'BUY',
              ethAmount,
              galaAmount: galaAmountToBuy,
              price: galaEthPriceValue,
            },
            'Executing Binance trade: Buying GALA with ETH (GALAETH pair)',
          );

          // For GALAETH pair, market BUY uses quoteOrderQty (amount in ETH)
          await binanceTrading.executeTrade({
            symbol: 'GALAETH',
            side: 'BUY',
            type: 'MARKET',
            quantity: String(ethAmount), // Amount in ETH (quote currency)
          });

          logger.info(
            {
              netProfit: opportunity.netProfit,
              galaReceived: galaAmountToBuy,
            },
            'Arbitrage execution complete!',
          );
          return;
        }
      } catch (error) {
        logger.debug(
          {
            error,
          },
          'GALAETH pair not available, trying alternative method',
        );
      }

        // Alternative: Use GALAUSDT pair (two-step: ETH -> USDT -> GALA)
        // This is more complex and has more fees, so we'll skip for now
        logger.warn(
          {
            receivingToken,
            receivingTokenAmount: opportunity.receivingTokenAmount,
          },
          'GALAETH pair not available. Alternative trading method not implemented.',
        );
      } else if (receivingToken === 'GUSDC' || receivingToken === 'GUSDT') {
        // For stablecoins, use GALAUSDT pair directly
        // The receivingTokenAmount is already in USDT (1:1)
        const usdtAmount = opportunity.receivingTokenAmount;
        
        logger.info(
          {
            symbol: 'GALAUSDT',
            side: 'BUY',
            usdtAmount,
            expectedGala: opportunity.galaBuyableOnBinance,
          },
          'Executing Binance trade: Buying GALA with USDT (GALAUSDT pair)',
        );

        // For GALAUSDT pair, market BUY uses quoteOrderQty (amount in USDT)
        // The executeTrade function will automatically convert quantity to quoteOrderQty for market BUY
        if (!binanceTrading) {
          throw new Error('BinanceTrading is not available - cannot execute Binance trade');
        }
        
        await binanceTrading.executeTrade({
          symbol: 'GALAUSDT',
          side: 'BUY',
          type: 'MARKET',
          quantity: String(usdtAmount), // Amount in USDT (quote currency) - will be converted to quoteOrderQty
        });

        logger.info(
          {
            netProfit: opportunity.netProfit,
            galaReceived: opportunity.galaBuyableOnBinance,
            pair: opportunity.pair,
          },
          'Arbitrage execution complete!',
        );
      } else {
        logger.warn(
          {
            receivingToken,
            pair: opportunity.pair,
          },
          'Unknown receiving token - cannot execute Binance trade',
        );
      }
    } catch (error: any) {
      logger.error(
        {
          error: error?.message || error?.toString() || error,
          errorStack: error?.stack,
          errorType: error?.constructor?.name,
          opportunity,
        },
        'Failed to execute arbitrage trades',
      );
      throw error;
    }
  }
}

