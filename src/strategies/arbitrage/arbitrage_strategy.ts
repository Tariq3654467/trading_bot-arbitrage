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
  private readonly ALLOW_LOSS_TRADES: boolean = false; // Only execute trades when profitable
  // Binance fees: Market orders = 0.1%, Limit maker orders = 0.02% (80% savings!)
  private readonly BINANCE_MARKET_FEE_RATE: number = 0.001; // 0.1% for market orders (current)
  private readonly BINANCE_MAKER_FEE_RATE: number = 0.0002; // 0.02% for limit maker orders (future optimization)
  // GalaSwap fees: Use actual fee tier from quote (0.05%, 0.30%, or 1.00%)
  // Fee tiers: 500 = 0.05% (stable pairs), 3000 = 0.30% (most pairs), 10000 = 1.00% (volatile pairs)
  private readonly GAS_FEE_GALA: number = 0.5; // Optimized gas estimate (actual is typically 0.1-0.5 GALA)
  private readonly MIN_GALA_AMOUNT: number = 500; // Minimum amount to attempt (reduced to allow smaller balances)
  // Try different trade sizes to find profitable opportunities (smaller sizes = less slippage)
  private readonly TRADE_SIZE_OPTIONS: number[] = [500, 1000, 2000, 3000, 4000, 5000]; // Try smaller sizes first (added 500)
  
  // Alternative pairs to try if GALA/GWETH has insufficient liquidity
  private readonly ALTERNATIVE_PAIRS = [
    { galaToken: 'GALA', receivingToken: 'GUSDC', binanceSymbol: 'GALAUSDT', description: 'GALA/GUSDC → GALA/USDT' },
    { galaToken: 'GALA', receivingToken: 'GUSDT', binanceSymbol: 'GALAUSDT', description: 'GALA/GUSDT → GALA/USDT' },
  ];
  
  private lastArbitrageCheck: number = 0;
  private readonly ARBITRAGE_CHECK_INTERVAL: number = 60000; // Check every 60 seconds
  private gwethFailureCount: number = 0; // Track consecutive GWETH failures
  private readonly GWETH_MAX_FAILURES: number = 3; // Skip GWETH after 3 consecutive failures
  private gwethLastFailureTime: number = 0;
  private readonly GWETH_RETRY_INTERVAL: number = 300000; // Retry GWETH after 5 minutes

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
      const timeUntilNextCheck = this.ARBITRAGE_CHECK_INTERVAL - (now - this.lastArbitrageCheck);
      logger.debug(
        {
          timeUntilNextCheck: Math.round(timeUntilNextCheck / 1000),
          interval: this.ARBITRAGE_CHECK_INTERVAL / 1000,
        },
        'Arbitrage strategy: rate limited (waiting for next check interval)',
      );
      return {
        swapsToTerminate: [],
        swapsToAccept: [],
        swapsToCreate: [],
      };
    }
    
    this.lastArbitrageCheck = now;

    // Check if required dependencies are available
    if (!options.binanceApi || !options.binanceTrading || !options.galaChainRouter) {
      logger.warn(
        {
          hasBinanceApi: !!options.binanceApi,
          hasBinanceTrading: !!options.binanceTrading,
          hasGalaChainRouter: !!options.galaChainRouter,
        },
        'Arbitrage strategy: missing required dependencies - skipping check',
      );
      return {
        swapsToTerminate: [],
        swapsToAccept: [],
        swapsToCreate: [],
      };
    }
    
    logger.info('Arbitrage strategy: starting opportunity check');

    // Check if we have enough GALA balance
    const galaBalance = ownBalances.find((b) => b.collection === 'GALA');
    const availableGala = galaBalance ? BigNumber(galaBalance.quantity) : BigNumber(0);
    
    // Use available balance, but ensure it meets minimum requirements
    const tradeAmount = BigNumber.min(availableGala, BigNumber(this.GALA_AMOUNT)).toNumber();
    
    if (!galaBalance || availableGala.isLessThan(this.MIN_GALA_AMOUNT)) {
      logger.warn(
        {
          availableBalance: availableGala.toString(),
          minRequired: this.MIN_GALA_AMOUNT,
          configuredAmount: this.GALA_AMOUNT,
        },
        'Arbitrage strategy: insufficient GALA balance (below minimum) - skipping check',
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

      // Check if we should skip GWETH due to recent failures (circuit breaker)
      const now = Date.now();
      const shouldSkipGweth = this.gwethFailureCount >= this.GWETH_MAX_FAILURES && 
                              (now - this.gwethLastFailureTime) < this.GWETH_RETRY_INTERVAL;
      
      if (shouldSkipGweth) {
        logger.info(
          {
            failureCount: this.gwethFailureCount,
            lastFailureTime: new Date(this.gwethLastFailureTime).toISOString(),
            retryAfter: new Date(this.gwethLastFailureTime + this.GWETH_RETRY_INTERVAL).toISOString(),
            note: 'GWETH pool has insufficient liquidity. Skipping GWETH checks temporarily.',
          },
          'Arbitrage: Skipping GWETH checks (circuit breaker active)',
        );
      }

      logger.info(
        {
          validSizes: validSizes,
          totalSizes: validSizes.length,
          availableBalance: availableGala.toString(),
        },
        'Arbitrage: Checking opportunities with multiple trade sizes',
      );

      // Try each trade size to find the most profitable opportunity
      for (const tradeSize of validSizes) {
        logger.info(
          {
            tradeSize,
            availableBalance: availableGala.toString(),
          },
          'Arbitrage: Checking opportunity with trade size',
        );

        // Try GALA/GWETH first (primary pair) - but only if circuit breaker is not active
        let arbitrageOpportunity: ReturnType<typeof this.checkArbitrageOpportunity> extends Promise<infer T> ? T : null = null;
        
        if (!shouldSkipGweth) {
          // Try GWETH with the main trade size first
          arbitrageOpportunity = await this.checkArbitrageOpportunity(
            logger,
            options.binanceApi,
            options.galaChainRouter,
            tradeSize,
            'GALA',
            'GWETH',
            'GALAETH',
            'ETHUSDT',
          );

          // If GWETH fails due to CONFLICT (liquidity), increment failure counter
          // Note: We check if the opportunity is null, which means it failed
          // A successful quote (even if unprofitable) means the pool has liquidity
          if (!arbitrageOpportunity) {
            this.gwethFailureCount++;
            this.gwethLastFailureTime = now;
            if (this.gwethFailureCount >= this.GWETH_MAX_FAILURES) {
              logger.warn(
                {
                  failureCount: this.gwethFailureCount,
                  maxFailures: this.GWETH_MAX_FAILURES,
                  retryAfter: new Date(now + this.GWETH_RETRY_INTERVAL).toISOString(),
                  note: 'GWETH pool has insufficient liquidity. Will skip GWETH checks for 5 minutes.',
                },
                'GWETH circuit breaker activated - skipping GWETH checks',
              );
            } else {
              logger.info(
                {
                  failureCount: this.gwethFailureCount,
                  maxFailures: this.GWETH_MAX_FAILURES,
                  tradeSize,
                },
                'Arbitrage: GWETH check failed (liquidity issue)',
              );
            }
          } else {
            // Reset failure counter on success (even if unprofitable, getting a quote means liquidity exists)
            if (this.gwethFailureCount > 0) {
              logger.info(
                {
                  previousFailures: this.gwethFailureCount,
                  note: 'GWETH pool now has liquidity - resetting failure counter',
                },
                'GWETH arbitrage check succeeded (circuit breaker reset)',
              );
            }
            this.gwethFailureCount = 0;
          }
        }

        // If GALA/GWETH still fails due to liquidity, try alternative pairs
        if (!arbitrageOpportunity) {
          logger.info(
            {
              tradeSize,
              note: 'GALA/GWETH pair unavailable, trying alternative pairs',
            },
            'Arbitrage: Trying alternative pairs',
          );
          for (const pair of this.ALTERNATIVE_PAIRS) {
            logger.info(
              {
                pair: pair.description,
                tradeSize,
              },
              'Arbitrage: Checking alternative pair',
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
                  netProfit: arbitrageOpportunity.netProfit.toFixed(4),
                  tradeSize,
                  isProfitable: arbitrageOpportunity.netProfit > 0,
                },
                'Arbitrage: Found opportunity with alternative pair',
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

        // If we found an opportunity (profitable or loss if allowed), compare it with the best one so far
        if (arbitrageOpportunity) {
          const isProfitable = arbitrageOpportunity.netProfit > 0;
          const isLossButAllowed = this.ALLOW_LOSS_TRADES && arbitrageOpportunity.netProfit <= 0;
          
          if (isProfitable || isLossButAllowed) {
            // For profitable trades, pick the most profitable
            // For loss trades, pick the one with smallest loss (least negative)
            const isBetter = !bestOpportunity || 
              (isProfitable && arbitrageOpportunity.netProfit > bestOpportunity.netProfit) ||
              (isLossButAllowed && bestOpportunity.netProfit <= 0 && arbitrageOpportunity.netProfit > bestOpportunity.netProfit);
            
            if (isBetter) {
              bestOpportunity = {
                ...arbitrageOpportunity,
                tradeAmount: tradeSize,
                direction: 'GalaSwap->Binance',
              };
              if (isProfitable) {
                logger.info(
                  {
                    tradeSize,
                    netProfit: arbitrageOpportunity.netProfit,
                    pair: arbitrageOpportunity.pair,
                    direction: 'GalaSwap->Binance',
                  },
                  'Found profitable arbitrage opportunity',
                );
              } else {
                logger.warn(
                  {
                    tradeSize,
                    netProfit: arbitrageOpportunity.netProfit,
                    pair: arbitrageOpportunity.pair,
                    direction: 'GalaSwap->Binance',
                    note: 'Loss trade selected (ALLOW_LOSS_TRADES enabled)',
                  },
                  '⚠️ Found loss arbitrage opportunity (will execute)',
                );
              }
            }
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
          logger.info(
            {
              availableUsdt: availableUsdt.toFixed(2),
            },
            'Arbitrage: Checking reverse direction (Binance->GalaSwap)',
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

              const isProfitable = reverseOpportunity.netProfit > 0;
              const isLossButAllowed = this.ALLOW_LOSS_TRADES && reverseOpportunity.netProfit <= 0;
              
              if (isProfitable || isLossButAllowed) {
                const isBetter = !bestOpportunity || 
                  (isProfitable && reverseOpportunity.netProfit > bestOpportunity.netProfit) ||
                  (isLossButAllowed && bestOpportunity.netProfit <= 0 && reverseOpportunity.netProfit > bestOpportunity.netProfit);
                
                if (isBetter) {
                  bestOpportunity = {
                    ...reverseOpportunity,
                    tradeAmount: tradeSize,
                    direction: 'Binance->GalaSwap',
                  };
                  if (isProfitable) {
                    logger.info(
                      {
                        tradeSize,
                        netProfit: reverseOpportunity.netProfit,
                        pair: reverseOpportunity.pair,
                        direction: 'Binance->GalaSwap',
                      },
                      'Found profitable reverse arbitrage opportunity',
                    );
                  } else {
                    logger.warn(
                      {
                        tradeSize,
                        netProfit: reverseOpportunity.netProfit,
                        pair: reverseOpportunity.pair,
                        direction: 'Binance->GalaSwap',
                        note: 'Loss trade selected (ALLOW_LOSS_TRADES enabled)',
                      },
                      '⚠️ Found loss reverse arbitrage opportunity (will execute)',
                    );
                  }
                }
              }
            }
          }
        } else {
          logger.info(
            {
              availableUsdt: availableUsdt.toFixed(2),
              minRequired: 10,
            },
            'Arbitrage: Skipping reverse direction (insufficient USDT on Binance)',
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

      // Execute if we have an opportunity and either:
      // 1. It's profitable and meets minimum threshold, OR
      // 2. ALLOW_LOSS_TRADES is true (execute even at loss)
      const isProfitable = arbitrageOpportunity && arbitrageOpportunity.netProfit > 0 && arbitrageOpportunity.netProfit >= this.MIN_PROFIT_GALA;
      const shouldExecuteLoss = this.ALLOW_LOSS_TRADES && arbitrageOpportunity && arbitrageOpportunity.netProfit <= 0;
      
      if (isProfitable || shouldExecuteLoss) {
        const isLoss = arbitrageOpportunity!.netProfit <= 0;
        
        if (isLoss) {
          logger.warn(
            {
              netProfit: arbitrageOpportunity!.netProfit.toFixed(4),
              galaAmount: arbitrageOpportunity!.tradeAmount,
              receivingTokenAmount: arbitrageOpportunity!.receivingTokenAmount,
              galaBuyableOnBinance: arbitrageOpportunity!.galaBuyableOnBinance,
              fees: arbitrageOpportunity!.totalFees,
              pair: arbitrageOpportunity!.pair,
              warning: '⚠️ EXECUTING TRADE AT A LOSS (ALLOW_LOSS_TRADES enabled)',
            },
            '⚠️ Arbitrage opportunity found but will result in LOSS - executing anyway',
          );

          await reporter.sendAlert(
            `⚠️ Arbitrage Trade (LOSS): ${arbitrageOpportunity!.netProfit.toFixed(2)} GALA loss (${arbitrageOpportunity!.tradeAmount} GALA trade)`,
          );
        } else {
          logger.info(
            {
              netProfit: arbitrageOpportunity!.netProfit,
              galaAmount: arbitrageOpportunity!.tradeAmount,
              receivingTokenAmount: arbitrageOpportunity!.receivingTokenAmount,
              galaBuyableOnBinance: arbitrageOpportunity!.galaBuyableOnBinance,
              fees: arbitrageOpportunity!.totalFees,
              pair: arbitrageOpportunity!.pair,
            },
            'Arbitrage opportunity found! Executing trades...',
          );

          await reporter.sendAlert(
            `🚀 Arbitrage Opportunity: ${arbitrageOpportunity!.netProfit.toFixed(2)} GALA profit (${arbitrageOpportunity!.tradeAmount} GALA trade)`,
          );
        }

        // Execute arbitrage trades on both platforms (even if at a loss)
        await this.executeArbitrage(
          logger,
          options.binanceApi,
          options.binanceTrading,
          options.galaChainRouter,
          arbitrageOpportunity!,
          arbitrageOpportunity!.tradeAmount,
          arbitrageOpportunity!.direction || 'GalaSwap->Binance',
        );
      } else if (bestOpportunity) {
        logger.info(
          {
            netProfit: bestOpportunity.netProfit.toFixed(4),
            minRequired: this.MIN_PROFIT_GALA,
            galaAmount: bestOpportunity.tradeAmount,
            allowLossTrades: this.ALLOW_LOSS_TRADES,
            note: bestOpportunity.netProfit <= 0 
              ? (this.ALLOW_LOSS_TRADES 
                  ? 'Trade would result in LOSS but ALLOW_LOSS_TRADES is enabled - should execute but opportunity not selected'
                  : 'Trade would result in LOSS - not executing (ALLOW_LOSS_TRADES disabled)')
              : 'Profit below minimum threshold',
          },
          'Arbitrage: Opportunity found but not executing',
        );
      } else if (arbitrageOpportunity) {
        logger.info(
          {
            netProfit: arbitrageOpportunity.netProfit.toFixed(4),
            minRequired: this.MIN_PROFIT_GALA,
            galaAmount: arbitrageOpportunity.tradeAmount,
            allowLossTrades: this.ALLOW_LOSS_TRADES,
            note: arbitrageOpportunity.netProfit <= 0 
              ? (this.ALLOW_LOSS_TRADES 
                  ? 'Trade would result in LOSS but ALLOW_LOSS_TRADES is enabled - should execute but opportunity not selected'
                  : 'Trade would result in LOSS - not executing (ALLOW_LOSS_TRADES disabled)')
              : 'Profit below minimum threshold',
          },
          'Arbitrage: Opportunity found but not executing',
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
                netProfit: `${bestUnprofitable.netProfit.toFixed(4)} GALA`,
                pair: bestUnprofitable.pair,
                direction: bestUnprofitable.direction,
                status: bestUnprofitable.netProfit > 0 ? 'Profitable but below minimum' : 'UNPROFITABLE (would lose money)',
              },
              minRequiredProfit: `${this.MIN_PROFIT_GALA} GALA`,
              gwethStatus: shouldSkipGweth 
                ? `Skipped (circuit breaker: ${this.gwethFailureCount} failures)` 
                : 'Checked',
              note: 'All opportunities are unprofitable. Bot is correctly protecting funds by NOT executing losing trades.',
            },
            'Arbitrage: Check complete - No profitable opportunities found',
          );
        } else {
          logger.info(
            {
              checkedSizes: validSizes,
              availableBalance: availableGala.toString(),
              gwethStatus: shouldSkipGweth 
                ? `Skipped (circuit breaker: ${this.gwethFailureCount} failures)` 
                : 'Checked',
              note: 'No arbitrage opportunities found (likely due to liquidity issues or price parity)',
            },
            'Arbitrage: No opportunities found across all trade sizes',
          );
        }
      }
      
      // Always log a summary at the end of each check
      logger.info(
        {
          totalOpportunitiesChecked: allOpportunities.length,
          profitableOpportunities: allOpportunities.filter(o => o.netProfit > 0 && o.netProfit >= this.MIN_PROFIT_GALA).length,
          unprofitableOpportunities: allOpportunities.filter(o => o.netProfit <= 0).length,
          tradeSizesChecked: validSizes.length,
          nextCheckIn: `${Math.round(this.ARBITRAGE_CHECK_INTERVAL / 1000)}s`,
        },
        'Arbitrage: Check cycle complete',
      );
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
      // Get actual fee tier from quote
      // IMPORTANT: The fee is already deducted from amountOut in the quote!
      // We don't need to calculate it separately - the quote already accounts for fees
      // Fee tier values from SDK: 500 = 0.05%, 3000 = 0.30%, 10000 = 1.00%
      // The SDK documentation says these are basis points, but the conversion shows:
      // - Standard basis points: 10000 bp = 100% (divide by 100)
      // - SDK format: 10000 = 1.00% (divide by 1000000, or treat as "hundredths of percent")
      // Actually, looking at getFeeTierPercentage: it uses / 10000, which gives 10000→1.0 (100%)
      // But the docs say 10000 = 1.00%, so there's a discrepancy
      // Let's use the helper function from fee_tiers.ts which uses / 10000
      const feeTier = galaSwapQuote.feeTier ? Number(galaSwapQuote.feeTier) : 3000; // Default to 0.30% if not provided
      
      // CRITICAL FIX: The fee tier values appear to be in a non-standard format
      // Based on logs showing 10000 → 100% fee, but docs say 1.00%
      // The actual conversion should be: feeTier / 1000000 for percentage
      // This gives: 500→0.0005 (0.05%), 3000→0.003 (0.30%), 10000→0.01 (1.00%)
      const actualGalaSwapFeeRate = feeTier / 1000000; // FIXED: Use / 1000000, not / 10000
      
      // Calculate the effective fee that was already deducted from the quote
      // This is for logging/reporting only - the fee is already in the quote
      // We estimate the fee by comparing what we'd get without fees vs what we got
      // But since we don't have the "without fees" amount, we'll use a small estimate
      // The actual fee impact is already reflected in the amountOut we received
      
      logger.info(
        {
          galaAmount,
          receivingTokenAmount,
          receivingToken,
          feeTier,
          actualFeeRate: `${(actualGalaSwapFeeRate * 100).toFixed(2)}%`,
        },
        'GalaSwap quote received with actual fee tier',
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

      // Step 4: Calculate fees (using actual rates to minimize)
      // IMPORTANT: GalaSwap fee is already deducted from the quote's amountOut!
      // The fee tier tells us what fee was applied, but we don't need to subtract it again
      // Instead, we estimate the fee cost for profit calculation purposes
      // The actual slippage/fee impact is already in the receivingTokenAmount
      
      // Estimate fee cost: This is approximate since the fee is already in the quote
      // For accurate calculation, we'd need the "before fees" amount, but we can estimate
      // Fee is typically applied to the input amount in DEX swaps
      const estimatedGalaSwapFee = galaAmount * actualGalaSwapFeeRate;
      
      // Binance trading fee: Use maker fee rate (0.02%) if we use limit orders, otherwise market fee (0.1%)
      // For now, we'll use market fee but note that limit orders would be cheaper
      // TODO: Consider using limit orders to get maker fees (0.02% instead of 0.1%)
      const binanceFee = galaBuyableOnBinance * this.BINANCE_MARKET_FEE_RATE;
      
      // Gas fee (optimized estimate)
      const gasFee = this.GAS_FEE_GALA;
      
      const totalFees = estimatedGalaSwapFee + binanceFee + gasFee;
      
      // Calculate potential savings if using limit orders
      const potentialMakerFee = galaBuyableOnBinance * this.BINANCE_MAKER_FEE_RATE;
      const feeSavings = binanceFee - potentialMakerFee;

      // Step 5: Calculate net profit
      // Net profit = (GALA received on Binance) - (GALA sold on GalaSwap) - (All Fees)
      const netProfit = galaBuyableOnBinance - galaAmount - totalFees;

        logger.info(
          {
            galaSold: galaAmount,
            galaReceived: galaBuyableOnBinance,
            fees: {
              galaSwapFee: estimatedGalaSwapFee.toFixed(4),
              galaSwapFeeRate: `${(actualGalaSwapFeeRate * 100).toFixed(2)}%`,
              note: 'GalaSwap fee already included in quote amountOut',
              binanceFee: binanceFee.toFixed(4),
              binanceFeeRate: `${(this.BINANCE_MARKET_FEE_RATE * 100).toFixed(2)}%`,
              gasFee: gasFee.toFixed(4),
              totalFees: totalFees.toFixed(4),
            },
            potentialSavings: feeSavings > 0 ? {
              usingLimitOrders: `Save ${feeSavings.toFixed(4)} GALA (${((feeSavings / totalFees) * 100).toFixed(1)}% fee reduction)`,
              note: 'Consider using limit orders to get 0.02% maker fee instead of 0.1% market fee',
            } : undefined,
            netProfit: netProfit.toFixed(4),
          },
          'Arbitrage calculation complete (fees minimized)',
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
      // Use market fee for now (could optimize with limit orders for maker fee)
      const binanceBuyFee = galaAmount * galaPriceUsdt * this.BINANCE_MARKET_FEE_RATE;
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

      // Step 4: Calculate fees (minimized)
      // Get actual fee tier from quote (GUSDC/GALA pair might use 0.05% fee tier)
      const feeTier = galaSwapQuote.feeTier ? Number(galaSwapQuote.feeTier) : 3000; // Default to 0.30% if not provided
      // CRITICAL FIX: Use / 1000000, not / 10000 (fee tier format is non-standard)
      const actualGalaSwapFeeRate = feeTier / 1000000; // Correct: 10000 / 1000000 = 0.01 = 1.00%
      const estimatedGalaSwapFee = galaAmount * actualGalaSwapFeeRate;
      const gasFee = this.GAS_FEE_GALA;
      const totalFees = binanceBuyFee + estimatedGalaSwapFee + gasFee;

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
          galaSwapFee: estimatedGalaSwapFee.toFixed(4),
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
   * Execute arbitrage trades on both platforms simultaneously
   * Direction: 'GalaSwap->Binance' or 'Binance->GalaSwap'
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
    direction: 'GalaSwap->Binance' | 'Binance->GalaSwap' = 'GalaSwap->Binance',
  ): Promise<void> {
    try {
      logger.info(
        {
          netProfit: opportunity.netProfit,
          direction,
          galaAmount,
          pair: opportunity.pair,
        },
        '🚀 Starting arbitrage execution on BOTH platforms',
      );

      if (direction === 'Binance->GalaSwap') {
        // Reverse direction: Buy GALA on Binance first, then sell on GalaSwap
        await this.executeReverseArbitrage(
          logger,
          binanceApi,
          binanceTrading,
          galaChainRouter,
          opportunity,
          galaAmount,
        );
        return;
      }

      // Forward direction: Sell GALA on GalaSwap first, then buy on Binance
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
          galaSold: galaAmount,
          receivingToken,
          receivingTokenAmount: opportunity.receivingTokenAmount,
        },
        '✅ GalaSwap trade executed successfully',
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
          await binanceTrading.executeTradeForArbitrage({
            symbol: 'GALAETH',
            side: 'BUY',
            type: 'MARKET',
            quantity: String(ethAmount), // Amount in ETH (quote currency)
          });

          logger.info(
            {
              netProfit: opportunity.netProfit,
              galaReceived: galaAmountToBuy,
              pair: opportunity.pair,
            },
            '✅ Forward arbitrage execution complete on BOTH platforms!',
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
        // The executeTradeForArbitrage function will automatically convert quantity to quoteOrderQty for market BUY
        if (!binanceTrading) {
          throw new Error('BinanceTrading is not available - cannot execute Binance trade');
        }
        
        await binanceTrading.executeTradeForArbitrage({
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
            usdtSpent: opportunity.receivingTokenAmount,
          },
          '✅ Forward arbitrage execution complete on BOTH platforms!',
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
          direction,
        },
        'Failed to execute arbitrage trades',
      );
      throw error;
    }
  }

  /**
   * Execute reverse arbitrage: Buy GALA on Binance, then sell on GalaSwap
   */
  private async executeReverseArbitrage(
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
          direction: 'Binance->GalaSwap',
          galaAmount,
          pair: opportunity.pair,
        },
        'Executing reverse arbitrage: Step 1 - Buying GALA on Binance',
      );

      // Step 1: Buy GALA on Binance with USDT
      const galaPriceResponse = await binanceApi.getPrice('GALAUSDT');
      if (!galaPriceResponse) {
        throw new Error('Failed to get GALA price from Binance');
      }
      
      const galaPriceUsdt = Number(galaPriceResponse.price);
      const usdtNeeded = galaAmount * galaPriceUsdt;

      if (!binanceTrading) {
        throw new Error('BinanceTrading is not available - cannot execute Binance trade');
      }

      logger.info(
        {
          symbol: 'GALAUSDT',
          side: 'BUY',
          usdtAmount: usdtNeeded.toFixed(4),
          galaAmount,
          price: galaPriceUsdt,
        },
        'Executing Binance BUY order',
      );

      const binanceOrder = await binanceTrading.executeTradeForArbitrage({
        symbol: 'GALAUSDT',
        side: 'BUY',
        type: 'MARKET',
        quantity: String(usdtNeeded), // Amount in USDT (quote currency)
      });

      logger.info(
        {
          orderId: binanceOrder.orderId,
          status: binanceOrder.status,
          executedQty: binanceOrder.executedQty,
          cummulativeQuoteQty: binanceOrder.cummulativeQuoteQty,
        },
        '✅ Binance trade executed successfully',
      );

      // Step 2: Sell GALA on GalaSwap for receiving token (GUSDC)
      const receivingToken = 'GUSDC'; // From reverse arbitrage check
      
      logger.info(
        {
          tokenIn: 'GALA|Unit|none|none',
          tokenOut: `${receivingToken}|Unit|none|none`,
          amountIn: galaAmount,
          expectedOut: opportunity.receivingTokenAmount,
        },
        'Executing reverse arbitrage: Step 2 - Selling GALA on GalaSwap',
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
          netProfit: opportunity.netProfit,
          receivingToken,
          receivingTokenAmount: opportunity.receivingTokenAmount,
        },
        '✅ Reverse arbitrage execution complete on BOTH platforms!',
      );
    } catch (error: any) {
      logger.error(
        {
          error: error?.message || error?.toString() || error,
          errorStack: error?.stack,
          errorType: error?.constructor?.name,
          opportunity,
          direction: 'Binance->GalaSwap',
        },
        '❌ Failed to execute reverse arbitrage trades',
      );
      throw error;
    }
  }
}

